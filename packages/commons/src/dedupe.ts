import type { Operator } from "@signalbox/core"

export const dedupe =
    <T>(key: (value: T) => unknown = (value) => value): Operator<T, T> =>
    (emit) => {
        let last: string | undefined
        return (value) => {
            const marker = JSON.stringify(key(value) ?? null)
            if (marker === last) return
            last = marker
            emit(value)
        }
    }
