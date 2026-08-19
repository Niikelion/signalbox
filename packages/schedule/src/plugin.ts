import { definePlugin, type NoEvents } from "@signalbox/core"
import { Cron } from "croner"

/** A cancellable scheduled job. */
export interface ScheduleHandle {
    /** Stop the job so it never runs (again). */
    cancel: () => void
}

/** Options for a cron schedule. */
export interface CronOptions {
    /** IANA timezone the pattern is evaluated in (e.g. `"Europe/Warsaw"`); defaults to host local time. */
    timezone?: string
}

/** The scheduler, exposed to workflows as `ctx.plugins.schedule`. */
export interface ScheduleApi {
    /**
     * Run `fn` once at `date`. A past date never fires.
     * @param date when to run
     * @param fn the job to run
     */
    at: (date: Date, fn: () => void | Promise<void>) => ScheduleHandle
    /**
     * Run `fn` repeatedly on a cron schedule (timezone-aware).
     * @param expression a cron pattern, e.g. `0 9 * * 1`
     * @param options cron options (timezone)
     * @param fn the job to run on each tick
     */
    cron: (expression: string, options: CronOptions, fn: () => void | Promise<void>) => ScheduleHandle
    /**
     * The next run of a cron expression at or after `from` (default now), or `null` if it never runs.
     * @param expression a cron pattern
     * @param options cron options (timezone)
     * @param from compute the next run from this instant; defaults to now
     */
    next: (expression: string, options?: CronOptions, from?: Date) => Date | null
}

/**
 * Plugin providing one-shot (`at`) and recurring (`cron`) scheduling, timezone-aware
 * via Croner. Every job it creates is cancelled when the app stops.
 */
export const schedulePlugin = () =>
    definePlugin<ScheduleApi, NoEvents>({
        name: "schedule",
        init: ctx => {
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
