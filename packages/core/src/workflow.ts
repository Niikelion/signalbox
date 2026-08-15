import type { Channel, EventMap } from "./bus.js"
import type { LogLevel } from "./events.js"
import type { Cleanup } from "./plugin.js"

export interface WorkflowContext<TAppEvents extends EventMap, TPlugins> {
    app: Channel<TAppEvents>
    plugins: TPlugins
    log: (message: string, level?: LogLevel) => void
    fail: (error: unknown) => void
    onStart: (fn: () => void | Promise<void>) => void
    onStop: (cleanup: Cleanup) => void
    interval: (ms: number, handler: () => void | Promise<void>) => void
}

export interface WorkflowDefinition<TAppEvents extends EventMap, TPlugins> {
    name: string
    setup: (context: WorkflowContext<TAppEvents, TPlugins>) => void | Promise<void>
}

export const createWorkflowDefiner =
    <TAppEvents extends EventMap, TPlugins>() =>
    (
        name: string,
        setup: (context: WorkflowContext<TAppEvents, TPlugins>) => void | Promise<void>,
    ): WorkflowDefinition<TAppEvents, TPlugins> => ({ name, setup })
