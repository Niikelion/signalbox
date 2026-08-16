import type { Operator } from "@signalbox/core"

const NONE = Symbol("dedupe.none")

export const dedupe =
    <T>(key: (value: T) => unknown = (value) => value): Operator<T, T> =>
    (emit) => {
        let last: unknown = NONE
        return (value) => {
            const current = key(value)
            if (current === last) return
            last = current
            emit(value)
        }
    }
