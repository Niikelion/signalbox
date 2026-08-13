import type { EventMap, Listener, Unsubscribe } from "./bus.js"
import type { AppBus, FrameworkEvents, LogLevel } from "./events.js"
import type { Cleanup } from "./plugin.js"

export interface WorkflowContext<TEvents extends EventMap, TPlugins> {
    bus: AppBus<TEvents>
    /** Resolved plugin APIs, keyed by plugin name. */
    plugins: TPlugins
    on: <TKey extends keyof (TEvents & FrameworkEvents)>(
        event: TKey,
        listener: Listener<(TEvents & FrameworkEvents)[TKey]>,
    ) => Unsubscribe
    emit: <TKey extends keyof (TEvents & FrameworkEvents)>(
        event: TKey,
        payload: (TEvents & FrameworkEvents)[TKey],
    ) => void
    log: (message: string, level?: LogLevel) => void
    fail: (error: unknown) => void
    onStop: (cleanup: Cleanup) => void
    /** setInterval that is cleared automatically on stop. */
    interval: (ms: number, handler: () => void | Promise<void>) => void
}

export interface WorkflowDefinition<TEvents extends EventMap, TPlugins> {
    name: string
    setup: (context: WorkflowContext<TEvents, TPlugins>) => void | Promise<void>
}

/**
 * Produces a `defineWorkflow` bound to one app's event map and plugin set, so
 * workflow files get full inference without repeating the generics:
 *
 * ```ts
 * export const defineWorkflow = createWorkflowDefiner<DdnsEvents, DdnsPlugins>()
 * ```
 */
export const createWorkflowDefiner =
    <TEvents extends EventMap, TPlugins>() =>
    (
        name: string,
        setup: (context: WorkflowContext<TEvents, TPlugins>) => void | Promise<void>,
    ): WorkflowDefinition<TEvents, TPlugins> => ({ name, setup })
