import type { JsonValue } from "@signalbox/core"
import type { z } from "zod"

/** Kernel-authenticated identity captured when a Unix socket connection is accepted. */
export interface LocalRpcPeer {
    readonly uid: number
    readonly gid: number
    readonly pid: number
    readonly supplementaryGids?: readonly number[]
}

/** Metadata passed to a local RPC handler. */
export interface LocalRpcContext {
    readonly peer: LocalRpcPeer
    readonly requestId: string
    readonly idempotencyKey?: string
    readonly signal: AbortSignal
}

/** A typed method shared by local RPC servers and clients. */
export interface LocalRpcMethod<TRequest extends z.ZodType, TResponse extends z.ZodType> {
    readonly method: string
    readonly request: TRequest
    readonly response: TResponse
}

/** Create a typed local RPC method descriptor. */
export const defineLocalRpcMethod = <TRequest extends z.ZodType, TResponse extends z.ZodType>(
    method: LocalRpcMethod<TRequest, TResponse>,
): LocalRpcMethod<TRequest, TResponse> => method

/** A stable, machine-readable error that may cross the RPC boundary. */
export class LocalRpcError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly options: { readonly details?: JsonValue; readonly retryable?: boolean } = {},
    ) {
        super(message)
        this.name = "LocalRpcError"
    }

    get details(): JsonValue | undefined {
        return this.options.details
    }

    get retryable(): boolean {
        return this.options.retryable ?? false
    }
}

export type LocalRpcHandler<TRequest extends z.ZodType, TResponse extends z.ZodType> = (
    input: z.infer<TRequest>,
    context: LocalRpcContext,
) => z.infer<TResponse> | Promise<z.infer<TResponse>>

export interface LocalRpcCallOptions {
    readonly idempotencyKey?: string
    readonly signal?: AbortSignal
    readonly timeoutMs?: number
}
