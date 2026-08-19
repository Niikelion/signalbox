import { createApp, createWorkflowDefiner, type NoEvents, type PluginApis } from "@signalbox/core"
import { httpPlugin } from "@signalbox/http"
import { describe, expect, it } from "vitest"
import { webhookPlugin, type WebhookRequest } from "../src/index.js"

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
