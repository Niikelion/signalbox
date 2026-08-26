import { randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import type { z } from "zod"
import { decodeJson, encodeFrame, HEADER_BYTES, parseResponse, PROTOCOL_VERSION } from "./protocol"
import { LocalRpcError, type LocalRpcCallOptions, type LocalRpcMethod } from "./types"

export interface LocalRpcClientOptions {
    readonly socketPath: string
    readonly timeoutMs?: number
    readonly maxResponseBytes?: number
}

export interface LocalRpcClient {
    call<TRequest extends z.ZodType, TResponse extends z.ZodType>(
        method: LocalRpcMethod<TRequest, TResponse>,
        input: z.input<TRequest>,
        options?: LocalRpcCallOptions,
    ): Promise<z.output<TResponse>>
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024

/** Create a standalone client for a local RPC plugin. */
export const createLocalRpcClient = (clientOptions: LocalRpcClientOptions): LocalRpcClient => ({
    call: async (method, input, options = {}) => {
        const parsedInput = method.request.parse(input)
        const id = randomUUID()
        if (options.signal?.aborted) {
            const reason = Reflect.get(options.signal, "reason") as unknown
            throw reason instanceof Error ? reason : new LocalRpcError("ABORTED", "local RPC call aborted")
        }
        return new Promise((resolve, reject) => {
            const socket: Socket = createConnection(clientOptions.socketPath)
            let buffer = Buffer.alloc(0)
            let expected: number | undefined
            let settled = false
            const finish = (error?: unknown, result?: unknown): void => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                options.signal?.removeEventListener("abort", abort)
                socket.destroy()
                if (error !== undefined) {
                    reject(error instanceof Error ? error : new Error("local RPC rejected with a non-error value"))
                } else resolve(method.response.parse(result))
            }
            const abort = (): void => {
                finish(options.signal?.reason ?? new LocalRpcError("ABORTED", "local RPC call aborted"))
            }
            const timeout = setTimeout(
                () => {
                    finish(new LocalRpcError("REQUEST_TIMEOUT", "local RPC call timed out", { retryable: true }))
                },
                options.timeoutMs ?? clientOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            )
            timeout.unref()
            options.signal?.addEventListener("abort", abort, { once: true })
            socket.once("connect", () => {
                socket.write(
                    encodeFrame({
                        version: PROTOCOL_VERSION,
                        id,
                        method: method.method,
                        input: parsedInput,
                        ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
                    }),
                )
            })
            socket.on("data", chunk => {
                buffer = Buffer.concat([buffer, chunk])
                if (expected === undefined && buffer.length >= HEADER_BYTES) {
                    expected = buffer.readUInt32BE(0)
                    if (expected > (clientOptions.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES)) {
                        finish(new LocalRpcError("RESPONSE_TOO_LARGE", "local RPC response is too large"))
                        return
                    }
                }
                if (expected === undefined || buffer.length < HEADER_BYTES + expected) return
                if (buffer.length !== HEADER_BYTES + expected) {
                    finish(new LocalRpcError("INVALID_RESPONSE", "local RPC response contains trailing data"))
                    return
                }
                let decoded: unknown
                try {
                    decoded = decodeJson(buffer.subarray(HEADER_BYTES))
                } catch {
                    finish(new LocalRpcError("INVALID_RESPONSE", "local RPC response is not valid JSON"))
                    return
                }
                const response = parseResponse(decoded)
                if (response?.id !== id) {
                    finish(new LocalRpcError("INVALID_RESPONSE", "invalid local RPC response envelope"))
                    return
                }
                if (response.ok) finish(undefined, response.result)
                else finish(new LocalRpcError(response.error.code, response.error.message, response.error))
            })
            socket.once("error", finish)
            socket.once("end", () => {
                if (!settled) finish(new LocalRpcError("CONNECTION_CLOSED", "local RPC server closed the connection"))
            })
        })
    },
})
