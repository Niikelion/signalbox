import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
    assertJsonValue,
    decryptSecret,
    deriveKeyId,
    encryptSecret,
    parseEnvelope,
    type JsonValue,
} from "../src/index"

describe("persistent secret cipher", () => {
    const context = { appName: "example", fieldName: "token" }

    it.each<JsonValue>([null, true, 42.5, "héllo", ["one", 2, false], { nested: { enabled: true }, list: [1, 2] }])(
        "round-trips JSON value %#",
        value => {
            const key = randomBytes(32)
            const encrypted = encryptSecret(value, key, context)
            expect(decryptSecret(encrypted, key, context)).toEqual(value)
            expect(parseEnvelope(encrypted).keyId).toBe(deriveKeyId(key))
        },
    )

    it("uses a fresh nonce for every encryption", () => {
        const key = randomBytes(32)
        expect(encryptSecret("same", key, context)).not.toBe(encryptSecret("same", key, context))
    })

    it("authenticates the key, app, field, and envelope bytes", () => {
        const key = randomBytes(32)
        const encrypted = encryptSecret("value", key, context)
        expect(() => decryptSecret(encrypted, randomBytes(32), context)).toThrow("no matching key")
        expect(() => decryptSecret(encrypted, key, { ...context, appName: "other" })).toThrow("authentication failed")
        expect(() => decryptSecret(encrypted, key, { ...context, fieldName: "other" })).toThrow("authentication failed")

        const parts = encrypted.split(":")
        const ciphertext = Buffer.from(parts[4] ?? "", "base64url")
        ciphertext[0] = (ciphertext[0] ?? 0) ^ 1
        parts[4] = ciphertext.toString("base64url")
        expect(() => decryptSecret(parts.join(":"), key, context)).toThrow("authentication failed")
    })

    it.each([
        "enc:",
        "enc:2:key:nonce:cipher:tag",
        "enc:1:key:nonce:cipher:tag",
        `enc:1:${"A".repeat(43)}:AA:AA:AA:extra`,
        `enc:1:${"A".repeat(43)}:***:AA:AA`,
    ])("rejects malformed reserved envelope %s", envelope => {
        expect(() => parseEnvelope(envelope)).toThrow()
    })
})

describe("JSON secret contract", () => {
    it.each([
        undefined,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        -0,
        1n,
        new Date(),
        new Map(),
        new Set(),
        () => undefined,
        Symbol("x"),
        [, "sparse"],
        { value: undefined },
    ])("rejects unsupported value %#", value => {
        expect(() => assertJsonValue(value)).toThrow("not JSON-compatible")
    })

    it("rejects cycles with a useful path", () => {
        const value: Record<string, unknown> = {}
        value["self"] = value
        expect(() => assertJsonValue(value, "apiToken")).toThrow("apiToken.self")
    })
})
