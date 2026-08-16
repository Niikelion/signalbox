import { serve } from "@hono/node-server"
import { definePlugin, type NoEvents, type PluginDefinition } from "@signalbox/core"
import { Hono } from "hono"
import { z } from "zod"

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

type Input<T> = T extends z.ZodType ? z.infer<T> : undefined
type Output<T> = T extends z.ZodType ? z.infer<T> : void

export interface RouteSpec<TReq extends z.ZodType | undefined, TRes extends z.ZodType | undefined> {
    method: string
    path: string
    request?: TReq
    response?: TRes
    summary?: string
    description?: string
    tags?: string[]
    handle: (input: Input<TReq>, context: HttpContext) => Output<TRes> | Promise<Output<TRes>>
}

/** Passed to sub-plugins (e.g. webhook) so they can mount routes on the shared server. */
export interface HttpMount {
    handle: (method: string, path: string, handler: HttpHandler) => void
    route: <TReq extends z.ZodType | undefined = undefined, TRes extends z.ZodType | undefined = undefined>(
        spec: RouteSpec<TReq, TRes>,
    ) => void
}

export interface HttpApi extends HttpMount {
    readonly hono: Hono
}

export interface OpenApiOptions {
    path: string
    info: { title: string; version: string; description?: string }
}

export interface HttpOptions {
    port: number
    host?: string
    openapi?: OpenApiOptions
}

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

export const httpPlugin = (options: HttpOptions): HttpPlugin => {
    const hono = new Hono()
    const descriptors: RouteDescriptor[] = []

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

    const route: HttpMount["route"] = (spec) => {
        descriptors.push({
            method: spec.method,
            path: spec.path,
            request: spec.request,
            response: spec.response,
            summary: spec.summary,
            description: spec.description,
            tags: spec.tags,
        })

        handle(spec.method, spec.path, async (context) => {
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
        setup: (ctx) =>
            new Promise<void>((resolve, reject) => {
                if (options.openapi) {
                    const doc = JSON.stringify(buildOpenApi(options.openapi.info, descriptors))
                    handle("GET", options.openapi.path, () => ({ status: 200, body: doc, headers: jsonHeaders() }))
                }

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

    return Object.assign(definition, { hono, handle, route })
}
