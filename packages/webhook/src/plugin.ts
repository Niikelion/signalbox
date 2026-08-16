import { definePlugin, type ReadChannel } from "@signalbox/core"
import type { HttpMount } from "@signalbox/http"

export interface WebhookRequest {
    body: unknown
    headers: Record<string, string>
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
    /** The shared HTTP server to mount these routes on. */
    http: HttpMount
    routes: TRoutes
}

export type WebhookEvents<TRoutes> = { [TKey in keyof TRoutes]: WebhookRequest }

export interface WebhookApi<TRoutes extends Record<string, RouteConfig>> {
    events: ReadChannel<WebhookEvents<TRoutes>>
}

const parseBody = (raw: string, contentType: string): unknown => {
    if (raw.length === 0 || !contentType.includes("json")) return raw
    try {
        return JSON.parse(raw)
    } catch {
        return raw
    }
}

export const webhookPlugin = <TRoutes extends Record<string, RouteConfig>>(options: WebhookOptions<TRoutes>) =>
    definePlugin<WebhookApi<TRoutes>, WebhookEvents<TRoutes>>({
        name: "webhook",
        init: (ctx) => {
            for (const [routeName, route] of Object.entries(options.routes)) {
                const name = routeName as keyof TRoutes & string
                const method = (route.method ?? "POST").toUpperCase()
                const { secret } = route

                options.http.handle(method, route.path, async (c) => {
                    if (secret !== undefined && c.headers["x-webhook-secret"] !== secret) {
                        return { status: 401, body: "unauthorized" }
                    }
                    const raw = await c.text()
                    ctx.channel.emit(name, {
                        body: parseBody(raw, c.headers["content-type"] ?? ""),
                        headers: c.headers,
                        query: c.query,
                        method: c.method,
                        path: c.path,
                    })
                    return { status: 200, body: "ok" }
                })
            }
            return { events: ctx.channel }
        },
    })
