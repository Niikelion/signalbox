import type { Operator } from "@signalbox/core"

const NONE = Symbol("dedupe.none")

/**
 * A flow operator that forwards a value only when its key differs from the previous
 * one (compared with `===`).
 * @typeParam T the value type
 * @param key derives the comparison key; defaults to the value itself
 */
export const dedupe =
    <T>(key: (value: T) => unknown = value => value): Operator<T, T> =>
    emit => {
        let last: unknown = NONE
        return value => {
            const current = key(value)
            if (current === last) return
            last = current
            emit(value)
        }
    }
