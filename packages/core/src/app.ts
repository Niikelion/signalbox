import { redact } from "@signalbox/secrets"
import { randomUUID } from "node:crypto"
import { createBus, type Bus, type Channel, type EventMap, type Listener, type Unsubscribe } from "./bus"
import { FRAMEWORK_CHANNEL, type FrameworkEvents, type LogLevel } from "./events"
import { attachConsoleLogger, sanitizeError, SignalboxError, toError, write } from "./log"
import type { AnyPluginDefinition, Cleanup, PluginApis, PluginContext } from "./plugin"
import type { WorkflowContext, WorkflowDefinition } from "./workflow"
import { makePermissionFlow } from "./flow"
import type {
    ActiveAuthority,
    EntityRef,
    IdentityGrant,
    PermissionCoreRuntime,
    PermissionExecutionContext,
    PermissionRuntime,
    PermissionClaim,
} from "@signalbox/permissions"
import { entityRef, permissionClaim } from "@signalbox/permissions"

const APP_CHANNEL = "app"

/**
 * Options for {@link createApp}.
 * @typeParam TAppEvents the app's own event map
 * @typeParam TPlugins the plugins record
 */
export interface AppOptions<TAppEvents extends EventMap, TPlugins extends Record<string, AnyPluginDefinition>> {
    /** App name (used in cleanup error messages). */
    name: string
    /** Plugins, keyed by the name workflows reach them by (`ctx.plugins.<key>`). */
    plugins: TPlugins
    /** Workflows to wire. */
    workflows: WorkflowDefinition<TAppEvents, PluginApis<TPlugins>>[]
    /** Explicit security runtime, host identity, and app-owned workflow ceilings. */
    permissions: AppPermissionOptions
    /** Events that authenticated management clients may invoke explicitly. */
    manualTriggers?: readonly ManualTriggerDefinition<TAppEvents>[]
    /** Attach the console logger (default true). */
    logging?: boolean
}

export interface AppPermissionOptions {
    readonly runtime: PermissionRuntime
    readonly core: PermissionCoreRuntime
    readonly host: IdentityGrant
    readonly workflowIdentity?: (workflowName: string) => IdentityGrant
}

export interface AppCommandOptions extends PermissionExecutionContext {
    readonly identity: IdentityGrant
}

export interface ManualTriggerSchema<T = unknown> {
    parse(input: unknown): T
}

export interface ManualTriggerDefinition<TAppEvents extends EventMap = EventMap> {
    readonly id: string
    readonly event: keyof TAppEvents & string
    readonly schema: ManualTriggerSchema<TAppEvents[keyof TAppEvents]>
    readonly label?: string
    readonly description?: string
    readonly requiredClaims?: readonly PermissionClaim[]
}

export interface ManualTriggerInvocation {
    readonly eventId: string
    readonly actor: EntityRef
}

export interface ManualTriggerRegistry<TAppEvents extends EventMap = EventMap> {
    list(): readonly ManualTriggerDefinition<TAppEvents>[]
    invoke(id: string, payload: unknown, options: AppCommandOptions): Promise<ManualTriggerInvocation>
}

/** A composed application. */
export interface App {
    /** The app name. */
    readonly name: string
    /** Init plugins, wire workflows, then resume the bus and fire start hooks. */
    start: () => Promise<void>
    /** Run teardown callbacks (reverse order), detach the logger, and clear the bus. */
    stop: (reason?: string) => Promise<void>
    /** Start, then block until SIGINT/SIGTERM, then stop. */
    run: () => Promise<void>
    /** Execute a command for an authenticated identity and derive its canonical actor. */
    command<T>(options: AppCommandOptions, callback: (actor: EntityRef) => T | Promise<T>): Promise<T>
    /** Declared, validated, permission-checked management triggers. */
    readonly manualTriggers: ManualTriggerRegistry
}

type ScopedContext = Pick<PluginContext<EventMap>, "log" | "fail" | "onStart" | "onStop" | "interval" | "permissions">

/**
 * Compose plugins and workflows into a runnable app.
 * @typeParam TAppEvents the app's own event map
 * @typeParam TPlugins the plugins record
 * @param options the app name, plugins, and workflows
 */
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

    const hostAuthority = options.permissions.core.authorityFor(options.permissions.host)

    const runHost = <T>(operation: string, callback: () => T | Promise<T>): Promise<T> =>
        options.permissions.core.run(hostAuthority, { operation }, callback)

    const bindWorkflowChannel = <TEvents extends EventMap>(
        channel: Channel<TEvents>,
        ceiling: ActiveAuthority,
        workflowId: string,
    ): Channel<TEvents> => {
        const wrapped = new Map<PropertyKey, Map<object, unknown>>()
        const on = <TKey extends keyof TEvents>(event: TKey, listener: Listener<TEvents[TKey]>): Unsubscribe => {
            const wrappedListener: Listener<TEvents[TKey]> = payload => {
                const eventAuthority = options.permissions.core.currentAuthority()
                const authority = options.permissions.core.intersect(eventAuthority, ceiling)
                return options.permissions.core.run(
                    authority,
                    { operation: `event:${workflowId}:${String(event)}` },
                    () => listener(payload),
                )
            }
            const eventListeners = wrapped.get(event) ?? new Map<object, unknown>()
            eventListeners.set(listener, wrappedListener)
            wrapped.set(event, eventListeners)
            const unsubscribe = channel.on(event, wrappedListener)
            return () => {
                eventListeners.delete(listener)
                unsubscribe()
            }
        }
        return {
            on,
            once: (event, listener) => {
                const unsubscribe = on(event, payload => {
                    unsubscribe()
                    return listener(payload)
                })
                return unsubscribe
            },
            off: (event, listener) => {
                const eventListeners = wrapped.get(event)
                const stored = eventListeners?.get(listener)
                if (typeof stored !== "function") return
                eventListeners?.delete(listener)
                channel.off(event, stored as Listener<TEvents[typeof event]>)
            },
            emit: (event, payload) => {
                channel.emit(event, payload)
            },
            flow: event =>
                makePermissionFlow(emit => channel.on(event, emit), {
                    permissions: options.permissions.core,
                    ceiling,
                    workflowId,
                    authority: () => options.permissions.core.currentAuthority(),
                }),
        }
    }

    const scopedContext = (scope: string): ScopedContext => ({
        permissions: options.permissions.runtime,
        log: (message: string, level: LogLevel = "info") => {
            framework.emit("log", { level, message: redact(message), scope })
        },
        fail: (error: unknown) => {
            framework.emit("error", { scope, error: sanitizeError(error) })
        },
        onStart: fn => {
            startHooks.push(() => {
                try {
                    const result = runHost(`lifecycle.start:${scope}`, fn)
                    if (result instanceof Promise) {
                        result.catch((error: unknown) => {
                            framework.emit("error", { scope, error: sanitizeError(error) })
                        })
                    }
                } catch (error) {
                    framework.emit("error", { scope, error: sanitizeError(error) })
                }
            })
        },
        onStop: (cleanup: Cleanup) => {
            cleanups.push(cleanup)
        },
        interval: (ms: number, handler: () => void | Promise<void>) => {
            const timer = setInterval(() => {
                try {
                    const result = runHost(`lifecycle.interval:${scope}`, handler)
                    if (result instanceof Promise) {
                        result.catch((error: unknown) => {
                            framework.emit("error", { scope, error: sanitizeError(error) })
                        })
                    }
                } catch (error) {
                    framework.emit("error", { scope, error: sanitizeError(error) })
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
            apis[key] = await runHost<unknown>(`plugin.init:${plugin.name || key}`, () =>
                Promise.resolve(plugin.init(context) as unknown),
            )
        }
        const plugins = apis as PluginApis<TPlugins>

        for (const workflow of options.workflows) {
            const ceilingIdentity = options.permissions.workflowIdentity?.(workflow.name) ?? options.permissions.host
            const ceiling = options.permissions.core.authorityFor(ceilingIdentity)
            const context: WorkflowContext<TAppEvents, PluginApis<TPlugins>> = {
                app: bindWorkflowChannel(appChannel, ceiling, workflow.name),
                plugins,
                source: (policy, sourceStart) =>
                    makePermissionFlow(sourceStart, {
                        permissions: options.permissions.core,
                        ceiling,
                        workflowId: workflow.name,
                        subscriptionClaims: policy.subscriptionClaims,
                        sourceOperation: `source:${policy.entity.type}:${policy.entity.id}`,
                        authority: async value =>
                            options.permissions.core.authorityFor(await policy.eventIdentity(value)),
                    }),
                ...scopedContext(workflow.name),
            }
            await runHost(`workflow.setup:${workflow.name}`, () => workflow.setup(context))
        }

        for (const [key, plugin] of Object.entries(options.plugins)) {
            const context = contexts.get(key)
            const setup = plugin.setup
            if (!setup || !context) continue
            await runHost(`plugin.setup:${plugin.name || key}`, () => setup(context))
        }

        bus.resume()

        for (const hook of startHooks) hook()
    }

    const stop = async (_reason = "shutdown"): Promise<void> => {
        if (!started) return
        started = false

        for (const cleanup of [...cleanups].reverse()) {
            try {
                await runHost(`lifecycle.stop:${options.name}`, cleanup)
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

        await new Promise<void>(resolve => {
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

    const command: App["command"] = (commandOptions, callback) => {
        const { identity, ...context } = commandOptions
        return options.permissions.runtime.runAs(identity, context, () => {
            const actor = options.permissions.runtime.currentAuthority().principal
            return callback(actor)
        })
    }

    const triggerDefinitions = Object.freeze([...(options.manualTriggers ?? [])])
    if (new Set(triggerDefinitions.map(trigger => trigger.id)).size !== triggerDefinitions.length) {
        throw new SignalboxError("manual trigger IDs must be unique")
    }
    const manualTriggers: ManualTriggerRegistry<TAppEvents> = Object.freeze({
        list: () => triggerDefinitions,
        invoke: async (id: string, payload: unknown, commandOptions: AppCommandOptions) => {
            const trigger = triggerDefinitions.find(item => item.id === id)
            if (!trigger) throw new SignalboxError(`unknown manual trigger "${id}"`)
            return command(commandOptions, actor => {
                const triggerEntity = entityRef("manual-trigger", id)
                options.permissions.runtime.authorize(
                    options.permissions.runtime.currentAuthority(),
                    trigger.requiredClaims ?? [permissionClaim("trigger.invoke", triggerEntity)],
                    {
                        operation: `trigger.invoke:${id}`,
                        ...(commandOptions.requestId ? { requestId: commandOptions.requestId } : {}),
                    },
                )
                const parsed = trigger.schema.parse(payload)
                const eventId = randomUUID()
                appChannel.emit(trigger.event, parsed)
                return Object.freeze({ eventId, actor })
            })
        },
    })

    return {
        name: options.name,
        start,
        stop,
        run,
        command,
        manualTriggers: manualTriggers as unknown as ManualTriggerRegistry,
    }
}
