/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { createApp, createWorkflowDefiner, type NoEvents, type PluginApis } from "@signalbox/core"
import { httpPlugin } from "@signalbox/http"
import { createPermissionExecution, entityRef } from "@signalbox/permissions"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
    webhookPlugin,
    z,
    type SendOptions,
    type TargetConfig,
    type WebhookRequest,
    type WebhookResponse,
} from "../src/index"

const testPermissions = () => {
    const permissions = createPermissionExecution()
    return {
        runtime: permissions.runtime,
        core: permissions.core,
        host: permissions.identities.issue({ principal: entityRef("system", "webhook-test") }),
    }
}

// ------------------------------------------------------------------ inbound

describe("webhook plugin — inbound routes (mounted on shared http)", () => {
    it("routes requests to channel events, parses JSON, enforces secrets", async () => {
        const port = 39188
        const received: WebhookRequest[] = []

        const http = httpPlugin({ port, host: "127.0.0.1" })
        const plugins = {
            http,
            webhook: webhookPlugin({
                http,
                routes: {
                    chat: { path: "/chat" },
                    secure: { path: "/secure", secret: "sekret" },
                },
            }),
        }
        const defineWorkflow = createWorkflowDefiner<NoEvents, PluginApis<typeof plugins>>()

        const app = createApp({
            name: "webhook-test",
            permissions: testPermissions(),
            logging: false,
            plugins,
            workflows: [
                defineWorkflow("capture", ctx => {
                    ctx.plugins.webhook.events.flow("chat").effect(request => {
                        received.push(request)
                    })
                }),
            ],
        })

        await app.start()
        try {
            const post = (path: string, headers: Record<string, string>, body: string) =>
                fetch(`http://127.0.0.1:${String(port)}${path}`, { method: "POST", headers, body })

            const ok = await post("/chat", { "content-type": "application/json" }, JSON.stringify({ hello: "world" }))
            expect(ok.status).toBe(200)
            expect(received).toHaveLength(1)
            expect(received[0]?.body).toEqual({ hello: "world" })
            expect(received[0]?.path).toBe("/chat")

            expect((await post("/nope", {}, "")).status).toBe(404)
            expect((await post("/secure", { "content-type": "application/json" }, "{}")).status).toBe(401)
            expect(
                (await post("/secure", { "content-type": "application/json", "x-webhook-secret": "sekret" }, "{}"))
                    .status,
            ).toBe(200)
        } finally {
            await app.stop()
        }
    })

    it("throws if a route is configured without an http server", () => {
        expect(() => webhookPlugin({ routes: { x: { path: "/x" } } }).init({} as any)).toThrow(/needs an http server/)
    })
})

// ---------------------------------------------------------------- outbound

const fetchMock = vi.spyOn(globalThis, "fetch")
afterEach(() => {
    fetchMock.mockReset()
})

const makeSender = async (targets: Record<string, TargetConfig>) => {
    const api = (await webhookPlugin({ targets }).init({} as any)) as {
        send: (target: string, body?: unknown, options?: SendOptions) => Promise<WebhookResponse>
    }
    return api.send
}
const jsonResponse = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
const sentInit = () => fetchMock.mock.calls[0]?.[1]
const sentUrl = () => fetchMock.mock.calls[0]?.[0]
const sentBody = () => JSON.parse((sentInit()?.body as string) ?? "null")

describe("webhook plugin — outbound sending", () => {
    it("posts a JSON body, merges target headers + secret, defaults to POST", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ ok: true }))
        const send = await makeSender({
            deploy: { url: "https://hooks/deploy", headers: { "x-app": "sb" }, secret: "s3cr3t" },
        })

        const res = await send("deploy", { event: "push" })

        expect(sentUrl()).toBe("https://hooks/deploy")
        expect(sentInit()?.method).toBe("POST")
        expect(sentInit()?.headers).toMatchObject({
            "content-type": "application/json",
            "x-app": "sb",
            "x-webhook-secret": "s3cr3t",
        })
        expect(sentBody()).toEqual({ event: "push" })
        expect(res).toMatchObject({ status: 200, ok: true, body: { ok: true } })
    })

    it("sends a string body as-is, without a JSON content-type", async () => {
        fetchMock.mockResolvedValue(new Response("thanks", { status: 200 }))
        const send = await makeSender({ raw: { url: "https://hooks/raw" } })

        await send("raw", "ping")

        expect(sentInit()?.body).toBe("ping")
        expect(sentInit()?.headers).not.toHaveProperty("content-type")
    })

    it("honors per-call method and header overrides over the target's", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
        const send = await makeSender({
            t: { url: "https://hooks/t", method: "POST", headers: { "content-type": "application/json", "x-a": "1" } },
        })

        await send("t", "raw", { method: "put", headers: { "content-type": "text/plain", "x-b": "2" } })

        expect(sentInit()?.method).toBe("PUT")
        expect(sentInit()?.headers).toMatchObject({ "content-type": "text/plain", "x-a": "1", "x-b": "2" })
        expect(sentInit()?.body).toBe("raw")
    })

    it("omits the body and content-type when no body is given", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
        const send = await makeSender({ ping: { url: "https://hooks/ping" } })

        await send("ping")

        expect(sentInit()?.body).toBeUndefined()
        expect(sentInit()?.headers).not.toHaveProperty("content-type")
    })

    it("returns the raw string body for a non-JSON response", async () => {
        fetchMock.mockResolvedValue(new Response("pong", { status: 200, headers: { "content-type": "text/plain" } }))
        const send = await makeSender({ ping: { url: "https://hooks/ping" } })

        const res = await send("ping", undefined)

        expect(res).toMatchObject({ status: 200, ok: true, body: "pong" })
    })

    it("reports ok:false for a non-2xx status without throwing", async () => {
        fetchMock.mockResolvedValue(new Response("nope", { status: 500 }))
        const send = await makeSender({ t: { url: "https://hooks/t" } })

        const res = await send("t", { a: 1 })

        expect(res.status).toBe(500)
        expect(res.ok).toBe(false)
        expect(res.body).toBe("nope")
    })

    it("rejects when fetch itself fails (network error)", async () => {
        fetchMock.mockRejectedValue(new Error("ECONNREFUSED"))
        const send = await makeSender({ t: { url: "https://hooks/t" } })

        await expect(send("t", { a: 1 })).rejects.toThrow(/ECONNREFUSED/)
    })

    it("throws SignalboxError for an unknown target", async () => {
        const send = await makeSender({ known: { url: "https://hooks/known" } })

        await expect(send("missing", {})).rejects.toThrow(/unknown webhook target "missing"/)
        expect(fetchMock).not.toHaveBeenCalled()
    })
})

// ----------------------------------------------------------- outbound schemas

describe("webhook plugin — outbound request schemas", () => {
    it("validates the body against the target's schema and sends the parsed value", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ ok: true }))
        const send = await makeSender({
            deploy: { url: "https://hooks/deploy", request: z.object({ ref: z.string() }) },
        })

        await send("deploy", { ref: "main" })

        expect(sentBody()).toEqual({ ref: "main" })
        expect(sentInit()?.headers).toMatchObject({ "content-type": "application/json" })
    })

    it("applies schema defaults and transforms to the sent payload", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
        const send = await makeSender({
            t: {
                url: "https://hooks/t",
                request: z.object({
                    name: z.string().transform(s => s.toUpperCase()),
                    retries: z.number().default(3),
                    extra: z.string().optional(),
                }),
            },
        })

        await send("t", { name: "deploy" })

        expect(sentBody()).toEqual({ name: "DEPLOY", retries: 3 })
    })

    it("strips unknown keys per the schema before sending", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
        const send = await makeSender({
            t: { url: "https://hooks/t", request: z.object({ keep: z.string() }) },
        })

        await send("t", { keep: "yes", drop: "no" } as any)

        expect(sentBody()).toEqual({ keep: "yes" })
    })

    it("throws SignalboxError for an invalid body, and does not call fetch", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
        const send = await makeSender({
            deploy: { url: "https://hooks/deploy", request: z.object({ ref: z.string() }) },
        })

        await expect(send("deploy", { ref: 123 } as any)).rejects.toThrow(/invalid body for webhook target "deploy"/)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("leaves schema-less targets accepting any body", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
        const send = await makeSender({ any: { url: "https://hooks/any" } })

        await send("any", { whatever: [1, 2, 3] })

        expect(sentBody()).toEqual({ whatever: [1, 2, 3] })
    })
})
