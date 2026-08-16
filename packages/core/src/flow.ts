import { toError, write } from "./log.js"

export type FlowSink<T> = (value: T) => void | Promise<void>

export type Operator<T, U> = (emit: (value: U) => void) => (value: T) => void | Promise<void>

export interface Flow<T> {
    map<U>(fn: (value: T) => U): Flow<U>
    filter(predicate: (value: T) => boolean): Flow<T>
    apply<U>(operator: Operator<T, U>): Flow<U>
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

export const makeFlow = <T>(start: Start<T>): Flow<T> => ({
    map: (fn) =>
        makeFlow((emit) => {
            start((value) => {
                emit(fn(value))
            })
        }),
    filter: (predicate) =>
        makeFlow((emit) => {
            start((value) => {
                if (predicate(value)) emit(value)
            })
        }),
    apply: (operator) =>
        makeFlow((emit) => {
            const step = operator(emit)
            start((value) => {
                settle(step(value))
            })
        }),
    run: (sink) => {
        start((value) => {
            settle(sink(value))
        })
    },
})

export const merge = <T>(...flows: Flow<T>[]): Flow<T> =>
    makeFlow((emit) => {
        for (const flow of flows) flow.run(emit)
    })
