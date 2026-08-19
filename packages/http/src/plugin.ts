import { serve } from "@hono/node-server"
import { definePlugin, type NoEvents, type PluginDefinition } from "@signalbox/core"
import { Hono } from "hono"
import { z } from "zod"

/** The request passed to a low-level {@link HttpHandler}. */
export interface HttpContext {
    /** The HTTP method. */
    method: string
    /** The request path. */
    path: string
    /** Parsed query-string parameters. */
    query: Record<string, string>
    /** Request headers, lower-cased. */
    headers: Record<string, string>
    /** Read the raw request body as text. */
    text: () => Promise<string>
}

/** The response a low-level {@link HttpHandler} returns. */
export interface HttpResult {
    /** HTTP status code. */
    status: number
    /** Response body. */
    body?: string
    /** Response headers. */
    headers?: Record<string, string>
}

/** A low-level request handler. */
export type HttpHandler = (context: HttpContext) => HttpResult | Promise<HttpResult>

type Input<T> = T extends z.ZodType ? z.infer<T> : undefined
type Output<T> = T extends z.ZodType ? z.infer<T> : void

/**
 * A typed route declaration for {@link HttpMount.route}.
 * @typeParam TReq the request-body schema, or `undefined` for none
 * @typeParam TRes the response-body schema, or `undefined` for none
 */
export interface RouteSpec<TReq extends z.ZodType | undefined, TRes extends z.ZodType | undefined> {
    /** HTTP method. */
    method: string
    /** URL path. */
    path: string
    /** Zod schema the request body is validated against (400 on failure). */
    request?: TReq
    /** Zod schema documenting the response (used for OpenAPI). */
    response?: TRes
    /** OpenAPI summary. */
    summary?: string
    /** OpenAPI description. */
    description?: string
    /** OpenAPI tags. */
    tags?: string[]
    /**
     * The handler; receives the validated request body.
     * @param input the parsed request body (typed by `request`), or `undefined`
     * @param context the raw request context
     */
    handle: (input: Input<TReq>, context: HttpContext) => Output<TRes> | Promise<Output<TRes>>
}

/** The mount point other plugins use to add routes to the shared server. */
export interface HttpMount {
    /**
     * Register a low-level handler for a method + path.
     * @param method the HTTP method
     * @param path the URL path
     * @param handler the request handler
     */
    handle: (method: string, path: string, handler: HttpHandler) => void
    /**
     * Register a typed, Zod-validated route (also feeds the OpenAPI spec).
     * @typeParam TReq the request-body schema, or `undefined`
     * @typeParam TRes the response-body schema, or `undefined`
     * @param spec the route declaration
     */
    route: <TReq extends z.ZodType | undefined = undefined, TRes extends z.ZodType | undefined = undefined>(
        spec: RouteSpec<TReq, TRes>,
    ) => void
}

/** The http surface exposed to workflows as `ctx.plugins.http`. */
export interface HttpApi extends HttpMount {
    /** The underlying Hono app, for advanced routing/middleware. */
    readonly hono: Hono
}

/** Options for serving an OpenAPI document. */
export interface OpenApiOptions {
    /** Path to serve the spec at, e.g. `"/openapi.json"`. */
    path: string
    /** The OpenAPI `info` block. */
    info: { title: string; version: string; description?: string }
}

/** Options for {@link httpPlugin}. */
export interface HttpOptions {
    /** Port to listen on. */
    port: number
    /** Host/interface to bind (default all interfaces). */
    host?: string
    /** If set, serve an OpenAPI 3.1 document built from the routes' Zod schemas. */
    openapi?: OpenApiOptions
}

/** The plugin instance returned by {@link httpPlugin}; also usable as a mount point at construction. */
export type HttpPlugin = PluginDefinition<HttpApi, NoEvents> & HttpApi

interface RouteDescriptor {
    method: string
    path: string
    request?: z.ZodType
    response?: z.ZodType
    summary?: string
    description?: string
    tags?: string[]
}

const jsonHeaders = (): Record<string, string> => ({ "content-type": "application/json" })

interface Operation {
    summary?: string
    description?: string
    tags?: string[]
    requestBody?: unknown
    responses: Record<string, unknown>
}

const schemaOf = (schema: z.ZodType): unknown => {
    const json = z.toJSONSchema(schema) as Record<string, unknown>
    const { $schema: _dropped, ...rest } = json
    return rest
}

const buildOpenApi = (info: OpenApiOptions["info"], routes: RouteDescriptor[]): unknown => {
    const paths: Record<string, Record<string, Operation>> = {}
    for (const route of routes) {
        const operation: Operation = {
            summary: route.summary,
            description: route.description,
            tags: route.tags,
            responses: {
                "200": {
                    description: "OK",
                    ...(route.response
                        ? { content: { "application/json": { schema: schemaOf(route.response) } } }
                        : {}),
                },
            },
        }
        if (route.request) {
            operation.requestBody = {
                required: true,
                content: { "application/json": { schema: schemaOf(route.request) } },
            }
        }
        const item = paths[route.path] ?? {}
        item[route.method.toLowerCase()] = operation
        paths[route.path] = item
    }
    return { openapi: "3.1.0", info, paths }
}

/**
 * Plugin owning one shared HTTP server (Hono). Other plugins mount routes on it via
 * the {@link HttpMount} it exposes at construction, so everything shares one port.
 * @param options port, host, and optional OpenAPI serving
 */
export const httpPlugin = (options: HttpOptions): HttpPlugin => {
    const hono = new Hono()
    const descriptors: RouteDescriptor[] = []

    const handle: HttpMount["handle"] = (method, path, handler) => {
        hono.on(method.toUpperCase(), path, async c => {
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

    const route: HttpMount["route"] = spec => {
        descriptors.push({
            method: spec.method,
            path: spec.path,
            request: spec.request,
            response: spec.response,
            summary: spec.summary,
            description: spec.description,
            tags: spec.tags,
        })

        handle(spec.method, spec.path, async context => {
            let input: unknown
            if (spec.request) {
                const raw = await context.text()
                let parsed: unknown
                try {
                    parsed = raw.length > 0 ? JSON.parse(raw) : undefined
                } catch {
                    return { status: 400, body: JSON.stringify({ error: "invalid JSON" }), headers: jsonHeaders() }
                }
                const result = spec.request.safeParse(parsed)
                if (!result.success) {
                    return {
                        status: 400,
                        body: JSON.stringify({ error: "invalid request", issues: result.error.issues }),
                        headers: jsonHeaders(),
                    }
                }
                input = result.data
            }

            const output = await spec.handle(input as never, context)
            return {
                status: 200,
                body: output === undefined ? "" : JSON.stringify(output),
                headers: jsonHeaders(),
            }
        })
    }

    const definition = definePlugin<HttpApi, NoEvents>({
        name: "http",
        init: () => ({ hono, handle, route }),
        setup: ctx =>
            new Promise<void>((resolve, reject) => {
                if (options.openapi) {
                    const doc = JSON.stringify(buildOpenApi(options.openapi.info, descriptors))
                    handle("GET", options.openapi.path, () => ({ status: 200, body: doc, headers: jsonHeaders() }))
                }

                const server = serve({ fetch: hono.fetch, port: options.port, hostname: options.host }, info => {
                    ctx.log(`listening on ${options.host ?? info.address}:${String(info.port)}`)
                    resolve()
                })
                server.on("error", reject)
                ctx.onStop(
                    () =>
                        new Promise<void>(done => {
                            server.close(() => {
                                done()
                            })
                        }),
                )
            }),
    })

    return Object.assign(definition, { hono, handle, route })
}
