import { createBus, type Bus, type EventMap } from "./bus.js"
import { FRAMEWORK_CHANNEL, type FrameworkEvents, type LogLevel } from "./events.js"
import { attachConsoleLogger, toError, write } from "./log.js"
import type { AnyPluginDefinition, Cleanup, PluginApis, PluginContext } from "./plugin.js"
import type { WorkflowContext, WorkflowDefinition } from "./workflow.js"

const APP_CHANNEL = "app"

export interface AppOptions<TAppEvents extends EventMap, TPlugins extends Record<string, AnyPluginDefinition>> {
    name: string
    plugins: TPlugins
    workflows: WorkflowDefinition<TAppEvents, PluginApis<TPlugins>>[]
    logging?: boolean
}

export interface App {
    readonly name: string
    start: () => Promise<void>
    stop: (reason?: string) => Promise<void>
    run: () => Promise<void>
}

type ScopedContext = Pick<PluginContext<EventMap>, "log" | "fail" | "onStart" | "onStop" | "interval">

export const createApp = <TAppEvents extends EventMap, TPlugins extends Record<string, AnyPluginDefinition>>(
    options: AppOptions<TAppEvents, TPlugins>,
): App => {
    const bus: Bus = createBus({
        paused: true,
        onListenerError: (error, channel, event) => {
            write("error", `[bus] listener for "${channel}/${event}" failed: ${error.message}`)
        },
    })

    const framework = bus.channel<FrameworkEvents>(FRAMEWORK_CHANNEL)
    const appChannel = bus.channel<TAppEvents>(APP_CHANNEL)

    const cleanups: Cleanup[] = []
    const startHooks: (() => void)[] = []
    let detachLogger: (() => void) | undefined
    let started = false

    const scopedContext = (scope: string): ScopedContext => ({
        log: (message: string, level: LogLevel = "info") => {
            framework.emit("log", { level, message, scope })
        },
        fail: (error: unknown) => {
            framework.emit("error", { scope, error: toError(error) })
        },
        onStart: (fn) => {
            startHooks.push(() => {
                try {
                    const result = fn()
                    if (result instanceof Promise) {
                        result.catch((error: unknown) => {
                            framework.emit("error", { scope, error: toError(error) })
                        })
                    }
                } catch (error) {
                    framework.emit("error", { scope, error: toError(error) })
                }
            })
        },
        onStop: (cleanup: Cleanup) => {
            cleanups.push(cleanup)
        },
        interval: (ms: number, handler: () => void | Promise<void>) => {
            const timer = setInterval(() => {
                try {
                    const result = handler()
                    if (result instanceof Promise) {
                        result.catch((error: unknown) => {
                            framework.emit("error", { scope, error: toError(error) })
                        })
                    }
                } catch (error) {
                    framework.emit("error", { scope, error: toError(error) })
                }
            }, ms)
            timer.unref()
            cleanups.push(() => {
                clearInterval(timer)
            })
        },
    })

    const start = async (): Promise<void> => {
        if (started) return
        started = true

        if (options.logging !== false) detachLogger = attachConsoleLogger(framework)

        const apis: Record<string, unknown> = {}
        const contexts = new Map<string, PluginContext<EventMap>>()
        for (const [key, plugin] of Object.entries(options.plugins)) {
            const context: PluginContext<EventMap> = {
                channel: bus.channel<EventMap>(key),
                ...scopedContext(plugin.name || key),
            }
            contexts.set(key, context)
            apis[key] = await plugin.init(context)
        }
        const plugins = apis as PluginApis<TPlugins>

        for (const workflow of options.workflows) {
            const context: WorkflowContext<TAppEvents, PluginApis<TPlugins>> = {
                app: appChannel,
                plugins,
                ...scopedContext(workflow.name),
            }
            await workflow.setup(context)
        }

        for (const [key, plugin] of Object.entries(options.plugins)) {
            const context = contexts.get(key)
            if (!plugin.setup || !context) continue
            await plugin.setup(context)
        }

        bus.resume()

        for (const hook of startHooks) hook()
    }

    const stop = async (_reason = "shutdown"): Promise<void> => {
        if (!started) return
        started = false

        for (const cleanup of [...cleanups].reverse()) {
            try {
                await cleanup()
            } catch (error) {
                write("error", `[${options.name}] cleanup failed: ${toError(error).message}`)
            }
        }
        cleanups.length = 0
        startHooks.length = 0

        detachLogger?.()
        detachLogger = undefined
        bus.clear()
    }

    const run = async (): Promise<void> => {
        await start()

        await new Promise<void>((resolve) => {
            const shutdown = (signal: string): void => {
                void stop(signal).then(resolve, resolve)
            }
            process.once("SIGINT", () => {
                shutdown("SIGINT")
            })
            process.once("SIGTERM", () => {
                shutdown("SIGTERM")
            })
        })
    }

    return { name: options.name, start, stop, run }
}
