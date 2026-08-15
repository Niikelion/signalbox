import type { EventMap, FrameworkEvents, LogLevel, WorkflowDefinition } from "@signalbox/core"

export type PollPhase = "startup" | "interval" | "retry"

type PollLog = (message: string, level?: LogLevel) => void

export interface PollOptions<TEvents extends EventMap, TKey extends keyof TEvents, TResult> {
    name: string
    every: number
    atStartup?: boolean
    probe: (log: PollLog) => Promise<TResult>
    emit: TKey
    toPayload: (result: TResult, phase: PollPhase) => TEvents[TKey]
    retryOn?: { event: keyof TEvents & string; backoff: readonly number[] }
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms).unref()
    })

export const createPoll =
    <TEvents extends EventMap, TPlugins = unknown>() =>
    <TKey extends keyof TEvents, TResult>(
        options: PollOptions<TEvents, TKey, TResult>,
    ): WorkflowDefinition<TEvents, TPlugins> => ({
        name: options.name,
        setup: (ctx) => {
            let stopped = false
            ctx.onStop(() => {
                stopped = true
            })

            const probeAndEmit = async (phase: PollPhase): Promise<void> => {
                const result = await options.probe((message, level) => {
                    ctx.log(message, level)
                })
                ctx.emit(options.emit, options.toPayload(result, phase) as (TEvents & FrameworkEvents)[TKey])
            }

            if (options.atStartup ?? true) {
                ctx.on("app:started", () => {
                    void probeAndEmit("startup").catch((error: unknown) => {
                        ctx.fail(error)
                    })
                })
            }

            ctx.interval(options.every, () => {
                void probeAndEmit("interval").catch((error: unknown) => {
                    ctx.log(`poll failed: ${(error as Error).message}`, "warn")
                })
            })

            const retry = options.retryOn
            if (retry) {
                ctx.on(retry.event, async () => {
                    for (const waitSeconds of retry.backoff) {
                        if (stopped) return
                        try {
                            await probeAndEmit("retry")
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
        },
    })
