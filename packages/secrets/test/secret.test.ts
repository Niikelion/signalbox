import { describe, expect, it, vi } from "vitest"
import { isSecret, redact, REDACTED, Secret } from "../src/index.js"

describe("Secret", () => {
    it("reveals fresh mutable values and masks every implicit representation", () => {
        const secret = Secret.from({ token: "wrapper-unique-token", scopes: ["read"] })
        const first = secret.reveal()
        first.scopes.push("write")

        expect(secret.reveal()).toEqual({ token: "wrapper-unique-token", scopes: ["read"] })
        expect(secret.reveal()).not.toBe(first)
        expect(secret.redacted).toBe(REDACTED)
        expect(String(secret)).toBe(REDACTED)
        expect(`${secret}`).toBe(REDACTED)
        expect(JSON.stringify(secret)).toBe(JSON.stringify(REDACTED))
        expect(isSecret(secret)).toBe(true)
        expect(isSecret({ reveal: () => "fake" })).toBe(false)
    })

    it("recognizes wrappers after a second module evaluation", async () => {
        const first = Secret.from("cross-copy-secret")
        vi.resetModules()
        const secondCopy = await import("../src/index.js")
        const second = secondCopy.Secret.from("other-cross-copy-secret")
        expect(secondCopy.isSecret(first)).toBe(true)
        expect(isSecret(second)).toBe(true)
        expect(secondCopy.redact("cross-copy-secret and other-cross-copy-secret")).toBe("[redacted] and [redacted]")
    })
})

describe("global redaction", () => {
    it("redacts repeated and overlapping exact strings leftmost-longest", () => {
        Secret.from("abc")
        Secret.from("abcdef")
        Secret.from("cdef")
        expect(redact("abcdef / abc / abcdef")).toBe("[redacted] / [redacted] / [redacted]")
    })

    it("indexes Unicode by code points and ignores strings shorter than three", () => {
        Secret.from("🔑a🔒")
        Secret.from("xy")
        expect(redact("before 🔑a🔒 after xy")).toBe("before [redacted] after xy")
    })

    it("sanitizes wrappers, strings, errors, maps, and cyclic graphs without mutation", () => {
        const secret = Secret.from("nested-super-secret")
        const error = new Error("failed with nested-super-secret", { cause: "nested-super-secret" })
        const input: Record<string, unknown> = {
            wrapper: secret,
            nested: ["prefix nested-super-secret suffix"],
            error,
            map: new Map([["nested-super-secret", secret]]),
        }
        input["self"] = input

        const output = redact(input)
        expect(output).not.toBe(input)
        expect(output["wrapper"]).toBe(REDACTED)
        expect(output["nested"]).toEqual(["prefix [redacted] suffix"])
        expect((output["error"] as Error).message).toBe("failed with [redacted]")
        expect((output["error"] as Error).cause).toBe(REDACTED)
        expect(output["self"]).toBe(output)
        expect(input["wrapper"]).toBe(secret)
    })
})
