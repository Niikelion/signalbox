/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { createApp, createWorkflowDefiner, type NoEvents, type PluginApis } from "@signalbox/core"
import { describe, expect, it } from "vitest"
import { z } from "zod"
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
                defineWorkflow("routes", ctx => {
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
            expect((await fetch(`http://127.0.0.1:${String(port)}/nope`)).status).toBe(404)
        } finally {
            await app.stop()
        }
    })

    it("validates typed routes and serves an OpenAPI spec", async () => {
        const port = 39191
        const plugins = {
            http: httpPlugin({
                port,
                host: "127.0.0.1",
                openapi: { path: "/openapi.json", info: { title: "Test API", version: "1.0.0" } },
            }),
        }
        const defineWorkflow = createWorkflowDefiner<NoEvents, PluginApis<typeof plugins>>()

        const app = createApp({
            name: "http-openapi",
            logging: false,
            plugins,
            workflows: [
                defineWorkflow("routes", ctx => {
                    ctx.plugins.http.route({
                        method: "POST",
                        path: "/echo",
                        summary: "Greet someone",
                        request: z.object({ name: z.string() }),
                        response: z.object({ greeting: z.string() }),
                        handle: input => ({ greeting: `hi ${input.name}` }),
                    })
                }),
            ],
        })

        await app.start()
        try {
            const base = `http://127.0.0.1:${String(port)}`
            const json = (body: unknown) => ({
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            })

            const ok = await fetch(`${base}/echo`, json({ name: "Ada" }))
            expect(ok.status).toBe(200)
            expect(await ok.json()).toEqual({ greeting: "hi Ada" })

            const bad = await fetch(`${base}/echo`, json({ name: 123 }))
            expect(bad.status).toBe(400)

            const spec: any = await (await fetch(`${base}/openapi.json`)).json()
            expect(spec.openapi).toBe("3.1.0")
            expect(spec.info.title).toBe("Test API")
            expect(spec.paths["/echo"].post.summary).toBe("Greet someone")
            expect(spec.paths["/echo"].post.requestBody.content["application/json"].schema.properties.name.type).toBe(
                "string",
            )
        } finally {
            await app.stop()
        }
    })
})
