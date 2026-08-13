import {
    FlowKitError,
    toError,
    type EventMap,
    type LogLevel,
    type Unsubscribe,
    type WorkflowDefinition,
} from "@flowkit/core"

/**
 * A workflow, expressed as data instead of a function.
 *
 * `compileGraph` turns one of these into an ordinary `WorkflowDefinition` whose
 * `setup` makes the very same `ctx.on` / `ctx.emit` / `ctx.plugins.x` calls a
 * hand-written workflow would. The bus, the app runtime and teardown are
 * unchanged — a compiled graph is indistinguishable from coded one at runtime.
 * The trade is that a graph is validated when it loads, not by the compiler.
 */
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

// --- node types -----------------------------------------------------------

export type ConfigFieldType = "string" | "number" | "boolean" | "array" | "object"

export interface ConfigField {
    type: ConfigFieldType
    required?: boolean
}

export type NodeConfigSchema = Record<string, ConfigField>

/**
 * The slice of a workflow's context a node is handed. Event names are strings
 * here rather than `keyof TEvents`: a graph is dynamic, so this is exactly the
 * boundary where type-checking gives way to load-time validation.
 */
export interface GraphNodeContext {
    plugins: Record<string, unknown>
    on: (event: string, listener: (payload: unknown) => void) => Unsubscribe
    emit: (event: string, payload: unknown) => void
    log: (message: string, level?: LogLevel) => void
    fail: (error: unknown) => void
    onStop: (cleanup: () => void | Promise<void>) => void
    interval: (ms: number, handler: () => void | Promise<void>) => void
}

export interface TriggerNodeType {
    type: string
    kind: "trigger"
    configSchema: NodeConfigSchema
    /** Wire up a source; call `push` with a value to start a flow downstream. */
    start: (args: { config: Record<string, unknown>; ctx: GraphNodeContext; push: (value: unknown) => void }) => void
}

export interface ActionNodeType {
    type: string
    kind: "action"
    configSchema: NodeConfigSchema
    /**
     * Transform the value flowing in; whatever is returned flows downstream.
     * May be sync or async — the compiler awaits the result either way.
     */
    run: (args: { config: Record<string, unknown>; input: unknown; ctx: GraphNodeContext }) => unknown
}

export type NodeType = TriggerNodeType | ActionNodeType

// --- registry -------------------------------------------------------------

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

/** The registry the built-in nodes register into and `compileGraph` defaults to. */
export const defaultRegistry = createNodeRegistry()

export const registerNode = (type: NodeType): void => {
    defaultRegistry.register(type)
}

// --- data mapping ---------------------------------------------------------

const getPath = (source: unknown, path: string): unknown => {
    let current = source
    for (const key of path.split(".")) {
        if (current === null || typeof current !== "object") return undefined
        current = (current as Record<string, unknown>)[key]
    }
    return current
}

/** Render a resolved value for embedding in a string; objects become JSON. */
const stringify = (value: unknown): string => {
    if (value === undefined || value === null) return ""
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value.toString()
    return JSON.stringify(value)
}

/**
 * Resolve `{{ path }}` references against the value flowing into a node.
 * A whole-string reference keeps the resolved value's type (so a number stays a
 * number); references embedded in text interpolate as strings. Field references
 * only — deliberately not an expression language yet.
 */
export const resolveTemplate = (template: unknown, input: unknown): unknown => {
    if (typeof template !== "string") return template

    const whole = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(template)
    if (whole?.[1]) return getPath(input, whole[1])

    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => stringify(getPath(input, path)))
}

// --- validation -----------------------------------------------------------

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

// --- compiler -------------------------------------------------------------

/**
 * Compile a graph into a `WorkflowDefinition`. Validation happens here, at load
 * time: an unknown node type, a bad config field or a dangling edge throws a
 * `FlowKitError` before the definition is ever handed to an app.
 */
export const compileGraph = <TEvents extends EventMap = EventMap, TPlugins = Record<string, unknown>>(
    graph: WorkflowGraph,
    registry: NodeRegistry = defaultRegistry,
): WorkflowDefinition<TEvents, TPlugins> => {
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
            /*
             * The one place the graph steps outside the type system: event names
             * arrive as strings, so the typed `on`/`emit` are re-viewed as loose
             * functions. Everything downstream of here is validated, not checked.
             */
            const nodeCtx: GraphNodeContext = {
                plugins: ctx.plugins as Record<string, unknown>,
                on: (event, listener) => ctx.on(event as never, listener),
                emit: (event, payload) => {
                    ctx.emit(event as never, payload as never)
                },
                log: ctx.log,
                fail: ctx.fail,
                onStop: ctx.onStop,
                interval: ctx.interval,
            }

            const runFrom = async (nodeId: string, value: unknown): Promise<void> => {
                for (const nextId of downstream.get(nodeId) ?? []) {
                    const node = nodeById.get(nextId)
                    if (!node) continue
                    const type = registry.get(node.type)
                    if (type?.kind !== "action") continue

                    try {
                        const output = await type.run({ config: node.config ?? {}, input: value, ctx: nodeCtx })
                        await runFrom(nextId, output)
                    } catch (error) {
                        nodeCtx.fail(toError(error))
                    }
                }
            }

            for (const node of graph.nodes) {
                const type = registry.get(node.type)
                if (type?.kind !== "trigger") continue
                type.start({
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

// --- built-in nodes -------------------------------------------------------

registerNode({
    type: "event.on",
    kind: "trigger",
    configSchema: { event: { type: "string", required: true } },
    start: ({ config, ctx, push }) => {
        ctx.on(String(config["event"]), (payload) => {
            push(payload)
        })
    },
})

registerNode({
    type: "plugin.call",
    kind: "action",
    configSchema: {
        plugin: { type: "string", required: true },
        method: { type: "string", required: true },
        args: { type: "array" },
    },
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
        const args = rawArgs.map((arg) => resolveTemplate(arg, input))
        return (method as (...callArgs: unknown[]) => unknown)(...args)
    },
})

registerNode({
    type: "event.emit",
    kind: "action",
    configSchema: {
        event: { type: "string", required: true },
        payload: { type: "object" },
    },
    run: ({ config, input, ctx }) => {
        const template = (config["payload"] ?? {}) as Record<string, unknown>
        const payload: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(template)) payload[key] = resolveTemplate(value, input)
        ctx.emit(String(config["event"]), payload)
        return payload
    },
})

registerNode({
    type: "log",
    kind: "action",
    configSchema: {
        message: { type: "string", required: true },
        level: { type: "string" },
    },
    run: ({ config, input, ctx }) => {
        const level = config["level"] === "warn" || config["level"] === "error" ? config["level"] : "info"
        ctx.log(String(resolveTemplate(config["message"], input)), level)
        return input // pass the value through unchanged
    },
})
