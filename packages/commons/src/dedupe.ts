import type { EventMap, WorkflowDefinition } from "@signalbox/core"

export interface DedupeOptions<TEvents extends EventMap, TIn extends keyof TEvents, TOut extends keyof TEvents> {
    name: string
    on: TIn
    emit: TOut
    key: (payload: TEvents[TIn]) => string
    toPayload: (payload: TEvents[TIn], previous: string | null) => TEvents[TOut]
    message?: (payload: TEvents[TIn], previous: string | null) => string
}

export const createDedupe =
    <TEvents extends EventMap, TPlugins = unknown>() =>
    <TIn extends keyof TEvents, TOut extends keyof TEvents>(
        options: DedupeOptions<TEvents, TIn, TOut>,
    ): WorkflowDefinition<TEvents, TPlugins> => ({
        name: options.name,
        setup: (ctx) => {
            let previous: string | null = null

            ctx.app.on(options.on, (payload) => {
                const next = options.key(payload)
                if (next === previous) return

                const prior = previous
                previous = next

                if (options.message) ctx.log(options.message(payload, prior))
                ctx.app.emit(options.emit, options.toPayload(payload, prior))
            })
        },
    })
