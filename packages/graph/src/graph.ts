import {
    FlowKitError,
    toError,
    type EventMap,
    type LogLevel,
    type Unsubscribe,
    type WorkflowDefinition,
} from "@signalbox/core"

export interface WorkflowGraph {
    name: string
    nodes: GraphNode[]
    edges: GraphEdge[]
}

export interface GraphNode {
    id: string
    type: string
    config?: Record<string, unknown>
}

export interface GraphEdge {
    from: string
    to: string
}

export type ConfigFieldType = "string" | "number" | "boolean" | "array" | "object" | "any"

export interface ConfigField {
    type: ConfigFieldType
    required?: boolean
}

export type NodeConfigSchema = Record<string, ConfigField>

export interface GraphNodeContext {
    plugins: Record<string, unknown>
    on: (event: string, listener: (payload: unknown) => void) => Unsubscribe
    emit: (event: string, payload: unknown) => void
    log: (message: string, level?: LogLevel) => void
    fail: (error: unknown) => void
    onStop: (cleanup: () => void | Promise<void>) => void
    interval: (ms: number, handler: () => void | Promise<void>) => void
    resolve: (template: unknown, input: unknown) => unknown
    resolveDeep: (template: unknown, input: unknown) => unknown
}

export interface TriggerInstance {
    start: (args: { config: Record<string, unknown>; ctx: GraphNodeContext; push: (value: unknown) => void }) => void
}

export interface TriggerNodeType {
    type: string
    kind: "trigger"
    configSchema: NodeConfigSchema
    create: () => TriggerInstance
}

export const STOP: unique symbol = Symbol("flowkit.graph.stop")

const FAN_OUT: unique symbol = Symbol("flowkit.graph.fanout")

export interface FanOut {
    readonly [FAN_OUT]: true
    readonly values: readonly unknown[]
}

export const fanOut = (values: readonly unknown[]): FanOut => ({ [FAN_OUT]: true, values })

export const isFanOut = (value: unknown): value is FanOut =>
    typeof value === "object" && value !== null && (value as Record<PropertyKey, unknown>)[FAN_OUT] === true

export interface ActionInstance {
    run: (args: { config: Record<string, unknown>; input: unknown; ctx: GraphNodeContext }) => unknown
}

export interface ActionNodeType {
    type: string
    kind: "action"
    configSchema: NodeConfigSchema
    create: () => ActionInstance
}

export type NodeType = TriggerNodeType | ActionNodeType

export interface NodeRegistry {
    register: (type: NodeType) => void
    get: (type: string) => NodeType | undefined
    list: () => string[]
}

export const createNodeRegistry = (): NodeRegistry => {
    const types = new Map<string, NodeType>()
    return {
        register: (type) => {
            types.set(type.type, type)
        },
        get: (type) => types.get(type),
        list: () => [...types.keys()],
    }
}

export const defaultRegistry = createNodeRegistry()

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

export interface ResolveScope {
    input: unknown
    config?: Record<string, unknown>
    secret?: Record<string, unknown>
}

const lookup = (path: string, scope: ResolveScope): unknown => {
    if (path === "$input") return scope.input
    if (path.startsWith("$config.")) return getPath(scope.config, path.slice("$config.".length))
    if (path.startsWith("$secret.")) return getPath(scope.secret, path.slice("$secret.".length))
    return getPath(scope.input, path.startsWith("input.") ? path.slice("input.".length) : path)
}

export const resolveTemplate = (template: unknown, scope: ResolveScope): unknown => {
    if (typeof template !== "string") return template

    const whole = /^\{\{\s*([\w.$]+)\s*\}\}$/.exec(template)
    if (whole?.[1]) return lookup(whole[1], scope)

    return template.replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (_match, path: string) => stringify(lookup(path, scope)))
}

export const resolveDeep = (template: unknown, scope: ResolveScope): unknown => {
    if (typeof template === "string") return resolveTemplate(template, scope)
    if (Array.isArray(template)) return template.map((item) => resolveDeep(item, scope))
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
        throw new FlowKitError(`node "${node.id}" (${node.type}): ${problems.join(", ")}`)
    }
}

export interface CompileOptions {
    registry?: NodeRegistry
    config?: Record<string, unknown>
    secrets?: Record<string, unknown>
}

const makeRedactor = (secrets: Record<string, unknown>): ((message: string) => string) => {
    const values = Object.values(secrets).filter(
        (value): value is string => typeof value === "string" && value.length > 0,
    )
    if (values.length === 0) return (message) => message
    return (message) => values.reduce((current, secret) => current.split(secret).join("***"), message)
}

export const compileGraph = <TEvents extends EventMap = EventMap, TPlugins = Record<string, unknown>>(
    graph: WorkflowGraph,
    options: CompileOptions = {},
): WorkflowDefinition<TEvents, TPlugins> => {
    const registry = options.registry ?? defaultRegistry
    const config = options.config ?? {}
    const secrets = options.secrets ?? {}
    const redact = makeRedactor(secrets)

    const nodeById = new Map<string, GraphNode>()
    for (const node of graph.nodes) {
        const type = registry.get(node.type)
        if (!type) {
            throw new FlowKitError(
                `unknown node type "${node.type}" (node "${node.id}")`,
                `registered types: ${registry.list().join(", ")}`,
            )
        }
        validateConfig(node, type.configSchema)
        nodeById.set(node.id, node)
    }

    const downstream = new Map<string, string[]>()
    for (const edge of graph.edges) {
        if (!nodeById.has(edge.from)) throw new FlowKitError(`edge from unknown node "${edge.from}"`)
        if (!nodeById.has(edge.to)) throw new FlowKitError(`edge to unknown node "${edge.to}"`)
        downstream.set(edge.from, [...(downstream.get(edge.from) ?? []), edge.to])
    }

    return {
        name: graph.name,
        setup: (ctx) => {
            const nodeCtx: GraphNodeContext = {
                plugins: ctx.plugins as Record<string, unknown>,
                on: (event, listener) => ctx.on(event as never, listener),
                emit: (event, payload) => {
                    ctx.emit(event as never, payload as never)
                },
                log: (message, level) => {
                    ctx.log(redact(message), level)
                },
                fail: ctx.fail,
                onStop: ctx.onStop,
                interval: ctx.interval,
                resolve: (template, input) => resolveTemplate(template, { input, config, secret: secrets }),
                resolveDeep: (template, input) => resolveDeep(template, { input, config, secret: secrets }),
            }

            const actions = new Map<string, ActionInstance>()
            for (const node of graph.nodes) {
                const type = registry.get(node.type)
                if (type?.kind === "action") actions.set(node.id, type.create())
            }

            const runFrom = async (nodeId: string, value: unknown): Promise<void> => {
                for (const nextId of downstream.get(nodeId) ?? []) {
                    const node = nodeById.get(nextId)
                    const action = actions.get(nextId)
                    if (!node || !action) continue

                    try {
                        const output = await action.run({ config: node.config ?? {}, input: value, ctx: nodeCtx })
                        if (output === STOP) continue
                        if (isFanOut(output)) {
                            for (const each of output.values) await runFrom(nextId, each)
                            continue
                        }
                        await runFrom(nextId, output)
                    } catch (error) {
                        nodeCtx.fail(toError(error))
                    }
                }
            }

            for (const node of graph.nodes) {
                const type = registry.get(node.type)
                if (type?.kind !== "trigger") continue
                type.create().start({
                    config: node.config ?? {},
                    ctx: nodeCtx,
                    push: (value) => {
                        void runFrom(node.id, value)
                    },
                })
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
            ctx.on(String(config["event"]), (payload) => {
                push(payload)
            })
        },
    }),
})

registerNode({
    type: "plugin.call",
    kind: "action",
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
                throw new FlowKitError(`plugin "${pluginName}" is not available`)
            }
            const method = (plugin as Record<string, unknown>)[methodName]
            if (typeof method !== "function") {
                throw new FlowKitError(`"${pluginName}.${methodName}" is not a method`)
            }

            const rawArgs = Array.isArray(config["args"]) ? (config["args"] as unknown[]) : []
            const args = rawArgs.map((arg) => ctx.resolve(arg, input))
            return (method as (...callArgs: unknown[]) => unknown)(...args)
        },
    }),
})

registerNode({
    type: "event.emit",
    kind: "action",
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
    kind: "action",
    configSchema: { value: { type: "object", required: true } },
    create: () => ({
        run: ({ config, input, ctx }) => ctx.resolveDeep(config["value"], input),
    }),
})

registerNode({
    type: "repeat",
    kind: "action",
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
            return fanOut(items.map((item) => ({ ...base, [as]: item })))
        },
    }),
})

registerNode({
    type: "dedupe",
    kind: "action",
    configSchema: { key: { type: "string" } },
    create: () => {
        let last: string | undefined
        return {
            run: ({ config, input, ctx }) => {
                const compared =
                    typeof config["key"] === "string" ? ctx.resolve(`{{ ${config["key"]} }}`, input) : input
                const marker = JSON.stringify(compared ?? null)
                if (marker === last) return STOP
                last = marker
                return input
            },
        }
    },
})

registerNode({
    type: "log",
    kind: "action",
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
