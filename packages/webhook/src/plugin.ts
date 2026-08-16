import { definePlugin, type ReadChannel } from "@signalbox/core"
import type { HttpMount } from "@signalbox/http"

/** A received webhook request, emitted on the plugin's channel. */
export interface WebhookRequest {
    /** The parsed JSON body, or the raw string if it wasn't JSON. */
    body: unknown
    /** Request headers, lower-cased. */
    headers: Record<string, string>
    /** Parsed query-string parameters. */
    query: Record<string, string>
    /** The HTTP method. */
    method: string
    /** The request path. */
    path: string
}

/** Configuration for a single webhook route. */
export interface RouteConfig {
    /** The URL path to mount, e.g. `"/vs-chat"`. */
    path: string
    /** HTTP method to accept; defaults to `POST`. */
    method?: string
    /** If set, requests must carry a matching `x-webhook-secret` header. */
    secret?: string
}

/**
 * Options for {@link webhookPlugin}.
 * @typeParam TRoutes a map of route name to its {@link RouteConfig}
 */
export interface WebhookOptions<TRoutes extends Record<string, RouteConfig>> {
    /** The shared HTTP server (from `@signalbox/http`) to mount routes on. */
    http: HttpMount
    /** Routes to expose, keyed by the name used to subscribe (`events.flow(name)`). */
    routes: TRoutes
}

/**
 * The event map: each route name maps to a {@link WebhookRequest}.
 * @typeParam TRoutes the route map from {@link WebhookOptions}
 */
export type WebhookEvents<TRoutes> = { [TKey in keyof TRoutes]: WebhookRequest }

/**
 * The webhook plugin surface exposed as `ctx.plugins.<name>`.
 * @typeParam TRoutes the configured route map
 */
export interface WebhookApi<TRoutes extends Record<string, RouteConfig>> {
    /** Subscribe to received requests per route via `events.flow("<route>")`. */
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

/**
 * Plugin that mounts inbound webhook routes on a shared HTTP server and emits each
 * matching request on its channel, keyed by route name.
 * @typeParam TRoutes the route map, inferred from `options.routes`
 * @param options the shared server and the routes to expose
 */
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
