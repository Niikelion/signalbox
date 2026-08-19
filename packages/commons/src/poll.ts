import { makeFlow, type Flow, type LogLevel } from "@signalbox/core"

/** Which trigger produced a poll value. */
export type PollPhase = "startup" | "interval" | "retry"

type PollLog = (message: string, level?: LogLevel) => void

/** The lifecycle and logging bits {@link poll} needs from a workflow context. */
export interface PollContext {
    /**
     * Register a start callback.
     * @param fn the callback
     */
    onStart: (fn: () => void | Promise<void>) => void
    /**
     * Register a teardown callback.
     * @param cleanup the teardown
     */
    onStop: (cleanup: () => void | Promise<void>) => void
    /**
     * Run a handler on an interval.
     * @param ms interval in milliseconds
     * @param handler the handler
     */
    interval: (ms: number, handler: () => void | Promise<void>) => void
    /**
     * Log a message.
     * @param message the message
     * @param level severity
     */
    log: (message: string, level?: LogLevel) => void
}

/** Something that fires a callback — typically a {@link Flow}'s `run`. */
export interface FlowTrigger {
    /**
     * Subscribe to the trigger.
     * @param sink called on each fire
     */
    run(sink: () => void | Promise<void>): void
}

/**
 * Options for {@link poll}.
 * @typeParam T the probed value type
 */
export interface PollOptions<T> {
    /** The workflow context (lifecycle + logging). */
    ctx: PollContext
    /** Interval between probes, in milliseconds. */
    every: number
    /** Fetch the current value; receives a scoped logger. */
    probe: (log: PollLog) => Promise<T>
    /** Probe once at startup (default true). */
    atStartup?: boolean
    /** When this fires, re-probe with backoff. */
    retryOn?: FlowTrigger
    /** Backoff delays in seconds for retries. Defaults to `[5, 15, 30, 60]`. */
    backoff?: readonly number[]
}

const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => {
        setTimeout(resolve, ms).unref()
    })

/**
 * A polling flow: probes at startup, on an interval, and on a retry trigger (with
 * backoff), emitting `{ value, phase }` each time.
 * @typeParam T the probed value type
 * @param options the poll options
 */
export const poll = <T>(options: PollOptions<T>): Flow<{ value: T; phase: PollPhase }> =>
    makeFlow(emit => {
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
