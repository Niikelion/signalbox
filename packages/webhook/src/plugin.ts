import { definePlugin, SignalboxError, type ReadChannel } from "@signalbox/core"
import type { HttpMount } from "@signalbox/http"
import {
    definePermissionSource,
    definePermission,
    entityRef,
    permissionClaim,
    type IdentityGrant,
    type PermissionSourcePolicy,
} from "@signalbox/permissions"
import { z } from "zod"

export const webhookSubscribePermission = definePermission({
    id: "webhook.subscribe",
    name: "Subscribe to webhooks",
    description: "Attach a workflow to an authenticated inbound webhook route",
})

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

/** Configuration for a single inbound webhook route. */
export interface RouteConfig {
    /** The URL path to mount, e.g. `"/vs-chat"`. */
    path: string
    /** HTTP method to accept; defaults to `POST`. */
    method?: string
    /** If set, requests must carry a matching `x-webhook-secret` header. */
    secret?: string
    /** Resolve the canonical identity represented by an authenticated request. */
    identity?: (request: WebhookRequest) => IdentityGrant | Promise<IdentityGrant>
}

/** Configuration for a single outbound webhook target. */
export interface TargetConfig {
    /** The URL to send requests to. */
    url: string
    /** HTTP method; defaults to `POST`. */
    method?: string
    /** Headers sent with every request to this target. */
    headers?: Record<string, string>
    /** If set, sent as the `x-webhook-secret` header. */
    secret?: string
    /**
     * Zod schema the request body is validated (and typed) against. When set, `send`'s
     * body argument is typed as its inferred type and parsed before the request is sent.
     */
    request?: z.ZodType
}

/** The `send` body type for a target: its `request` schema's inferred type, or `unknown`. */
export type TargetBody<TTarget extends TargetConfig> = TTarget["request"] extends z.ZodType
    ? z.infer<TTarget["request"]>
    : unknown

/** Per-call options for {@link WebhookApi.send}. */
export interface SendOptions {
    /** Extra headers for this request, merged over the target's own. */
    headers?: Record<string, string>
    /** Override the target's method for this request. */
    method?: string
}

/** The result of an outbound webhook request. */
export interface WebhookResponse {
    /** HTTP status code. Non-2xx does not throw — inspect this. */
    status: number
    /** Whether the status is in the 2xx range. */
    ok: boolean
    /** Response headers, lower-cased. */
    headers: Record<string, string>
    /** The parsed JSON body, or the raw string if it wasn't JSON. */
    body: unknown
}

/**
 * Options for {@link webhookPlugin}.
 * @typeParam TRoutes a map of inbound route name to its {@link RouteConfig}
 * @typeParam TTargets a map of outbound target name to its {@link TargetConfig}
 */
export interface WebhookOptions<
    TRoutes extends Record<string, RouteConfig>,
    TTargets extends Record<string, TargetConfig>,
> {
    /** The shared HTTP server (from `@signalbox/http`), required if `routes` are set. */
    http?: HttpMount
    /** Inbound routes to expose, keyed by the name used to subscribe (`events.flow(name)`). */
    routes?: TRoutes
    /** Outbound targets to fire requests at, keyed by the name passed to `send(name, ...)`. */
    targets?: TTargets
}

/**
 * The event map: each inbound route name maps to a {@link WebhookRequest}.
 * @typeParam TRoutes the route map from {@link WebhookOptions}
 */
export type WebhookEvents<TRoutes> = { [TKey in keyof TRoutes]: WebhookRequest }

/**
 * The webhook plugin surface exposed as `ctx.plugins.<name>`.
 * @typeParam TRoutes the configured inbound route map
 * @typeParam TTargets the configured outbound target map
 */
export interface WebhookApi<
    TRoutes extends Record<string, RouteConfig>,
    TTargets extends Record<string, TargetConfig>,
> {
    /** Subscribe to received requests per route via `events.flow("<route>")`. */
    events: ReadChannel<WebhookEvents<TRoutes>>
    /** Permission-aware source policy for an authenticated inbound route. */
    source: (route: keyof TRoutes & string) => PermissionSourcePolicy<WebhookRequest>
    /**
     * Fire a request at a configured outbound target. Resolves with the response;
     * a non-2xx status does not throw (check `response.ok`), but a network failure does.
     * If the target has a `request` schema, `body` is typed as its inferred type and is
     * validated before sending (a mismatch throws).
     * @typeParam TKey the target name
     * @param target the target name from `options.targets`
     * @param body the request body — validated by the target's schema; an object is
     * JSON-encoded, a string sent as-is
     * @param options per-call header/method overrides
     */
    send: <TKey extends keyof TTargets>(
        target: TKey,
        body: TargetBody<TTargets[TKey]>,
        options?: SendOptions,
    ) => Promise<WebhookResponse>
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
 * Plugin for HTTP webhooks in both directions: mount inbound `routes` on a shared HTTP
 * server (each request is emitted on the channel, keyed by route name), and declare
 * outbound `targets` that workflows fire requests at with `send`.
 * @typeParam TRoutes the inbound route map, inferred from `options.routes`
 * @typeParam TTargets the outbound target map, inferred from `options.targets`
 * @param options the shared server, inbound routes, and/or outbound targets
 */
export const webhookPlugin = <
    TRoutes extends Record<string, RouteConfig> = Record<string, never>,
    TTargets extends Record<string, TargetConfig> = Record<string, never>,
>(
    options: WebhookOptions<TRoutes, TTargets>,
) =>
    definePlugin<WebhookApi<TRoutes, TTargets>, WebhookEvents<TRoutes>>({
        name: "webhook",
        init: ctx => {
            const routes = options.routes ?? ({} as TRoutes)
            const targets = options.targets ?? ({} as TTargets)

            for (const [routeName, route] of Object.entries(routes)) {
                if (!options.http) {
                    throw new SignalboxError(
                        `webhook route "${routeName}" needs an http server`,
                        "pass `http` from @signalbox/http in the plugin options",
                    )
                }
                const name = routeName as keyof TRoutes & string
                const method = (route.method ?? "POST").toUpperCase()
                const { secret } = route

                options.http.handle(method, route.path, async c => {
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

            const send = async <TKey extends keyof TTargets>(
                target: TKey,
                body: TargetBody<TTargets[TKey]>,
                sendOptions?: SendOptions,
            ): Promise<WebhookResponse> => {
                const def = targets[target as keyof TTargets & string]
                if (!def) {
                    throw new SignalboxError(
                        `unknown webhook target "${String(target)}"`,
                        `known targets: ${Object.keys(targets).join(", ") || "(none)"}`,
                    )
                }

                let validated: unknown = body
                if (def.request) {
                    const result = def.request.safeParse(body)
                    if (!result.success) {
                        throw new SignalboxError(
                            `invalid body for webhook target "${String(target)}"`,
                            result.error.issues.map(issue => issue.message).join("; "),
                        )
                    }
                    validated = result.data
                }

                const isJson = validated !== undefined && typeof validated !== "string"
                const headers: Record<string, string> = {
                    ...(isJson ? { "content-type": "application/json" } : {}),
                    ...def.headers,
                    ...(def.secret !== undefined ? { "x-webhook-secret": def.secret } : {}),
                    ...sendOptions?.headers,
                }
                const payload =
                    validated === undefined
                        ? undefined
                        : typeof validated === "string"
                          ? validated
                          : JSON.stringify(validated)

                const response = await fetch(def.url, {
                    method: (sendOptions?.method ?? def.method ?? "POST").toUpperCase(),
                    headers,
                    ...(payload !== undefined ? { body: payload } : {}),
                })
                const raw = await response.text()
                return {
                    status: response.status,
                    ok: response.ok,
                    headers: Object.fromEntries(response.headers),
                    body: parseBody(raw, response.headers.get("content-type") ?? ""),
                }
            }

            const source = (routeName: keyof TRoutes & string): PermissionSourcePolicy<WebhookRequest> => {
                const route = routes[routeName]
                if (!route?.identity) {
                    throw new SignalboxError(
                        `webhook route "${routeName}" has no identity resolver`,
                        "configure route.identity before using it as a permission source",
                    )
                }
                const routeEntity = entityRef("webhook-route", routeName)
                return definePermissionSource({
                    entity: routeEntity,
                    subscriptionClaims: [permissionClaim(webhookSubscribePermission.id, routeEntity)],
                    identity: route.identity,
                })
            }

            return { events: ctx.channel, source, send }
        },
    })
