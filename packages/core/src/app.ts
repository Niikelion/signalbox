import { createEventBus, type EventBus, type EventMap } from "./bus.js"
import type { AppBus, FrameworkEvents, LogLevel } from "./events.js"
import { attachConsoleLogger, toError, write } from "./log.js"
import type { AnyPluginDefinition, Cleanup, PluginApis, PluginContext } from "./plugin.js"
import type { WorkflowContext, WorkflowDefinition } from "./workflow.js"

export interface AppOptions<TEvents extends EventMap, TPlugins extends Record<string, AnyPluginDefinition>> {
    name: string
    plugins: TPlugins
    workflows: WorkflowDefinition<TEvents, PluginApis<TPlugins>>[]
    /** Print `log`/`error` events to the console. Default true. */
    logging?: boolean
}

export interface App<TEvents extends EventMap> {
    readonly name: string
    readonly bus: AppBus<TEvents>
    start: () => Promise<void>
    stop: (reason?: string) => Promise<void>
    /** start(), then block until SIGINT/SIGTERM, then stop(). */
    run: () => Promise<void>
}

/**
 * Wires plugins and workflows onto one bus and owns their lifetime.
 *
 * Plugins run first, in declaration order, and expose an API. Workflows run
 * second and are handed those APIs plus the bus. Everything registered through
 * `onStop`/`interval` is torn down in reverse order on stop, so a workflow can
 * never outlive the plugin it depends on.
 */
export const createApp = <TEvents extends EventMap, TPlugins extends Record<string, AnyPluginDefinition>>(
    options: AppOptions<TEvents, TPlugins>,
): App<TEvents> => {
    const bus = createEventBus<TEvents & Record<string, unknown>>({
        // Start paused. A plugin can raise an event before the workflow that
        // handles it has been registered; buffering until everything is wired
        // makes that ordering irrelevant instead of merely unlikely.
        paused: true,
        onListenerError: (error, event) => {
            // never route listener failures back through `error`: a throwing
            // error-listener would loop forever
            write("error", `[bus] listener for "${event}" failed: ${error.message}`)
        },
    }) as AppBus<TEvents>

    /*
     * Same object, narrower view. On AppBus<TEvents> a framework payload types as
     * `TEvents["log"] & FrameworkEvents["log"]`, which TS cannot prove a literal
     * satisfies while TEvents is still generic. Apps never redeclare these keys,
     * so emitting them through the framework-only view is sound.
     */
    const frameworkBus = bus as unknown as EventBus<FrameworkEvents & Record<string, unknown>>

    const cleanups: Cleanup[] = []
    let detachLogger: (() => void) | undefined
    let started = false

    const scopedContext = (scope: string): Pick<PluginContext<TEvents>, "log" | "fail" | "onStop" | "interval"> => ({
        log: (message: string, level: LogLevel = "info") => {
            frameworkBus.emit("log", { level, message, scope })
        },
        fail: (error: unknown) => {
            frameworkBus.emit("error", { scope, error: toError(error) })
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
                            frameworkBus.emit("error", { scope, error: toError(error) })
                        })
                    }
                } catch (error) {
                    frameworkBus.emit("error", { scope, error: toError(error) })
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

        if (options.logging !== false) detachLogger = attachConsoleLogger(bus)

        // phase 1: plugins acquire resources and expose their APIs
        const apis: Record<string, unknown> = {}
        const contexts = new Map<string, PluginContext<TEvents>>()
        for (const [key, plugin] of Object.entries(options.plugins)) {
            const context = { bus, ...scopedContext(plugin.name || key) } as PluginContext<TEvents>
            contexts.set(key, context)
            apis[key] = await plugin.init(context)
        }
        const plugins = apis as PluginApis<TPlugins>

        // phase 2: workflows subscribe
        for (const workflow of options.workflows) {
            const scope = scopedContext(workflow.name)
            const context: WorkflowContext<TEvents, PluginApis<TPlugins>> = {
                bus,
                plugins,
                on: (event, listener) => bus.on(event, listener),
                emit: (event, payload) => {
                    bus.emit(event, payload)
                },
                ...scope,
            }
            await workflow.setup(context)
        }

        // phase 3: plugins start producing, now that every listener exists
        for (const [key, plugin] of Object.entries(options.plugins)) {
            const context = contexts.get(key)
            if (!plugin.setup || !context) continue
            await plugin.setup(context)
        }

        frameworkBus.emit("app:started", {
            plugins: Object.entries(options.plugins).map(([key, plugin]) =>
                plugin.name.length > 0 ? plugin.name : key,
            ),
            workflows: options.workflows.map((workflow) => workflow.name),
        })

        // phase 4: release anything raised during phases 1-3, in emit order
        bus.resume()
    }

    const stop = async (reason = "shutdown"): Promise<void> => {
        if (!started) return
        started = false

        frameworkBus.emit("app:stopping", { reason })
        for (const cleanup of [...cleanups].reverse()) {
            try {
                await cleanup()
            } catch (error) {
                write("error", `[${options.name}] cleanup failed: ${toError(error).message}`)
            }
        }
        cleanups.length = 0

        frameworkBus.emit("app:stopped", { reason })
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

    return { name: options.name, bus, start, stop, run }
}
