import type { Channel, EventMap } from "./bus"
import type { LogLevel } from "./events"
import type { Cleanup } from "./plugin"
import type { Flow } from "./flow"
import type { PermissionRuntime, PermissionSourcePolicy } from "@signalbox/permissions"

export type WorkflowSourceStart<T> = (emit: (value: T) => void) => void

/**
 * What a workflow receives at setup.
 * @typeParam TAppEvents the app's own event map
 * @typeParam TPlugins the app's plugin APIs (`ctx.plugins`)
 */
export interface WorkflowContext<TAppEvents extends EventMap, TPlugins> {
    /** The app's own channel (emit/subscribe to app-level events). */
    app: Channel<TAppEvents>
    /** The app's plugin APIs. */
    plugins: TPlugins
    /** Restricted permission enforcement capability. */
    permissions: PermissionRuntime
    /** Attach a permission-declared source using this workflow's app-owned ceiling. */
    source<T>(policy: PermissionSourcePolicy<T>, start: WorkflowSourceStart<T>): Flow<T>
    /**
     * Log a message under the workflow's scope.
     * @param message the message
     * @param level severity (default "info")
     */
    log: (message: string, level?: LogLevel) => void
    /**
     * Report an error under the workflow's scope.
     * @param error the error (any value; normalized to an Error)
     */
    fail: (error: unknown) => void
    /**
     * Register a callback to run once the app has started.
     * @param fn the callback
     */
    onStart: (fn: () => void | Promise<void>) => void
    /**
     * Register a teardown callback, run on stop.
     * @param cleanup the teardown
     */
    onStop: (cleanup: Cleanup) => void
    /**
     * Run a handler on a repeating interval; cleared on stop.
     * @param ms the interval in milliseconds
     * @param handler the handler
     */
    interval: (ms: number, handler: () => void | Promise<void>) => void
}

/**
 * A workflow definition.
 * @typeParam TAppEvents the app's own event map
 * @typeParam TPlugins the app's plugin APIs
 */
export interface WorkflowDefinition<TAppEvents extends EventMap, TPlugins> {
    /** Workflow name (also the scope used in logs). */
    name: string
    /**
     * Wire the workflow.
     * @param context the workflow context
     */
    setup: (context: WorkflowContext<TAppEvents, TPlugins>) => void | Promise<void>
}

/**
 * Create a `defineWorkflow(name, setup)` bound to an app's event and plugin types.
 * @typeParam TAppEvents the app's own event map
 * @typeParam TPlugins the app's plugin APIs
 */
export const createWorkflowDefiner =
    <TAppEvents extends EventMap, TPlugins>() =>
    (
        name: string,
        setup: (context: WorkflowContext<TAppEvents, TPlugins>) => void | Promise<void>,
    ): WorkflowDefinition<TAppEvents, TPlugins> => ({ name, setup })
