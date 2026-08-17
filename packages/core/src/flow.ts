import { toError, write } from "./log.js"

/**
 * A terminal consumer of a flow's values.
 * @typeParam T the value type
 */
export type FlowSink<T> = (value: T) => void | Promise<void>

/**
 * A stateful flow operator: given a downstream `emit`, returns a per-value step that
 * may emit zero, one, or many values. State lives in the closure.
 * @typeParam T the input value type
 * @typeParam U the output value type
 */
export type Operator<T, U> = (emit: (value: U) => void) => (value: T) => void | Promise<void>

/**
 * A lazy push stream. Nothing runs until {@link Flow.run}; each `run` re-subscribes (unicast).
 * @typeParam T the value type
 */
export interface Flow<T> {
    /**
     * Transform each value.
     * @typeParam U the output type
     * @param fn the mapping
     */
    map<U>(fn: (value: T) => U): Flow<U>
    /**
     * Keep only values that pass the type guard, narrowing the value type.
     * @typeParam S the narrowed type
     * @param predicate the type guard
     */
    filter<S extends T>(predicate: (value: T) => value is S): Flow<S>
    /**
     * Keep only values that pass the predicate.
     * @param predicate the test
     */
    filter(predicate: (value: T) => boolean): Flow<T>
    /**
     * Apply a stateful operator (one value in, zero or more out).
     * @typeParam U the output type
     * @param operator the operator
     */
    apply<U>(operator: Operator<T, U>): Flow<U>
    /**
     * Start the flow, calling `sink` for each value. Terminal.
     * @param sink the consumer
     */
    run(sink: FlowSink<T>): void
}

type Start<T> = (emit: (value: T) => void) => void

const settle = (result: void | Promise<void>): void => {
    if (result instanceof Promise) {
        result.catch((error: unknown) => {
            write("error", `[flow] ${toError(error).message}`)
        })
    }
}

/**
 * Build a flow from a start function that pushes values into a downstream `emit`.
 * @typeParam T the value type
 * @param start wires the source to a downstream emit when the flow is run
 */
export const makeFlow = <T>(start: Start<T>): Flow<T> => {
    const flow = {
        map: <U>(fn: (value: T) => U): Flow<U> =>
            makeFlow((emit) => {
                start((value) => {
                    emit(fn(value))
                })
            }),
        filter: (predicate: (value: T) => boolean): Flow<T> =>
            makeFlow((emit) => {
                start((value) => {
                    if (predicate(value)) emit(value)
                })
            }),
        apply: <U>(operator: Operator<T, U>): Flow<U> =>
            makeFlow((emit) => {
                const step = operator(emit)
                start((value) => {
                    settle(step(value))
                })
            }),
        run: (sink: FlowSink<T>): void => {
            start((value) => {
                settle(sink(value))
            })
        },
    }
    // `filter`'s implementation is one function serving both overloads; the cast bridges it.
    return flow as Flow<T>
}

/**
 * Merge several flows into one, interleaving all their values.
 * @typeParam T the value type
 * @param flows the flows to merge
 */
export const merge = <T>(...flows: Flow<T>[]): Flow<T> =>
    makeFlow((emit) => {
        for (const flow of flows) flow.run(emit)
    })
