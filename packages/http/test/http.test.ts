import { createApp, createWorkflowDefiner, type NoEvents, type PluginApis } from "@signalbox/core"
import { describe, expect, it } from "vitest"
import { httpPlugin } from "../src/index.js"

describe("http plugin", () => {
    it("serves routes registered via handle()", async () => {
        const port = 39190
        const plugins = { http: httpPlugin({ port, host: "127.0.0.1" }) }
        const defineWorkflow = createWorkflowDefiner<NoEvents, PluginApis<typeof plugins>>()

        const app = createApp({
            name: "http-test",
            logging: false,
            plugins,
            workflows: [
                defineWorkflow("routes", (ctx) => {
                    ctx.plugins.http.handle("GET", "/ping", () => ({
                        status: 200,
                        body: JSON.stringify({ ok: true }),
                        headers: { "content-type": "application/json" },
                    }))
                }),
            ],
        })

        await app.start()
        try {
            const res = await fetch(`http://127.0.0.1:${String(port)}/ping`)
            expect(res.status).toBe(200)
            expect(await res.json()).toEqual({ ok: true })

            const missing = await fetch(`http://127.0.0.1:${String(port)}/nope`)
            expect(missing.status).toBe(404)
        } finally {
            await app.stop()
        }
    })
})
