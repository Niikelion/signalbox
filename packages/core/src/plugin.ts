import type { EventMap } from "./bus.js"
import type { AppBus, LogLevel } from "./events.js"

export type Cleanup = () => void | Promise<void>

export interface PluginContext<TEvents extends EventMap> {
    bus: AppBus<TEvents>
    log: (message: string, level?: LogLevel) => void
    fail: (error: unknown) => void
    onStop: (cleanup: Cleanup) => void
    interval: (ms: number, handler: () => void | Promise<void>) => void
}

export interface PluginDefinition<TApi, TEvents extends EventMap = EventMap> {
    name: string
    init: (ctx: PluginContext<TEvents>) => TApi | Promise<TApi>
    setup?: (ctx: PluginContext<TEvents>) => void | Promise<void>
}

export const definePlugin = <TApi, TEvents extends EventMap = EventMap>(
    definition: PluginDefinition<TApi, TEvents>,
): PluginDefinition<TApi, TEvents> => definition

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPluginDefinition = PluginDefinition<any, any>

export type PluginApis<TPlugins extends Record<string, AnyPluginDefinition>> = {
    [TKey in keyof TPlugins]: Awaited<ReturnType<TPlugins[TKey]["init"]>>
}
