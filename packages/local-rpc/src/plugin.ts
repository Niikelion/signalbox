import { execFile } from "node:child_process"
import { chmod, chown, lstat, unlink } from "node:fs/promises"
import { Server, Socket, createConnection, createServer } from "node:net"
import { promisify } from "node:util"
import { definePlugin, type JsonValue, type NoEvents, type PluginDefinition } from "@signalbox/core"
import type { z } from "zod"
import { readPeerCredentials } from "./peer"
import { decodeJson, encodeFrame, HEADER_BYTES, parseRequest, PROTOCOL_VERSION, type WireResponse } from "./protocol"
import { LocalRpcError, type LocalRpcHandler, type LocalRpcMethod, type LocalRpcPeer } from "./types"

const execFileAsync = promisify(execFile)
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_MODE = 0o660
const MAX_IDEMPOTENCY_KEY_BYTES = 128

type Identity = number | string

/** Options for {@link localRpcPlugin}. */
export interface LocalRpcOptions {
    readonly socketPath: string
    readonly owner?: Identity
    readonly group?: Identity
    readonly mode?: number
    readonly maxRequestBytes?: number
    readonly requestTimeoutMs?: number
}

/** The local RPC registration surface available during workflow setup. */
export interface LocalRpcApi {
    route<TRequest extends z.ZodType, TResponse extends z.ZodType>(
        method: LocalRpcMethod<TRequest, TResponse>,
        handler: LocalRpcHandler<TRequest, TResponse>,
    ): void
}

/** A local RPC plugin that also permits route registration before app construction. */
export type LocalRpcPlugin = PluginDefinition<LocalRpcApi, NoEvents> & LocalRpcApi

interface RegisteredRoute {
    readonly request: z.ZodType
    readonly response: z.ZodType
    readonly handler: LocalRpcHandler<z.ZodType, z.ZodType>
}

interface ConnectionState {
    readonly socket: Socket
    dispatched: boolean
}

const resolveUid = async (identity: Identity | undefined): Promise<number | undefined> => {
    if (identity === undefined || typeof identity === "number") return identity
    const { stdout } = await execFileAsync("id", ["-u", identity], { encoding: "utf8" })
    return Number(stdout.trim())
}

const resolveGid = async (identity: Identity | undefined): Promise<number | undefined> => {
    if (identity === undefined || typeof identity === "number") return identity
    const { stdout } = await execFileAsync("getent", ["group", identity], { encoding: "utf8" })
    const gid = stdout.split(":")[2]
    if (!gid) throw new LocalRpcError("INVALID_GROUP", `group ${identity} was not found`)
    return Number(gid)
}

const socketAcceptsConnections = (path: string): Promise<boolean> =>
    new Promise((resolve, reject) => {
        const socket = createConnection(path)
        const finish = (result: boolean): void => {
            socket.destroy()
            resolve(result)
        }
        socket.once("connect", () => {
            finish(true)
        })
        socket.once("error", (error: NodeJS.ErrnoException) => {
            if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish(false)
            else reject(error)
        })
    })

const clearStaleSocket = async (path: string): Promise<void> => {
    let existing: Awaited<ReturnType<typeof lstat>>
    try {
        existing = await lstat(path)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
    }
    if (!existing.isSocket()) throw new LocalRpcError("INVALID_SOCKET_PATH", `${path} exists and is not a socket`)
    if (await socketAcceptsConnections(path)) {
        throw new LocalRpcError("SOCKET_IN_USE", `another server is listening on ${path}`)
    }
    await unlink(path)
}

const wireError = (id: string, error: LocalRpcError): WireResponse => ({
    version: PROTOCOL_VERSION,
    id,
    ok: false,
    error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.details === undefined ? {} : { details: error.details }),
    },
})

const jsonDetails = (value: unknown): JsonValue | undefined => {
    try {
        return JSON.parse(JSON.stringify(value)) as JsonValue
    } catch {
        return undefined
    }
}

/** Create a typed local RPC server plugin. */
export const localRpcPlugin = (options: LocalRpcOptions): LocalRpcPlugin => {
    const routes = new Map<string, RegisteredRoute>()
    const connections = new Set<ConnectionState>()
    const active = new Set<Promise<void>>()
    let listener: Server | undefined
    let socketIdentity: { dev: bigint; ino: bigint } | undefined
    let reportFailure: (error: unknown) => void = () => undefined
    let ready = false
    let stopping = false

    const route: LocalRpcApi["route"] = (method, handler) => {
        if (routes.has(method.method))
            throw new LocalRpcError("DUPLICATE_METHOD", `method ${method.method} is registered twice`)
        routes.set(method.method, {
            request: method.request,
            response: method.response,
            handler: handler,
        })
    }

    const send = (socket: Socket, response: WireResponse): void => {
        if (!socket.destroyed) socket.end(encodeFrame(response))
    }

    const dispatch = async (state: ConnectionState, peer: LocalRpcPeer, raw: unknown): Promise<void> => {
        const request = parseRequest(raw)
        if (!request) {
            send(state.socket, wireError("", new LocalRpcError("INVALID_REQUEST", "invalid local RPC envelope")))
            return
        }
        if (request.idempotencyKey && Buffer.byteLength(request.idempotencyKey) > MAX_IDEMPOTENCY_KEY_BYTES) {
            send(
                state.socket,
                wireError(request.id, new LocalRpcError("INVALID_REQUEST", "idempotency key is too long")),
            )
            return
        }
        const registered = routes.get(request.method)
        if (!registered) {
            send(
                state.socket,
                wireError(request.id, new LocalRpcError("METHOD_NOT_FOUND", `unknown method ${request.method}`)),
            )
            return
        }
        const parsed = registered.request.safeParse(request.input)
        if (!parsed.success) {
            send(
                state.socket,
                wireError(
                    request.id,
                    new LocalRpcError("INVALID_REQUEST", "request validation failed", {
                        details: jsonDetails(parsed.error.issues),
                    }),
                ),
            )
            return
        }

        const controller = new AbortController()
        const timeout = setTimeout(() => {
            controller.abort()
        }, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
        timeout.unref()
        const handlerOperation = Promise.resolve().then(() =>
            registered.handler(parsed.data, {
                peer,
                requestId: request.id,
                ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
                signal: controller.signal,
            }),
        )
        const trackedHandler = handlerOperation.then(
            () => undefined,
            () => undefined,
        )
        active.add(trackedHandler)
        void trackedHandler.finally(() => active.delete(trackedHandler))
        try {
            const result = await Promise.race([
                handlerOperation,
                new Promise<never>((_resolve, reject) => {
                    controller.signal.addEventListener(
                        "abort",
                        () => {
                            reject(
                                new LocalRpcError("REQUEST_TIMEOUT", "local RPC handler timed out", {
                                    retryable: true,
                                }),
                            )
                        },
                        { once: true },
                    )
                }),
            ])
            const response = registered.response.safeParse(result)
            if (!response.success) {
                reportFailure(response.error)
                send(
                    state.socket,
                    wireError(request.id, new LocalRpcError("INVALID_RESPONSE", "response validation failed")),
                )
                return
            }
            send(state.socket, { version: PROTOCOL_VERSION, id: request.id, ok: true, result: response.data })
        } catch (error) {
            if (error instanceof LocalRpcError) send(state.socket, wireError(request.id, error))
            else {
                reportFailure(error)
                send(
                    state.socket,
                    wireError(request.id, new LocalRpcError("INTERNAL_ERROR", "local RPC handler failed")),
                )
            }
        } finally {
            clearTimeout(timeout)
        }
    }

    const accept = (socket: Socket): void => {
        if (stopping || !ready) {
            socket.destroy()
            return
        }
        let peer: LocalRpcPeer
        try {
            peer = readPeerCredentials(socket)
        } catch (error) {
            socket.destroy()
            reportFailure(error)
            return
        }
        const state: ConnectionState = { socket, dispatched: false }
        connections.add(state)
        let buffer = Buffer.alloc(0)
        let expected: number | undefined
        socket.setTimeout(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, () => {
            if (!state.dispatched) socket.destroy()
        })
        socket.on("data", chunk => {
            if (state.dispatched) {
                socket.destroy()
                return
            }
            buffer = Buffer.concat([buffer, chunk])
            if (expected === undefined && buffer.length >= HEADER_BYTES) {
                expected = buffer.readUInt32BE(0)
                if (expected > (options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES)) {
                    state.dispatched = true
                    send(
                        socket,
                        wireError("", new LocalRpcError("REQUEST_TOO_LARGE", "local RPC request is too large")),
                    )
                    return
                }
            }
            if (expected === undefined || buffer.length < HEADER_BYTES + expected) return
            if (buffer.length !== HEADER_BYTES + expected) {
                state.dispatched = true
                send(socket, wireError("", new LocalRpcError("INVALID_REQUEST", "request contains trailing data")))
                return
            }
            state.dispatched = true
            socket.setTimeout(0)
            let decoded: unknown
            try {
                decoded = decodeJson(buffer.subarray(HEADER_BYTES))
            } catch {
                send(socket, wireError("", new LocalRpcError("INVALID_REQUEST", "request is not valid JSON")))
                return
            }
            const operation = dispatch(state, peer, decoded)
            active.add(operation)
            void operation.finally(() => active.delete(operation))
        })
        socket.once("close", () => connections.delete(state))
        socket.once("error", error => {
            reportFailure(error)
        })
    }

    const plugin = definePlugin<LocalRpcApi, NoEvents>({
        name: "local-rpc",
        init: ctx => {
            reportFailure = ctx.fail
            ctx.onStop(async () => {
                stopping = true
                ready = false
                listener?.close()
                listener = undefined
                for (const connection of connections) if (!connection.dispatched) connection.socket.destroy()
                await Promise.allSettled([...active])
                for (const connection of connections) connection.socket.destroy()
                try {
                    const current = await lstat(options.socketPath, { bigint: true })
                    if (socketIdentity?.dev === current.dev && socketIdentity.ino === current.ino) {
                        await unlink(options.socketPath)
                    }
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
                }
            })
            return { route }
        },
        setup: async () => {
            stopping = false
            ready = false
            await clearStaleSocket(options.socketPath)
            listener = createServer(accept)
            try {
                await new Promise<void>((resolve, reject) => {
                    const onError = (error: Error): void => {
                        listener?.off("listening", onListening)
                        reject(error)
                    }
                    const onListening = (): void => {
                        listener?.off("error", onError)
                        resolve()
                    }
                    listener?.once("error", onError)
                    listener?.once("listening", onListening)
                    listener?.listen(options.socketPath)
                })
                listener.on("error", reportFailure)
                const [uid, gid] = await Promise.all([resolveUid(options.owner), resolveGid(options.group)])
                if (uid !== undefined || gid !== undefined) await chown(options.socketPath, uid ?? -1, gid ?? -1)
                await chmod(options.socketPath, options.mode ?? DEFAULT_MODE)
                const created = await lstat(options.socketPath, { bigint: true })
                socketIdentity = { dev: created.dev, ino: created.ino }
                ready = true
            } catch (error) {
                listener.close()
                listener = undefined
                await unlink(options.socketPath).catch(() => undefined)
                throw error
            }
        },
    })

    return Object.assign(plugin, { route })
}
