import type { Channel, EventMap } from "./bus"
import type { LogLevel } from "./events"

/** A teardown callback registered with `onStop`. */
export type Cleanup = () => void | Promise<void>

/**
 * What a plugin receives at init/setup.
 * @typeParam TEvents the plugin's own event map
 */
export interface PluginContext<TEvents extends EventMap> {
    /** The plugin's own typed channel (emit/subscribe to its events). */
    channel: Channel<TEvents>
    /**
     * Log a message under the plugin's scope.
     * @param message the message
     * @param level severity (default "info")
     */
    log: (message: string, level?: LogLevel) => void
    /**
     * Report an error under the plugin's scope.
     * @param error the error (any value; normalized to an Error)
     */
    fail: (error: unknown) => void
    /**
     * Register a callback to run once the app has started.
     * @param fn the callback
     */
    onStart: (fn: () => void | Promise<void>) => void
    /**
     * Register a teardown callback, run on stop (reverse order).
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
 * A plugin definition.
 * @typeParam TApi the API the plugin exposes as `ctx.plugins.<name>`
 * @typeParam TEvents the plugin's own event map
 */
export interface PluginDefinition<TApi, TEvents extends EventMap = EventMap> {
    /** Plugin name (also the scope used in logs). */
    name: string
    /**
     * Build the plugin's API. Runs before workflows are wired.
     * @param ctx the plugin context
     */
    init: (ctx: PluginContext<TEvents>) => TApi | Promise<TApi>
    /**
     * Optional deferred startup, after workflows are wired (e.g. open a connection).
     * @param ctx the plugin context
     */
    setup?: (ctx: PluginContext<TEvents>) => void | Promise<void>
}

/**
 * Identity helper that captures a plugin definition's types.
 * @typeParam TApi the API type
 * @typeParam TEvents the event map
 * @param definition the plugin definition
 */
export const definePlugin = <TApi, TEvents extends EventMap = EventMap>(
    definition: PluginDefinition<TApi, TEvents>,
): PluginDefinition<TApi, TEvents> => definition

/** Any plugin definition, regardless of its API/events. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPluginDefinition = PluginDefinition<any, any>

/**
 * Maps a plugins record to the APIs workflows see as `ctx.plugins`.
 * @typeParam TPlugins the record of plugin definitions
 */
export type PluginApis<TPlugins extends Record<string, AnyPluginDefinition>> = {
    [TKey in keyof TPlugins]: Awaited<ReturnType<TPlugins[TKey]["init"]>>
}
