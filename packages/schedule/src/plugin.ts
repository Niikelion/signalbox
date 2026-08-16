import { definePlugin, type NoEvents } from "@signalbox/core"
import { Cron } from "croner"

export interface ScheduleHandle {
    cancel: () => void
}

export interface CronOptions {
    timezone?: string
}

export interface ScheduleApi {
    at: (date: Date, fn: () => void | Promise<void>) => ScheduleHandle
    cron: (expression: string, options: CronOptions, fn: () => void | Promise<void>) => ScheduleHandle
    next: (expression: string, options?: CronOptions, from?: Date) => Date | null
}

export const schedulePlugin = () =>
    definePlugin<ScheduleApi, NoEvents>({
        name: "schedule",
        init: (ctx) => {
            const jobs = new Set<Cron>()

            const wrap = (fn: () => void | Promise<void>) => () => {
                void Promise.resolve()
                    .then(fn)
                    .catch((error: unknown) => {
                        ctx.fail(error)
                    })
            }

            const track = (job: Cron): ScheduleHandle => {
                jobs.add(job)
                return {
                    cancel: () => {
                        job.stop()
                        jobs.delete(job)
                    },
                }
            }

            ctx.onStop(() => {
                for (const job of jobs) job.stop()
                jobs.clear()
            })

            return {
                at: (date, fn) => track(new Cron(date, wrap(fn))),
                cron: (expression, options, fn) =>
                    track(new Cron(expression, { timezone: options.timezone }, wrap(fn))),
                next: (expression, options, from) => {
                    const job = new Cron(expression, { timezone: options?.timezone })
                    const run = job.nextRun(from)
                    job.stop()
                    return run
                },
            }
        },
    })
