export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

const fail = (path: string, reason: string): never => {
    throw new TypeError(`${path} is not JSON-compatible: ${reason}`)
}

const validate = (value: unknown, path: string, ancestors: Set<object>): void => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return
    if (typeof value === "number") {
        if (!Number.isFinite(value)) fail(path, "numbers must be finite")
        if (Object.is(value, -0)) fail(path, "-0 does not round-trip through JSON")
        return
    }
    if (typeof value !== "object") return fail(path, `unsupported ${typeof value} value`)
    if (ancestors.has(value)) fail(path, "cyclic value")

    ancestors.add(value)
    try {
        if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index += 1) {
                if (!(index in value)) fail(`${path}[${index}]`, "sparse array entry")
                validate(value[index], `${path}[${index}]`, ancestors)
            }
            return
        }

        const prototype = Object.getPrototypeOf(value) as unknown
        if (prototype !== Object.prototype && prototype !== null) {
            fail(path, `unsupported ${(value as { constructor?: { name?: string } }).constructor?.name ?? "object"}`)
        }
        if (Object.getOwnPropertySymbols(value).length > 0) fail(path, "symbol-keyed properties are unsupported")
        for (const key of Object.keys(value)) {
            validate((value as Record<string, unknown>)[key], `${path}.${key}`, ancestors)
        }
    } finally {
        ancestors.delete(value)
    }
}

/** Assert that a value can be encoded and decoded without JSON coercions. */
export function assertJsonValue(value: unknown, path = "secret"): asserts value is JsonValue {
    validate(value, path, new Set())
}

/** Validate and encode a JSON-compatible secret as UTF-8. */
export const encodeJsonValue = (value: unknown, path = "secret"): Uint8Array => {
    assertJsonValue(value, path)
    return Buffer.from(JSON.stringify(value), "utf8")
}

/** Decode UTF-8 JSON and verify that it satisfies the secret value contract. */
export const decodeJsonValue = (bytes: Uint8Array, path = "secret"): JsonValue => {
    let value: unknown
    try {
        value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown
    } catch (error) {
        throw new TypeError(`${path} is not valid JSON: ${(error as Error).message}`)
    }
    assertJsonValue(value, path)
    return value
}
