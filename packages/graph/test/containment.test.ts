import { createBus, type EventMap, type WorkflowContext } from "@signalbox/core"
import { Secret } from "@signalbox/secrets"
import { describe, expect, it } from "vitest"
import { compileGraph, createNodeRegistry, type GraphNodeContext } from "../src/index.js"

const setupContext = (
    logs: string[],
    errors: Error[],
): WorkflowContext<EventMap, Record<string, unknown>> => ({
    app: createBus().channel<EventMap>("app"),
    plugins: {},
    log: message => {
        logs.push(message)
    },
    fail: error => {
        errors.push(error as Error)
    },
    onStart: () => undefined,
    onStop: () => undefined,
    interval: () => undefined,
})

describe("graph secret containment", () => {
    it("wraps raw secrets, reveals templates deliberately, and sanitizes delegated output", async () => {
        const logs: string[] = []
        const errors: Error[] = []
        const resolved: unknown[] = []
        const registry = createNodeRegistry()
        registry.register({
            type: "capture",
            kind: "trigger",
            configSchema: {},
            create: () => ({
                start: ({ ctx }: { ctx: GraphNodeContext }) => {
                    const token = ctx.resolve("{{ $secret.token }}", null)
                    const nested = ctx.resolve("{{ $secret.credentials.password }}", null)
                    resolved.push(token, nested)
                    ctx.log(`token=${String(token)}`)
                    ctx.fail(new Error(`failed with ${String(token)}`))
                },
            }),
        })

        const workflow = compileGraph(
            { name: "contained", nodes: [{ id: "source", type: "capture" }], edges: [] },
            {
                registry,
                secrets: {
                    token: "graph-token-value",
                    credentials: { password: "graph-password-value" },
                },
            },
        )

        await workflow.setup(setupContext(logs, errors))

        expect(resolved).toEqual(["graph-token-value", "graph-password-value"])
        expect(logs).toEqual(["token=[redacted]"])
        expect(errors[0]?.message).toBe("failed with [redacted]")
    })

    it("accepts existing wrappers without double-wrapping them", async () => {
        const logs: string[] = []
        const registry = createNodeRegistry()
        registry.register({
            type: "capture",
            kind: "trigger",
            configSchema: {},
            create: () => ({
                start: ({ ctx }: { ctx: GraphNodeContext }) => {
                    ctx.log(String(ctx.resolve("{{ $secret.token }}", null)))
                },
            }),
        })

        const workflow = compileGraph(
            { name: "wrapped", nodes: [{ id: "source", type: "capture" }], edges: [] },
            { registry, secrets: { token: Secret.from("already-wrapped-token") } },
        )
        await workflow.setup(setupContext(logs, []))

        expect(logs).toEqual(["[redacted]"])
    })

    it("rejects non-JSON graph secrets before retaining them", () => {
        expect(() =>
            compileGraph(
                { name: "invalid", nodes: [], edges: [] },
                { secrets: { invalid: new Date() } as never },
            ),
        ).toThrow("$secret.invalid is not JSON-compatible")
    })
})
