import {
    SignalboxError,
    makeFlow,
    toError,
    type EventMap,
    type Flow,
    type LogLevel,
    type RunContext,
    type Unsubscribe,
    type WorkflowDefinition,
} from "@signalbox/core"
import { assertJsonValue, isSecret, redact, Secret, type JsonValue } from "@signalbox/secrets"

/** A workflow described as data: a set of nodes joined by edges. */
export interface WorkflowGraph {
    /** Workflow name. */
    name: string
    /** The nodes. */
    nodes: GraphNode[]
    /** The edges connecting node outputs to inputs. */
    edges: GraphEdge[]
}

/** One node in a {@link WorkflowGraph}. */
export interface GraphNode {
    /** Unique node id (referenced by edges). */
    id: string
    /** The registered node type. */
    type: string
    /** The node's configuration. */
    config?: Record<string, unknown>
}

/** A directed edge from one node's output to another's input. */
export interface GraphEdge {
    from: string
    to: string
}

/** The value type of a node config field. */
export type ConfigFieldType = "string" | "number" | "boolean" | "array" | "object" | "any"

/** A node config field's schema. */
export interface ConfigField {
    type: ConfigFieldType
    required?: boolean
}

/** A node's config schema: field name â†’ {@link ConfigField}. */
export type NodeConfigSchema = Record<string, ConfigField>

/** What a graph node receives at runtime. */
export interface GraphNodeContext {
    /** The app's plugin APIs. */
    plugins: Record<string, unknown>
    /** Subscribe to an app event. */
    on: (event: string, listener: (payload: unknown) => void) => Unsubscribe
    /** Emit an app event. */
    emit: (event: string, payload: unknown) => void
    /** Log a message. */
    log: (message: string, level?: LogLevel) => void
    /** Report an error. */
    fail: (error: unknown) => void
    /** Register a teardown callback. */
    onStop: (cleanup: () => void | Promise<void>) => void
    /** Run a handler on an interval. */
    interval: (ms: number, handler: () => void | Promise<void>) => void
    /** Resolve a `{{ template }}` against an input value. */
    resolve: (template: unknown, input: unknown) => unknown
    /** Recursively resolve templates in an object/array. */
    resolveDeep: (template: unknown, input: unknown) => unknown
}

/** A running trigger node: a source that pushes values downstream. */
export interface TriggerInstance {
    start: (args: { config: Record<string, unknown>; ctx: GraphNodeContext; push: (value: unknown) => void }) => void
}

/** A registered trigger node type (a source). */
export interface TriggerNodeType {
    type: string
    kind: "trigger"
    configSchema: NodeConfigSchema
    create: () => TriggerInstance
}

export interface FlowNodeArgs {
    config: Record<string, unknown>
    input: unknown
    ctx: GraphNodeContext
    run: RunContext
}

/** A running map node: transforms an input into an output. */
export interface MapInstance {
    run: (args: FlowNodeArgs) => unknown
}

/** A registered map node type. */
export interface MapNodeType {
    type: string
    kind: "map"
    configSchema: NodeConfigSchema
    create: () => MapInstance
}

/** A running filter node: decides whether an input continues. */
export interface FilterInstance {
    run: (args: FlowNodeArgs) => boolean | Promise<boolean>
}

/** A registered filter node type. */
export interface FilterNodeType {
    type: string
    kind: "filter"
    configSchema: NodeConfigSchema
    create: () => FilterInstance
}

/** A running fork node: splits one input into joined child runs. */
export interface ForkInstance {
    run: (args: FlowNodeArgs) => readonly unknown[] | Promise<readonly unknown[]>
}

/** A registered fork node type. */
export interface ForkNodeType {
    type: string
    kind: "fork"
    configSchema: NodeConfigSchema
    create: () => ForkInstance
}

/** A running effect node: performs terminal work. */
export interface EffectInstance {
    run: (args: FlowNodeArgs) => void | Promise<void>
}

/** A registered effect node type. */
export interface EffectNodeType {
    type: string
    kind: "effect"
    configSchema: NodeConfigSchema
    create: () => EffectInstance
}

/** A registered detach node type. */
export interface DetachNodeType {
    type: string
    kind: "detach"
    configSchema: NodeConfigSchema
}

/** Any registered node type. */
export type NodeType = TriggerNodeType | MapNodeType | FilterNodeType | ForkNodeType | EffectNodeType | DetachNodeType

/** A registry of node types. */
export interface NodeRegistry {
    register: (type: NodeType) => void
    get: (type: string) => NodeType | undefined
    list: () => string[]
}

/** Create an empty node registry. */
export const createNodeRegistry = (): NodeRegistry => {
    const types = new Map<string, NodeType>()
    return {
        register: type => {
            types.set(type.type, type)
        },
        get: type => types.get(type),
        list: () => [...types.keys()],
    }
}

/** The default registry that {@link registerNode} and {@link compileGraph} use. */
export const defaultRegistry = createNodeRegistry()

/**
 * Register a node type on the default registry.
 * @param type the node type
 */
export const registerNode = (type: NodeType): void => {
    defaultRegistry.register(type)
}

const getPath = (source: unknown, path: string): unknown => {
    let current = source
    for (const key of path.split(".")) {
        if (current === null || typeof current !== "object") return undefined
        current = (current as Record<string, unknown>)[key]
    }
    return current
}

const stringify = (value: unknown): string => {
    if (value === undefined || value === null) return ""
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value.toString()
    return JSON.stringify(value)
}

/** The scopes a `{{ â€¦ }}` template resolves against. */
export interface ResolveScope {
    /** The current input value (`$input`, `input.x`, or bare `x`). */
    input: unknown
    /** Config values (`$config.x`). */
    config?: Record<string, unknown>
    /** Secret values (`$secret.x`). */
    secret?: Record<string, unknown>
}

const lookup = (path: string, scope: ResolveScope): unknown => {
    if (path === "$input") return scope.input
    if (path.startsWith("$config.")) return getPath(scope.config, path.slice("$config.".length))
    if (path.startsWith("$secret.")) {
        const [name, ...rest] = path.slice("$secret.".length).split(".")
        const wrapped = name ? scope.secret?.[name] : undefined
        const value = isSecret(wrapped) ? wrapped.reveal() : wrapped
        return rest.length > 0 ? getPath(value, rest.join(".")) : value
    }
    return getPath(scope.input, path.startsWith("input.") ? path.slice("input.".length) : path)
}

/**
 * Resolve a `{{ path }}` template string against a scope. Non-strings pass through.
 * A whole-string `{{ x }}` returns the raw value; interpolations are stringified.
 * @param template the template (or any value)
 * @param scope the input/config/secret scopes
 */
export const resolveTemplate = (template: unknown, scope: ResolveScope): unknown => {
    if (typeof template !== "string") return template

    const whole = /^\{\{\s*([\w.$]+)\s*\}\}$/.exec(template)
    if (whole?.[1]) return lookup(whole[1], scope)

    return template.replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (_match, path: string) => stringify(lookup(path, scope)))
}

/**
 * Recursively {@link resolveTemplate} every string in an object/array.
 * @param template the value to resolve
 * @param scope the input/config/secret scopes
 */
export const resolveDeep = (template: unknown, scope: ResolveScope): unknown => {
    if (typeof template === "string") return resolveTemplate(template, scope)
    if (Array.isArray(template)) return template.map(item => resolveDeep(item, scope))
    if (template !== null && typeof template === "object") {
        const output: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(template)) output[key] = resolveDeep(value, scope)
        return output
    }
    return template
}

const matchesType = (value: unknown, type: ConfigFieldType): boolean => {
    switch (type) {
        case "string":
            return typeof value === "string"
        case "number":
            return typeof value === "number"
        case "boolean":
            return typeof value === "boolean"
        case "array":
            return Array.isArray(value)
        case "object":
            return typeof value === "object" && value !== null && !Array.isArray(value)
        case "any":
            return true
    }
}

const validateConfig = (node: GraphNode, schema: NodeConfigSchema): void => {
    const config = node.config ?? {}
    const problems: string[] = []

    for (const [field, def] of Object.entries(schema)) {
        const value = config[field]
        if (value === undefined) {
            if (def.required) problems.push(`missing "${field}"`)
            continue
        }
        if (!matchesType(value, def.type)) problems.push(`"${field}" must be ${def.type}`)
    }

    if (problems.length > 0) {
        throw new SignalboxError(`node "${node.id}" (${node.type}): ${problems.join(", ")}`)
    }
}

/** Options for {@link compileGraph}. */
export interface CompileOptions {
    /** Node registry to resolve types against (default: {@link defaultRegistry}). */
    registry?: NodeRegistry
    /** Config values available to `{{ $config.x }}` templates. */
    config?: Record<string, unknown>
    /** JSON-compatible secret values available to `{{ $secret.x }}`. */
    secrets?: Record<string, JsonValue | Secret<JsonValue>>
}

const wrapSecrets = (values: Record<string, JsonValue | Secret<JsonValue>>): Record<string, Secret<JsonValue>> => {
    const wrapped: Record<string, Secret<JsonValue>> = {}
    for (const [name, value] of Object.entries(values)) {
        if (isSecret(value)) {
            wrapped[name] = value
            continue
        }
        assertJsonValue(value, `$secret.${name}`)
        wrapped[name] = Secret.from(value)
    }
    return wrapped
}

/**
 * Compile a {@link WorkflowGraph} into a {@link WorkflowDefinition} that runs on the bus.
 * @typeParam TEvents the app's event map
 * @typeParam TPlugins the app's plugin APIs
 * @param graph the graph to compile
 * @param options registry, config, and secrets
 */
export const compileGraph = <TEvents extends EventMap = EventMap, TPlugins = Record<string, unknown>>(
    graph: WorkflowGraph,
    options: CompileOptions = {},
): WorkflowDefinition<TEvents, TPlugins> => {
    const registry = options.registry ?? defaultRegistry
    const config = options.config ?? {}
    const secrets = wrapSecrets(options.secrets ?? {})

    const nodeById = new Map<string, GraphNode>()
    for (const node of graph.nodes) {
        const type = registry.get(node.type)
        if (!type) {
            throw new SignalboxError(
                `unknown node type "${node.type}" (node "${node.id}")`,
                `registered types: ${registry.list().join(", ")}`,
            )
        }
        validateConfig(node, type.configSchema)
        nodeById.set(node.id, node)
    }

    const downstream = new Map<string, string[]>()
    for (const edge of graph.edges) {
        if (!nodeById.has(edge.from)) throw new SignalboxError(`edge from unknown node "${edge.from}"`)
        if (!nodeById.has(edge.to)) throw new SignalboxError(`edge to unknown node "${edge.to}"`)
        downstream.set(edge.from, [...(downstream.get(edge.from) ?? []), edge.to])
    }

    return {
        name: graph.name,
        setup: ctx => {
            const nodeCtx: GraphNodeContext = {
                plugins: ctx.plugins as Record<string, unknown>,
                on: (event, listener) => ctx.app.on(event as never, listener),
                emit: (event, payload) => {
                    ctx.app.emit(event as never, payload as never)
                },
                log: (message, level) => {
                    ctx.log(redact(message), level)
                },
                fail: error => {
                    ctx.fail(redact(toError(error)))
                },
                onStop: ctx.onStop,
                interval: ctx.interval,
                resolve: (template, input) => resolveTemplate(template, { input, config, secret: secrets }),
                resolveDeep: (template, input) => resolveDeep(template, { input, config, secret: secrets }),
            }

            const instances = new Map<string, MapInstance | FilterInstance | ForkInstance | EffectInstance>()
            for (const node of graph.nodes) {
                const type = registry.get(node.type)
                if (
                    type?.kind === "map" ||
                    type?.kind === "filter" ||
                    type?.kind === "fork" ||
                    type?.kind === "effect"
                ) {
                    instances.set(node.id, type.create())
                }
            }

            const nodeArgs = (node: GraphNode, input: unknown, run: RunContext): FlowNodeArgs => ({
                config: node.config ?? {},
                input,
                ctx: nodeCtx,
                run,
            })

            const failAndThrow = (error: unknown): never => {
                nodeCtx.fail(error)
                throw error
            }

            const applyNode = (nodeId: string, input: Flow<unknown>): Flow<unknown> | undefined => {
                const node = nodeById.get(nodeId)
                const type = node ? registry.get(node.type) : undefined
                const instance = instances.get(nodeId)
                if (!node || !type) return input

                switch (type.kind) {
                    case "trigger":
                        return input
                    case "map":
                        return input.map(async (value, run) => {
                            try {
                                return await (instance as MapInstance).run(nodeArgs(node, value, run))
                            } catch (error) {
                                return failAndThrow(error)
                            }
                        })
                    case "filter":
                        return input.filter(async (value, run) => {
                            try {
                                return await (instance as FilterInstance).run(nodeArgs(node, value, run))
                            } catch (error) {
                                return failAndThrow(error)
                            }
                        })
                    case "fork":
                        return input.fork(async (value, run) => {
                            try {
                                return await (instance as ForkInstance).run(nodeArgs(node, value, run))
                            } catch (error) {
                                return failAndThrow(error)
                            }
                        })
                    case "detach":
                        return input.detach()
                    case "effect":
                        input.effect(async (value, run) => {
                            try {
                                return await (instance as EffectInstance).run(nodeArgs(node, value, run))
                            } catch (error) {
                                return failAndThrow(error)
                            }
                        })
                        return undefined
                }
            }

            const wireFrom = (nodeId: string, input: Flow<unknown>): void => {
                const nextIds = downstream.get(nodeId) ?? []
                if (nextIds.length === 0) {
                    input.effect(() => undefined)
                    return
                }

                for (const nextId of nextIds) {
                    const next = applyNode(nextId, input)
                    if (next) wireFrom(nextId, next)
                }
            }

            for (const node of graph.nodes) {
                const type = registry.get(node.type)
                if (type?.kind !== "trigger") continue
                const source = makeFlow<unknown>(push => {
                    type.create().start({
                        config: node.config ?? {},
                        ctx: nodeCtx,
                        push,
                    })
                })
                wireFrom(node.id, source)
            }
        },
    }
}

registerNode({
    type: "event.on",
    kind: "trigger",
    configSchema: { event: { type: "string", required: true } },
    create: () => ({
        start: ({ config, ctx, push }) => {
            ctx.on(String(config["event"]), payload => {
                push(payload)
            })
        },
    }),
})

registerNode({
    type: "plugin.call",
    kind: "map",
    configSchema: {
        plugin: { type: "string", required: true },
        method: { type: "string", required: true },
        args: { type: "array" },
    },
    create: () => ({
        run: ({ config, input, ctx }) => {
            const pluginName = String(config["plugin"])
            const methodName = String(config["method"])

            const plugin = ctx.plugins[pluginName]
            if (plugin === null || typeof plugin !== "object") {
                throw new SignalboxError(`plugin "${pluginName}" is not available`)
            }
            const method = (plugin as Record<string, unknown>)[methodName]
            if (typeof method !== "function") {
                throw new SignalboxError(`"${pluginName}.${methodName}" is not a method`)
            }

            const rawArgs = Array.isArray(config["args"]) ? (config["args"] as unknown[]) : []
            const args = rawArgs.map(arg => ctx.resolve(arg, input))
            return (method as (...callArgs: unknown[]) => unknown)(...args)
        },
    }),
})

registerNode({
    type: "event.emit",
    kind: "map",
    configSchema: {
        event: { type: "string", required: true },
        payload: { type: "object" },
    },
    create: () => ({
        run: ({ config, input, ctx }) => {
            const payload = ctx.resolveDeep(config["payload"] ?? {}, input)
            ctx.emit(String(config["event"]), payload)
            return payload
        },
    }),
})

registerNode({
    type: "map",
    kind: "map",
    configSchema: { value: { type: "object", required: true } },
    create: () => ({
        run: ({ config, input, ctx }) => ctx.resolveDeep(config["value"], input),
    }),
})

registerNode({
    type: "repeat",
    kind: "fork",
    configSchema: { over: { type: "any", required: true }, as: { type: "string" } },
    create: () => ({
        run: ({ config, input, ctx }) => {
            const over = config["over"]
            const resolved = typeof over === "string" ? ctx.resolve(over, input) : over
            const items: unknown[] = Array.isArray(resolved) ? resolved : []
            const as = typeof config["as"] === "string" ? config["as"] : "item"

            const base =
                input !== null && typeof input === "object" && !Array.isArray(input)
                    ? (input as Record<string, unknown>)
                    : {}
            return items.map(item => ({ ...base, [as]: item }))
        },
    }),
})

registerNode({
    type: "dedupe",
    kind: "filter",
    configSchema: { key: { type: "string" } },
    create: () => {
        let last: string | undefined
        return {
            run: ({ config, input, ctx }) => {
                const compared =
                    typeof config["key"] === "string" ? ctx.resolve(`{{ ${config["key"]} }}`, input) : input
                const marker = JSON.stringify(compared ?? null)
                if (marker === last) return false
                last = marker
                return true
            },
        }
    },
})

registerNode({
    type: "log",
    kind: "map",
    configSchema: {
        message: { type: "string", required: true },
        level: { type: "string" },
    },
    create: () => ({
        run: ({ config, input, ctx }) => {
            const level = config["level"] === "warn" || config["level"] === "error" ? config["level"] : "info"
            ctx.log(String(ctx.resolve(config["message"], input)), level)
            return input
        },
    }),
})

registerNode({
    type: "detach",
    kind: "detach",
    configSchema: {},
})
