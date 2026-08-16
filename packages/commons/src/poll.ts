import { makeFlow, type Flow, type LogLevel } from "@signalbox/core"

export type PollPhase = "startup" | "interval" | "retry"

type PollLog = (message: string, level?: LogLevel) => void

export interface PollContext {
    onStart: (fn: () => void | Promise<void>) => void
    onStop: (cleanup: () => void | Promise<void>) => void
    interval: (ms: number, handler: () => void | Promise<void>) => void
    log: (message: string, level?: LogLevel) => void
}

export interface FlowTrigger {
    run(sink: () => void | Promise<void>): void
}

export interface PollOptions<T> {
    ctx: PollContext
    every: number
    probe: (log: PollLog) => Promise<T>
    atStartup?: boolean
    retryOn?: FlowTrigger
    backoff?: readonly number[]
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms).unref()
    })

export const poll = <T>(options: PollOptions<T>): Flow<{ value: T; phase: PollPhase }> =>
    makeFlow((emit) => {
        const { ctx } = options

        const probeInto = async (phase: PollPhase): Promise<void> => {
            const value = await options.probe((message, level) => {
                ctx.log(message, level)
            })
            emit({ value, phase })
        }

        if (options.atStartup ?? true) {
            ctx.onStart(() => probeInto("startup"))
        }

        ctx.interval(options.every, () => {
            void probeInto("interval").catch((error: unknown) => {
                ctx.log(`poll failed: ${(error as Error).message}`, "warn")
            })
        })

        const retry = options.retryOn
        if (retry) {
            let stopped = false
            ctx.onStop(() => {
                stopped = true
            })
            const backoff = options.backoff ?? [5, 15, 30, 60]

            retry.run(async () => {
                for (const waitSeconds of backoff) {
                    if (stopped) return
                    try {
                        await probeInto("retry")
                        return
                    } catch (error) {
                        ctx.log(
                            `re-probe failed (${(error as Error).message}), retrying in ${String(waitSeconds)}s`,
                            "warn",
                        )
                        await sleep(waitSeconds * 1000)
                    }
                }
            })
        }
    })
