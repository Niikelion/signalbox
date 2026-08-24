const NONE = Symbol("dedupe.none")

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue }

interface RunContext {
    annotate(key: string, value: JsonValue): void
}

/**
 * A stateful filter predicate that passes a value only when its key differs from
 * the previous one. State belongs to the pipeline instance where the predicate is
 * installed.
 * @typeParam T the value type
 * @param key derives the comparison key; defaults to the value itself
 */
export const dedupeBy = <T>(key: (value: T, run: RunContext) => JsonValue = value => value as JsonValue) => {
    let last: string | symbol = NONE
    return (value: T, run: RunContext): boolean => {
        const current = JSON.stringify(key(value, run))
        if (current === last) return false
        last = current
        return true
    }
}
