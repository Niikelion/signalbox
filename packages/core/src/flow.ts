import { toError, write } from "./log.js"

/** A JSON-compatible value. */
export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue }

/** Runtime metadata available to flow callbacks. */
export interface RunContext {
    readonly id: string
    readonly workflowId: string
    readonly correlationId: string
    readonly parentRunId?: string
    readonly causedByRunId?: string
    annotate(key: string, value: JsonValue): void
}

/** A terminal side-effect handler. */
export type EffectHandler<T> = (value: T, run: RunContext) => void | Promise<void>

/** Maps a flow value while preserving the current run. */
export type MapHandler<T, U> = (value: T, run: RunContext) => U | Promise<U>

/** Keeps or filters a flow value while preserving the current run. */
export type FilterHandler<T> = (value: T, run: RunContext) => boolean | Promise<boolean>

/** Splits one run branch into eager joined child runs. */
export type ForkHandler<T, U> = (value: T, run: RunContext) => readonly U[] | Promise<readonly U[]>

/**
 * A handle onto a shared workflow graph. Calling operators appends graph nodes;
 * branching from the same handle preserves the same root run for each input.
 * @typeParam T the value type
 */
export interface Flow<T> {
    /**
     * Transform each value.
     * @typeParam U the output type
     * @param fn the mapping
     */
    map<U>(fn: MapHandler<T, U>): Flow<U>
    /**
     * Keep only values that pass the type guard, narrowing the value type.
     * @typeParam S the narrowed type
     */
    filter<S extends T>(predicate: (value: T, run: RunContext) => value is S): Flow<S>
    /**
     * Keep only values that pass the predicate. A false result closes the branch
     * as filtered.
     */
    filter(predicate: FilterHandler<T>): Flow<T>
    /**
     * Eagerly create joined child runs from the returned values.
     * @typeParam U the child value type
     */
    fork<U>(fn: ForkHandler<T, U>): Flow<U>
    /** Continue downstream work in a detached run that no longer affects the parent. */
    detach(): Flow<T>
    /**
     * Start the workflow graph, calling `handler` for each value that reaches
     * this terminal branch.
     */
    effect(handler: EffectHandler<T>): void
}

interface MutableRunState {
    id: string
    workflowId: string
    correlationId: string
    parentRunId?: string
    causedByRunId?: string
    annotations: Record<string, JsonValue>
}

interface Item<T = unknown> {
    value: T
    run: MutableRunState
}

type SourceStart<T> = (emit: (value: T) => void) => void
type Starter = { started: boolean; start: () => void }
type NodeId = number

type RuntimeNode =
    | { kind: "source"; children: NodeId[] }
    | { kind: "pass"; children: NodeId[] }
    | { kind: "map"; children: NodeId[]; fn: MapHandler<unknown, unknown> }
    | { kind: "filter"; children: NodeId[]; predicate: FilterHandler<unknown> }
    | { kind: "fork"; children: NodeId[]; fn: ForkHandler<unknown, unknown> }
    | { kind: "detach"; children: NodeId[] }
    | { kind: "effect"; handler: EffectHandler<unknown> }
    | { kind: "bridge"; handler: (item: Item) => void | Promise<void> }

interface RuntimeGraph {
    nodes: Map<NodeId, RuntimeNode>
    starters: Starter[]
    nextNodeId: number
}

let nextRunId = 0

const createGraph = (): RuntimeGraph => ({
    nodes: new Map(),
    starters: [],
    nextNodeId: 0,
})

const addNode = (graph: RuntimeGraph, node: RuntimeNode): NodeId => {
    const id = graph.nextNodeId++
    graph.nodes.set(id, node)
    return id
}

const childrenOf = (node: RuntimeNode): NodeId[] => ("children" in node ? node.children : [])

const connect = (graph: RuntimeGraph, from: NodeId, to: NodeId): void => {
    const node = graph.nodes.get(from)
    if (!node) return
    childrenOf(node).push(to)
}

const createRun = (options: {
    workflowId?: string
    correlationId?: string
    parentRunId?: string
    causedByRunId?: string
}): MutableRunState => {
    const id = `run-${String(++nextRunId)}`
    return {
        id,
        workflowId: options.workflowId ?? "workflow",
        correlationId: options.correlationId ?? id,
        parentRunId: options.parentRunId,
        causedByRunId: options.causedByRunId,
        annotations: {},
    }
}

const createChildRun = (parent: MutableRunState): MutableRunState =>
    createRun({
        workflowId: parent.workflowId,
        correlationId: parent.correlationId,
        parentRunId: parent.id,
        causedByRunId: parent.id,
    })

const createDetachedRun = (parent: MutableRunState): MutableRunState =>
    createRun({
        workflowId: parent.workflowId,
        correlationId: parent.correlationId,
        causedByRunId: parent.id,
    })

const isJsonValue = (value: unknown): value is JsonValue => {
    if (value === null) return true
    switch (typeof value) {
        case "string":
        case "boolean":
            return true
        case "number":
            return Number.isFinite(value)
        case "object":
            if (Array.isArray(value)) return value.every(isJsonValue)
            return Object.values(value as Record<string, unknown>).every(isJsonValue)
        default:
            return false
    }
}

const contextFor = (run: MutableRunState): RunContext => ({
    get id() {
        return run.id
    },
    get workflowId() {
        return run.workflowId
    },
    get correlationId() {
        return run.correlationId
    },
    get parentRunId() {
        return run.parentRunId
    },
    get causedByRunId() {
        return run.causedByRunId
    },
    annotate: (key, value) => {
        if (!isJsonValue(value)) return
        run.annotations[key] = value
    },
})

const settle = (result: void | Promise<void>): void => {
    if (result instanceof Promise) {
        result.catch((error: unknown) => {
            write("error", `[flow] ${toError(error).message}`)
        })
    }
}

const runChildren = async (graph: RuntimeGraph, children: readonly NodeId[], item: Item): Promise<void> => {
    const failures: Error[] = []
    for (const child of children) {
        try {
            await runNode(graph, child, item)
        } catch (error) {
            failures.push(toError(error))
        }
    }
    if (failures.length > 0) {
        throw new Error(`${String(failures.length)} of ${String(children.length)} flow branches failed`)
    }
}

const runNode = async (graph: RuntimeGraph, nodeId: NodeId, item: Item): Promise<void> => {
    const node = graph.nodes.get(nodeId)
    if (!node) return

    switch (node.kind) {
        case "source":
        case "pass":
            await runChildren(graph, node.children, item)
            return
        case "map": {
            const value = await node.fn(item.value, contextFor(item.run))
            await runChildren(graph, node.children, { value, run: item.run })
            return
        }
        case "filter":
            if (await node.predicate(item.value, contextFor(item.run))) {
                await runChildren(graph, node.children, item)
            }
            return
        case "fork": {
            const values = await node.fn(item.value, contextFor(item.run))
            const failures: Error[] = []
            for (const value of values) {
                try {
                    await runChildren(graph, node.children, { value, run: createChildRun(item.run) })
                } catch (error) {
                    failures.push(toError(error))
                }
            }
            if (failures.length > 0) {
                throw new Error(`${String(failures.length)} of ${String(values.length)} joined child runs failed`)
            }
            return
        }
        case "detach": {
            settle(runChildren(graph, node.children, { value: item.value, run: createDetachedRun(item.run) }))
            return
        }
        case "effect":
            await node.handler(item.value, contextFor(item.run))
            return
        case "bridge":
            await node.handler(item)
            return
    }
}

const startGraph = (graph: RuntimeGraph): void => {
    for (const starter of graph.starters) {
        if (starter.started) continue
        starter.started = true
        starter.start()
    }
}

class FlowHandle<T> implements Flow<T> {
    constructor(
        private readonly graph: RuntimeGraph,
        private readonly nodeId: NodeId,
    ) {}

    map<U>(fn: MapHandler<T, U>): Flow<U> {
        const next = addNode(this.graph, { kind: "map", children: [], fn: fn as MapHandler<unknown, unknown> })
        connect(this.graph, this.nodeId, next)
        return new FlowHandle<U>(this.graph, next)
    }

    filter<S extends T>(predicate: (value: T, run: RunContext) => value is S): Flow<S>
    filter(predicate: FilterHandler<T>): Flow<T>
    filter(predicate: FilterHandler<T>): Flow<T> {
        const next = addNode(this.graph, {
            kind: "filter",
            children: [],
            predicate: predicate as FilterHandler<unknown>,
        })
        connect(this.graph, this.nodeId, next)
        return new FlowHandle<T>(this.graph, next)
    }

    fork<U>(fn: ForkHandler<T, U>): Flow<U> {
        const next = addNode(this.graph, { kind: "fork", children: [], fn: fn as ForkHandler<unknown, unknown> })
        connect(this.graph, this.nodeId, next)
        return new FlowHandle<U>(this.graph, next)
    }

    detach(): Flow<T> {
        const next = addNode(this.graph, { kind: "detach", children: [] })
        connect(this.graph, this.nodeId, next)
        return new FlowHandle<T>(this.graph, next)
    }

    effect(handler: EffectHandler<T>): void {
        const next = addNode(this.graph, { kind: "effect", handler: handler as EffectHandler<unknown> })
        connect(this.graph, this.nodeId, next)
        startGraph(this.graph)
    }

    mountInto(targetGraph: RuntimeGraph, targetNodeId: NodeId): void {
        const bridge = addNode(this.graph, {
            kind: "bridge",
            handler: item => runNode(targetGraph, targetNodeId, item),
        })
        connect(this.graph, this.nodeId, bridge)
        startGraph(this.graph)
    }
}

/**
 * Build a flow from a source function that pushes values into the workflow graph.
 * Each emitted value creates one root run for the graph rooted at this source.
 */
export const makeFlow = <T>(start: SourceStart<T>): Flow<T> => {
    const graph = createGraph()
    const nodeId = addNode(graph, { kind: "source", children: [] })
    graph.starters.push({
        started: false,
        start: () => {
            start(value => {
                const run = createRun({})
                settle(runNode(graph, nodeId, { value, run }))
            })
        },
    })
    return new FlowHandle<T>(graph, nodeId)
}

/**
 * Share one downstream pipeline suffix across several entrypoint flows. Runs stay
 * independent; callbacks and operator instances after `combine` are shared.
 */
export const combine = <T>(...flows: Flow<T>[]): Flow<T> => {
    const graph = createGraph()
    const combined = addNode(graph, { kind: "pass", children: [] })

    graph.starters.push(
        ...flows.map(flow => ({
            started: false,
            start: () => {
                if (flow instanceof FlowHandle) flow.mountInto(graph, combined)
            },
        })),
    )

    return new FlowHandle<T>(graph, combined)
}
