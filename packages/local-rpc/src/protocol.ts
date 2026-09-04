import type { JsonValue } from "@signalbox/core"

export const PROTOCOL_VERSION = 1
export const HEADER_BYTES = 4

export interface WireRequest {
    readonly version: 1
    readonly id: string
    readonly method: string
    readonly input: unknown
    readonly idempotencyKey?: string
}

export type WireResponse =
    | { readonly version: 1; readonly id: string; readonly ok: true; readonly result: unknown }
    | {
          readonly version: 1
          readonly id: string
          readonly ok: false
          readonly error: {
              readonly code: string
              readonly message: string
              readonly details?: JsonValue
              readonly retryable: boolean
          }
      }

export const encodeFrame = (value: unknown): Buffer => {
    const body = Buffer.from(JSON.stringify(value), "utf8")
    const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length)
    frame.writeUInt32BE(body.length, 0)
    body.copy(frame, HEADER_BYTES)
    return frame
}

export const decodeJson = (body: Buffer): unknown => JSON.parse(body.toString("utf8")) as unknown

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)

export const parseRequest = (value: unknown): WireRequest | undefined => {
    if (!isRecord(value)) return undefined
    if (value["version"] !== PROTOCOL_VERSION) return undefined
    if (typeof value["id"] !== "string" || value["id"].length === 0) return undefined
    if (typeof value["method"] !== "string" || value["method"].length === 0) return undefined
    const idempotencyKey = value["idempotencyKey"]
    if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") return undefined
    return {
        version: PROTOCOL_VERSION,
        id: value["id"],
        method: value["method"],
        input: value["input"],
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    }
}

export const parseResponse = (value: unknown): WireResponse | undefined => {
    if (!isRecord(value) || value["version"] !== PROTOCOL_VERSION || typeof value["id"] !== "string") {
        return undefined
    }
    if (value["ok"] === true) {
        return { version: PROTOCOL_VERSION, id: value["id"], ok: true, result: value["result"] }
    }
    if (value["ok"] !== false || !isRecord(value["error"])) return undefined
    const error = value["error"]
    if (typeof error["code"] !== "string" || typeof error["message"] !== "string") return undefined
    return {
        version: PROTOCOL_VERSION,
        id: value["id"],
        ok: false,
        error: {
            code: error["code"],
            message: error["message"],
            retryable: error["retryable"] === true,
            ...(error["details"] === undefined ? {} : { details: error["details"] as JsonValue }),
        },
    }
}
