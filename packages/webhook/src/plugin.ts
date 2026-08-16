import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http"
import { definePlugin, type ReadChannel } from "@signalbox/core"

export interface WebhookRequest {
    body: unknown
    headers: IncomingHttpHeaders
    query: Record<string, string>
    method: string
    path: string
}

export interface RouteConfig {
    path: string
    /** HTTP method to accept; defaults to POST. */
    method?: string
    /** If set, requests must carry a matching `x-webhook-secret` header. */
    secret?: string
}

export interface WebhookOptions<TRoutes extends Record<string, RouteConfig>> {
    port: number
    host?: string
    routes: TRoutes
}

export type WebhookEvents<TRoutes> = { [TKey in keyof TRoutes]: WebhookRequest }

export interface WebhookApi<TRoutes extends Record<string, RouteConfig>> {
    events: ReadChannel<WebhookEvents<TRoutes>>
}

const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        request.on("data", (chunk: Buffer) => {
            chunks.push(chunk)
        })
        request.on("end", () => {
            resolve(Buffer.concat(chunks).toString("utf8"))
        })
        request.on("error", reject)
    })

const parseBody = (raw: string, contentType: string): unknown => {
    if (raw.length === 0 || !contentType.includes("json")) return raw
    try {
        return JSON.parse(raw)
    } catch {
        return raw
    }
}

export const webhookPlugin = <TRoutes extends Record<string, RouteConfig>>(options: WebhookOptions<TRoutes>) => {
    interface Match {
        name: keyof TRoutes & string
        method: string
        secret?: string
    }

    const byPath = new Map<string, Match>()
    for (const [name, route] of Object.entries(options.routes)) {
        byPath.set(route.path, { name, method: (route.method ?? "POST").toUpperCase(), secret: route.secret })
    }

    return definePlugin<WebhookApi<TRoutes>, WebhookEvents<TRoutes>>({
        name: "webhook",
        init: (ctx) => ({ events: ctx.channel }),
        setup: (ctx) => {
            const server: Server = createServer((request, response) => {
                void (async () => {
                    const url = new URL(request.url ?? "/", "http://localhost")
                    const route = byPath.get(url.pathname)
                    const method = (request.method ?? "").toUpperCase()

                    if (!route) {
                        response.writeHead(404).end("not found")
                        return
                    }
                    if (method !== route.method) {
                        response.writeHead(405).end("method not allowed")
                        return
                    }

                    const { secret } = route
                    if (secret !== undefined && request.headers["x-webhook-secret"] !== secret) {
                        response.writeHead(401).end("unauthorized")
                        return
                    }

                    const raw = await readBody(request)
                    const body = parseBody(raw, request.headers["content-type"] ?? "")

                    ctx.channel.emit(route.name, {
                        body,
                        headers: request.headers,
                        query: Object.fromEntries(url.searchParams),
                        method,
                        path: url.pathname,
                    })
                    response.writeHead(200).end("ok")
                })().catch((error: unknown) => {
                    ctx.fail(error)
                    if (!response.headersSent) response.writeHead(500).end("error")
                })
            })

            ctx.onStop(
                () =>
                    new Promise<void>((resolve) => {
                        server.close(() => {
                            resolve()
                        })
                    }),
            )

            // resolve only once the server is actually listening, so start() waits for it
            return new Promise<void>((resolve, reject) => {
                server.once("error", reject)
                server.listen(options.port, options.host, () => {
                    server.off("error", reject)
                    server.on("error", (error) => {
                        ctx.fail(error)
                    })
                    ctx.log(
                        `listening on ${options.host ?? "0.0.0.0"}:${String(options.port)} (${String(byPath.size)} routes)`,
                    )
                    resolve()
                })
            })
        },
    })
}
