import type { EventMap } from "./bus.js"
import type { AppBus, LogLevel } from "./events.js"

export type Cleanup = () => void | Promise<void>

export interface PluginContext<TEvents extends EventMap> {
    bus: AppBus<TEvents>
    /** Emit a `log` event already tagged with the plugin name. */
    log: (message: string, level?: LogLevel) => void
    /** Emit an `error` event already tagged with the plugin name. */
    fail: (error: unknown) => void
    /** Register cleanup to run when the app stops, in reverse order. */
    onStop: (cleanup: Cleanup) => void
    /** setInterval that is cleared automatically on stop. */
    interval: (ms: number, handler: () => void | Promise<void>) => void
}

/**
 * Plugins run in two phases, and the split is what makes event ordering a
 * non-issue rather than a race:
 *
 *   init   → acquire resources, build the API. No workflow exists yet.
 *   setup  → start producing. Every workflow has subscribed by now.
 */
export interface PluginDefinition<TApi, TEvents extends EventMap = EventMap> {
    name: string
    /**
     * Acquire resources and build the API that becomes `ctx.plugins[name]`.
     * Runs before any workflow exists, so keep it free of side effects that can
     * raise events — those belong in `setup`. Failing here should mean the app
     * cannot start (a port already bound, a missing credential).
     */
    init: (ctx: PluginContext<TEvents>) => TApi | Promise<TApi>
    /**
     * Start producing. Runs once every plugin has initialised and every workflow
     * has subscribed, so an event raised here always has its listeners in place.
     * The bus is still paused at this point as well, so even a synchronous burst
     * during this phase survives.
     */
    setup?: (ctx: PluginContext<TEvents>) => void | Promise<void>
}

/**
 * Identity helper that pins the generics so plugin authors get inference on
 * `ctx` and callers get the API type back without writing it twice.
 */
export const definePlugin = <TApi, TEvents extends EventMap = EventMap>(
    definition: PluginDefinition<TApi, TEvents>,
): PluginDefinition<TApi, TEvents> => definition

/*
 * `any` here is deliberate and confined to the constraint: plugins declare the
 * events they need, and a heterogeneous record of them only type-checks as a
 * collection if the element type is bivariant. Concrete APIs are still recovered
 * exactly by PluginApis below, because it is applied to `typeof plugins`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnyPluginDefinition = PluginDefinition<any, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Maps a record of plugin definitions to the record of APIs their `init` resolves to. */
export type PluginApis<TPlugins extends Record<string, AnyPluginDefinition>> = {
    [TKey in keyof TPlugins]: Awaited<ReturnType<TPlugins[TKey]["init"]>>
}
