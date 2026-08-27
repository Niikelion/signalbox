import { toError, write } from "@/log"
import type {
    ActiveAuthority,
    EntityRef,
    IdentityGrant,
    PermissionClaim,
    PermissionCoreRuntime,
    PermissionExecutionContext,
} from "@signalbox/permissions"

/** A JSON-compatible value. */
export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue }

/** Runtime metadata available to flow callbacks. */
export interface RunContext {
    readonly id: string
    readonly workflowId: string
    readonly correlationId: string
    readonly parentRunId?: string
    readonly causedByRunId?: string
    /** Canonical principal derived from the opaque event identity. */
    readonly principal?: EntityRef
    /** Original authenticated identity when authority was assumed or forwarded. */
    readonly origin?: EntityRef
    annotate(key: string, value: JsonValue): void
}

/** A terminal side effect handler. */
export type EffectHandler<T> = (value: T, run: RunContext) => void | Promise<void>

/** Maps a flow value while preserving the current run. */
export type MapHandler<T, U> = (value: T, run: RunContext) => U | Promise<U>

/** Keeps or filters a flow value while preserving the current run. */
export type FilterHandler<T> = (value: T, run: RunContext) => boolean | Promise<boolean>

/** Splits one run branch into eager joined child runs. */
export type ForkHandler<T, U> = (value: T, run: RunContext) => readonly U[] | Promise<readonly U[]>

export type AuthorityClaimSelector<T> = (value: T, run: RunContext) => PermissionClaim | readonly PermissionClaim[]

export type IdentitySelector<T> = (value: T, run: RunContext) => IdentityGrant

/**
 * A handle onto a shared workflow graph. Calling operators appends graph nodes;
 * branching from the same handle preserves the same root run for each input.
 * @typeParam T the value type
 */
export interface Flow<T> {
    /**
     * Start the workflow graph, calling `handler` for each value that reaches
     * this terminal branch.
     */
    effect(handler: EffectHandler<T>): void
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
    /** Restrict downstream authority to the selected claims. */
    narrow(selector: AuthorityClaimSelector<T>): Flow<T>
    /** Add selected ceiling claims to downstream authority after authorization. */
    elevate(selector: AuthorityClaimSelector<T>): Flow<T>
    /** Replace downstream event identity, still bounded by the workflow ceiling. */
    assume(selector: IdentitySelector<T>): Flow<T>
}

export interface PermissionFlowOptions<T> {
    readonly permissions: PermissionCoreRuntime
    readonly ceiling: ActiveAuthority
    readonly authority: (value: T) => ActiveAuthority | Promise<ActiveAuthority>
    readonly workflowId: string
    readonly subscriptionClaims?: readonly PermissionClaim[]
    readonly sourceOperation?: string
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
    authority?: ActiveAuthority
    ceiling?: ActiveAuthority
    permissions?: PermissionCoreRuntime
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
    | { kind: "narrow"; children: NodeId[]; selector: AuthorityClaimSelector<unknown> }
    | { kind: "elevate"; children: NodeId[]; selector: AuthorityClaimSelector<unknown> }
    | { kind: "assume"; children: NodeId[]; selector: IdentitySelector<unknown> }
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

const contextFor = (item: Item): RunContext => ({
    get id() {
        return item.run.id
    },
    get workflowId() {
        return item.run.workflowId
    },
    get correlationId() {
        return item.run.correlationId
    },
    get parentRunId() {
        return item.run.parentRunId
    },
    get causedByRunId() {
        return item.run.causedByRunId
    },
    get principal() {
        return item.authority?.principal
    },
    get origin() {
        return item.authority?.origin
    },
    annotate: (key, value) => {
        if (!isJsonValue(value)) return
        item.run.annotations[key] = value
    },
})

const executionContext = (item: Item, operation: string): PermissionExecutionContext => ({
    operation,
    requestId: item.run.id,
})

const invoke = <T>(item: Item, operation: string, callback: () => T | Promise<T>): T | Promise<T> =>
    item.permissions && item.authority
        ? item.permissions.run(item.authority, executionContext(item, operation), callback)
        : callback()

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
            const value = await invoke(item, "flow.map", () => node.fn(item.value, contextFor(item)))
            await runChildren(graph, node.children, { ...item, value })
            return
        }
        case "filter":
            if (await invoke(item, "flow.filter", () => node.predicate(item.value, contextFor(item)))) {
                await runChildren(graph, node.children, item)
            }
            return
        case "fork": {
            const values = await invoke(item, "flow.fork", () => node.fn(item.value, contextFor(item)))
            const failures: Error[] = []
            for (const value of values) {
                try {
                    await runChildren(graph, node.children, { ...item, value, run: createChildRun(item.run) })
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
            settle(runChildren(graph, node.children, { ...item, run: createDetachedRun(item.run) }))
            return
        }
        case "narrow": {
            if (!item.permissions || !item.authority) {
                throw new Error("authority narrowing requires a permission-bound flow")
            }
            const claims = await invoke(item, "flow.narrow", () => node.selector(item.value, contextFor(item)))
            const authority = item.permissions.narrow(item.authority, claims, executionContext(item, "flow.narrow"))
            await runChildren(graph, node.children, { ...item, authority })
            return
        }
        case "elevate": {
            if (!item.permissions || !item.authority || !item.ceiling) {
                throw new Error("authority elevation requires a permission-bound flow")
            }
            const claims = await invoke(item, "flow.elevate", () => node.selector(item.value, contextFor(item)))
            const authority = item.permissions.elevate(
                item.authority,
                item.ceiling,
                claims,
                executionContext(item, "flow.elevate"),
            )
            await runChildren(graph, node.children, { ...item, authority })
            return
        }
        case "assume": {
            if (!item.permissions || !item.ceiling) {
                throw new Error("identity assumption requires a permission-bound flow")
            }
            const identity = await invoke(item, "flow.assume", () => node.selector(item.value, contextFor(item)))
            const authority = item.permissions.assume(identity, item.ceiling, executionContext(item, "flow.assume"))
            await runChildren(graph, node.children, { ...item, authority })
            return
        }
        case "effect":
            await invoke(item, "flow.effect", () => node.handler(item.value, contextFor(item)))
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

    narrow(selector: AuthorityClaimSelector<T>): Flow<T> {
        const next = addNode(this.graph, {
            kind: "narrow",
            children: [],
            selector: selector as AuthorityClaimSelector<unknown>,
        })
        connect(this.graph, this.nodeId, next)
        return new FlowHandle<T>(this.graph, next)
    }

    elevate(selector: AuthorityClaimSelector<T>): Flow<T> {
        const next = addNode(this.graph, {
            kind: "elevate",
            children: [],
            selector: selector as AuthorityClaimSelector<unknown>,
        })
        connect(this.graph, this.nodeId, next)
        return new FlowHandle<T>(this.graph, next)
    }

    assume(selector: IdentitySelector<T>): Flow<T> {
        const next = addNode(this.graph, {
            kind: "assume",
            children: [],
            selector: selector as IdentitySelector<unknown>,
        })
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

/** Build a Flow whose root authority is event authority intersected with an app-owned workflow ceiling. */
export const makePermissionFlow = <T>(start: SourceStart<T>, options: PermissionFlowOptions<T>): Flow<T> => {
    const graph = createGraph()
    const nodeId = addNode(graph, { kind: "source", children: [] })
    graph.starters.push({
        started: false,
        start: () => {
            if (options.subscriptionClaims && options.subscriptionClaims.length > 0) {
                options.permissions.authorize(options.ceiling, options.subscriptionClaims, {
                    operation: options.sourceOperation ?? "source.attach",
                })
            }
            start(value => {
                settle(
                    Promise.resolve(options.authority(value)).then(async eventAuthority => {
                        if (options.subscriptionClaims && options.subscriptionClaims.length > 0) {
                            options.permissions.authorize(options.ceiling, options.subscriptionClaims, {
                                operation: options.sourceOperation ?? "source.deliver",
                            })
                        }
                        const authority = options.permissions.intersect(eventAuthority, options.ceiling)
                        const run = createRun({ workflowId: options.workflowId })
                        await runNode(graph, nodeId, {
                            value,
                            run,
                            authority,
                            ceiling: options.ceiling,
                            permissions: options.permissions,
                        })
                    }),
                )
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
