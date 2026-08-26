import { Secret } from "@signalbox/secrets"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
    attachConsoleLogger,
    createBus,
    FRAMEWORK_CHANNEL,
    sanitizeError,
    SignalboxError,
    toError,
    write,
} from "@/index"
import type { FrameworkEvents } from "@/index"

afterEach(() => {
    vi.restoreAllMocks()
})

describe("SignalboxError", () => {
    it("should carry a message and optional hint", () => {
        const error = new SignalboxError("failed", "try this")

        expect(error).toBeInstanceOf(Error)
        expect(error.name).toBe("SignalboxError")
        expect(error.message).toBe("failed")
        expect(error.hint).toBe("try this")
    })
})

describe("toError", () => {
    it("should return Error values unchanged", () => {
        const error = new Error("failed")

        expect(toError(error)).toBe(error)
    })

    it("should wrap non-Error values", () => {
        expect(toError("failed").message).toBe("failed")
    })
})

describe("sanitizeError", () => {
    it("should redact registered secrets from error messages", () => {
        const secret = Secret.from("sanitize-secret")

        expect(sanitizeError(new Error(`value ${secret.reveal()}`)).message).toBe("value [redacted]")
    })
})

describe("write", () => {
    it("should write non-error messages to stdout", () => {
        const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
        const errorOutput = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

        write("info", "hello")

        expect(output).toHaveBeenCalledOnce()
        expect(String(output.mock.calls[0]?.[0])).toContain("hello")
        expect(errorOutput).not.toHaveBeenCalled()
    })

    it("should write error messages to stderr", () => {
        const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
        const errorOutput = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

        write("error", "failed")

        expect(errorOutput).toHaveBeenCalledOnce()
        expect(String(errorOutput.mock.calls[0]?.[0])).toContain("failed")
        expect(output).not.toHaveBeenCalled()
    })

    it("should redact registered secrets from output", () => {
        const secret = Secret.from("output-secret")
        const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

        write("info", `revealed ${secret.reveal()}`)

        expect(String(output.mock.calls[0]?.[0])).toContain("revealed [redacted]")
        expect(String(output.mock.calls[0]?.[0])).not.toContain("output-secret")
    })
})

describe("attachConsoleLogger", () => {
    it("should write framework log and error events until detached", () => {
        const channel = createBus().channel<FrameworkEvents>(FRAMEWORK_CHANNEL)
        const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
        const errorOutput = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

        const detach = attachConsoleLogger(channel)
        channel.emit("log", { level: "info", message: "message", scope: "scope" })
        channel.emit("error", { scope: "scope", error: new Error("failed") })
        detach()
        channel.emit("log", { level: "info", message: "ignored", scope: "scope" })

        expect(String(output.mock.calls[0]?.[0])).toContain("[scope] message")
        expect(String(errorOutput.mock.calls[0]?.[0])).toContain("[scope] failed")
        expect(output).toHaveBeenCalledOnce()
    })
})
