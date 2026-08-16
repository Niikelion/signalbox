import { serve } from "@hono/node-server"
import { definePlugin, type NoEvents, type PluginDefinition } from "@signalbox/core"
import { Hono } from "hono"

export interface HttpContext {
    method: string
    path: string
    query: Record<string, string>
    headers: Record<string, string>
    text: () => Promise<string>
}

export interface HttpResult {
    status: number
    body?: string
    headers?: Record<string, string>
}

export type HttpHandler = (context: HttpContext) => HttpResult | Promise<HttpResult>

/** Passed to sub-plugins (e.g. webhook) so they can mount routes on the shared server. */
export interface HttpMount {
    handle: (method: string, path: string, handler: HttpHandler) => void
}

export interface HttpApi extends HttpMount {
    readonly hono: Hono
}

export interface HttpOptions {
    port: number
    host?: string
}

export type HttpPlugin = PluginDefinition<HttpApi, NoEvents> & HttpApi

export const httpPlugin = (options: HttpOptions): HttpPlugin => {
    const hono = new Hono()

    const handle: HttpMount["handle"] = (method, path, handler) => {
        hono.on(method.toUpperCase(), path, async (c) => {
            const result = await handler({
                method: c.req.method,
                path: c.req.path,
                query: c.req.query(),
                headers: c.req.header(),
                text: () => c.req.text(),
            })
            return new Response(result.body ?? "", { status: result.status, headers: result.headers })
        })
    }

    const definition = definePlugin<HttpApi, NoEvents>({
        name: "http",
        init: () => ({ hono, handle }),
        setup: (ctx) =>
            new Promise<void>((resolve, reject) => {
                const server = serve({ fetch: hono.fetch, port: options.port, hostname: options.host }, (info) => {
                    ctx.log(`listening on ${options.host ?? info.address}:${String(info.port)}`)
                    resolve()
                })
                server.on("error", reject)
                ctx.onStop(
                    () =>
                        new Promise<void>((done) => {
                            server.close(() => {
                                done()
                            })
                        }),
                )
            }),
    })

    return Object.assign(definition, { hono, handle })
}
