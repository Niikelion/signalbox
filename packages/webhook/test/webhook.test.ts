/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { createApp, createWorkflowDefiner, type NoEvents, type PluginApis } from "@signalbox/core"
import { httpPlugin } from "@signalbox/http"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
    webhookPlugin,
    type SendOptions,
    type TargetConfig,
    type WebhookRequest,
    type WebhookResponse,
} from "../src/index.js"

describe("webhook plugin (mounted on shared http)", () => {
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
            logging: false,
            plugins,
            workflows: [
                defineWorkflow("capture", ctx => {
                    ctx.plugins.webhook.events.flow("chat").run(request => {
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
})

describe("webhook plugin (outbound targets)", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
    afterAll(() => {
        fetchMock.mockRestore()
    })

    const makeSender = async (targets: Record<string, TargetConfig>) => {
        const api = (await webhookPlugin({ targets }).init({} as any)) as {
            send: (target: string, body?: unknown, options?: SendOptions) => Promise<WebhookResponse>
        }
        return api.send
    }

    it("posts a JSON body with target headers and secret merged in", async () => {
        fetchMock.mockReset().mockResolvedValue(
            new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { "content-type": "application/json" },
            }),
        )
        const send = await makeSender({
            deploy: { url: "https://hooks/deploy", headers: { "x-app": "sb" }, secret: "s3cr3t" },
        })

        const res = await send("deploy", { event: "push" })

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const call = fetchMock.mock.calls[0]
        expect(call?.[0]).toBe("https://hooks/deploy")
        expect(call?.[1]?.method).toBe("POST")
        expect(call?.[1]?.headers).toMatchObject({
            "content-type": "application/json",
            "x-app": "sb",
            "x-webhook-secret": "s3cr3t",
        })
        expect(JSON.parse((call?.[1]?.body as string) ?? "{}")).toEqual({ event: "push" })
        expect(res).toMatchObject({ status: 200, ok: true, body: { ok: true } })
    })

    it("sends a string body as-is, honoring per-call method and header overrides", async () => {
        fetchMock.mockReset().mockResolvedValue(new Response("thanks", { status: 202 }))
        const send = await makeSender({ raw: { url: "https://hooks/raw", method: "PUT" } })

        const res = await send("raw", "ping", { method: "PATCH", headers: { "content-type": "text/plain" } })

        const call = fetchMock.mock.calls[0]
        expect(call?.[1]?.method).toBe("PATCH")
        expect(call?.[1]?.body).toBe("ping")
        expect(call?.[1]?.headers).toMatchObject({ "content-type": "text/plain" })
        expect(res).toMatchObject({ status: 202, ok: true, body: "thanks" })
    })

    it("rejects on an unknown target", async () => {
        const send = await makeSender({ known: { url: "https://hooks/known" } })
        await expect(send("missing")).rejects.toThrow(/unknown webhook target/)
    })
})
