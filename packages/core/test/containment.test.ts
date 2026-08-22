import { Secret } from "@signalbox/secrets"
import { afterEach, describe, expect, it, vi } from "vitest"

const observed = vi.hoisted(() => ({
    errors: [] as Error[],
    messages: [] as string[],
}))

vi.mock("../src/log.js", async importOriginal => {
    const actual = await importOriginal<typeof import("../src/log.js")>()
    return {
        ...actual,
        attachConsoleLogger: (channel: Parameters<typeof actual.attachConsoleLogger>[0]) => {
            const offLog = channel.on("log", ({ message }) => {
                observed.messages.push(message)
            })
            const offError = channel.on("error", ({ error }) => {
                observed.errors.push(error)
            })
            return () => {
                offLog()
                offError()
            }
        },
    }
})

import { createApp, write } from "../src/index.js"

afterEach(() => {
    observed.errors.length = 0
    observed.messages.length = 0
    vi.restoreAllMocks()
})

describe("framework secret containment", () => {
    it("sanitizes workflow messages and errors before framework subscribers receive them", async () => {
        const secret = Secret.from("subscriber-secret-value")
        const app = createApp({
            name: "containment-test",
            plugins: {},
            workflows: [
                {
                    name: "workflow",
                    setup: ctx => {
                        ctx.log(`message ${secret.reveal()}`)
                        ctx.fail(new Error(`failure ${secret.reveal()}`))
                    },
                },
            ],
        })

        await app.start()
        await app.stop()

        expect(observed.messages).toEqual(["message [redacted]"])
        expect(observed.errors).toHaveLength(1)
        expect(observed.errors[0]?.message).toBe("failure [redacted]")
    })

    it("sanitizes final output using secrets registered by another module evaluation", async () => {
        vi.resetModules()
        const secondCopy = await import("@signalbox/secrets")
        const secret = secondCopy.Secret.from("duplicate-copy-output-secret")
        const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

        write("info", `revealed ${secret.reveal()}`)

        expect(output).toHaveBeenCalledOnce()
        expect(String(output.mock.calls[0]?.[0])).toContain("revealed [redacted]")
        expect(String(output.mock.calls[0]?.[0])).not.toContain("duplicate-copy-output-secret")
    })
})
