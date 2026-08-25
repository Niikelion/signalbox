import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { decodeJsonValue, encodeJsonValue, type JsonValue } from "./json"

export const ENCRYPTED_PREFIX = "enc:"
export const ENVELOPE_VERSION = 1 as const

export interface EncryptionContext {
    readonly appName: string
    readonly fieldName: string
}

export interface ParsedEnvelope {
    readonly version: 1
    readonly keyId: string
    readonly nonce: Uint8Array
    readonly ciphertext: Uint8Array
    readonly tag: Uint8Array
}

const base64UrlPattern = /^[A-Za-z0-9_-]+$/u

const decodeBase64Url = (value: string, label: string, expectedLength?: number): Uint8Array => {
    if (!base64UrlPattern.test(value)) throw new Error(`invalid encrypted secret: ${label} is not base64url`)
    const decoded = Buffer.from(value, "base64url")
    if (decoded.toString("base64url") !== value) throw new Error(`invalid encrypted secret: ${label} is not canonical`)
    if (expectedLength !== undefined && decoded.length !== expectedLength) {
        throw new Error(`invalid encrypted secret: ${label} must decode to ${expectedLength} bytes`)
    }
    return Uint8Array.from(decoded)
}

const requireKey = (key: Uint8Array): Buffer => {
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error("secret encryption key must be 32 bytes")
    return Buffer.from(key)
}

const aad = (keyId: string, context: EncryptionContext): Buffer =>
    Buffer.from(JSON.stringify(["enc:1", keyId, context.appName, context.fieldName]), "utf8")

/** Derive the stable, non-secret identifier for a 32-byte data key. */
export const deriveKeyId = (key: Uint8Array): string => createHash("sha256").update(requireKey(key)).digest("base64url")

/** Strictly parse an encrypted secret envelope without decrypting it. */
export const parseEnvelope = (value: string): ParsedEnvelope => {
    if (!value.startsWith(ENCRYPTED_PREFIX)) throw new Error("value is not an encrypted secret envelope")
    const parts = value.split(":")
    if (parts.length !== 6) throw new Error("invalid encrypted secret: expected 6 envelope segments")
    const [prefix, version, keyId, nonce, ciphertext, tag] = parts
    if (prefix !== "enc") throw new Error("invalid encrypted secret prefix")
    if (version !== "1") throw new Error(`unsupported encrypted secret version "${version ?? ""}"`)
    if (!keyId || !nonce || !ciphertext || !tag) throw new Error("invalid encrypted secret: empty envelope segment")
    decodeBase64Url(keyId, "key ID", 32)
    return {
        version: 1,
        keyId,
        nonce: decodeBase64Url(nonce, "nonce", 12),
        ciphertext: decodeBase64Url(ciphertext, "ciphertext"),
        tag: decodeBase64Url(tag, "authentication tag", 16),
    }
}

/** Encrypt one JSON-compatible config field into an enc:1 envelope. */
export const encryptSecret = (value: JsonValue, key: Uint8Array, context: EncryptionContext): string => {
    const copiedKey = requireKey(key)
    const keyId = deriveKeyId(copiedKey)
    const nonce = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", copiedKey, nonce, { authTagLength: 16 })
    cipher.setAAD(aad(keyId, context))
    const ciphertext = Buffer.concat([cipher.update(encodeJsonValue(value)), cipher.final()])
    return `enc:1:${keyId}:${nonce.toString("base64url")}:${ciphertext.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}`
}

/** Decrypt and JSON-decode one config field, authenticating its app and field slot. */
export const decryptSecret = (envelope: string, key: Uint8Array, context: EncryptionContext): JsonValue => {
    const parsed = parseEnvelope(envelope)
    const copiedKey = requireKey(key)
    if (deriveKeyId(copiedKey) !== parsed.keyId) throw new Error(`no matching key for encrypted secret ${parsed.keyId}`)
    try {
        const decipher = createDecipheriv("aes-256-gcm", copiedKey, parsed.nonce, { authTagLength: 16 })
        decipher.setAAD(aad(parsed.keyId, context))
        decipher.setAuthTag(parsed.tag)
        const plaintext = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()])
        return decodeJsonValue(plaintext)
    } catch (error) {
        if (error instanceof TypeError && error.message.includes("JSON")) throw error
        throw new Error("encrypted secret authentication failed", { cause: error })
    }
}
