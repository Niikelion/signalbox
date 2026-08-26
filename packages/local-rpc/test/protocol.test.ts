import { describe, expect, it } from "vitest"
import { decodeJson, encodeFrame, HEADER_BYTES, parseRequest, parseResponse } from "../src/protocol"

describe("local RPC protocol", () => {
    it("should encode a length-prefixed JSON frame", () => {
        const frame = encodeFrame({ value: "hello" })

        expect(frame.readUInt32BE(0)).toBe(frame.length - HEADER_BYTES)
        expect(decodeJson(frame.subarray(HEADER_BYTES))).toEqual({ value: "hello" })
    })

    it("should reject malformed request and response envelopes", () => {
        expect(parseRequest({ version: 2, id: "1", method: "test", input: null })).toBeUndefined()
        expect(parseRequest({ version: 1, id: "", method: "test", input: null })).toBeUndefined()
        expect(parseResponse({ version: 1, id: "1", ok: false, error: {} })).toBeUndefined()
    })
})
