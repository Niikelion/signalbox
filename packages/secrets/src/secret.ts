import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { decodeJsonValue, encodeJsonValue, type JsonValue } from "./json"

export const REDACTED = "[redacted]" as const

interface WrappedParts {
    readonly nonce: Buffer
    readonly ciphertext: Buffer
    readonly tag: Buffer
}

interface RedactionService {
    readonly protocolVersion: 1
    register(wrapper: object, value: JsonValue): void
    reveal(wrapper: object): JsonValue
    isSecret(value: unknown): boolean
    redactString(value: string): string
}

interface RegistryEntry {
    readonly length: number
    readonly fingerprint: string
    readonly reference: WeakRef<object>
}

const rendezvous = Symbol.for("@signalbox/secrets:redactor")

const installService = (): RedactionService => {
    const wrapperKey = randomBytes(32)
    const redactionKey = randomBytes(32)
    const wrappers = new WeakSet<object>()
    const wrappedParts = new WeakMap<object, WrappedParts>()
    const index = new Map<number, Map<string, Set<WeakRef<object>>>>()

    const fingerprint = (value: Uint8Array): string =>
        createHmac("sha256", redactionKey).update(value).digest("base64url")

    const removeEntry = ({ length, fingerprint: digest, reference }: RegistryEntry): void => {
        const byFingerprint = index.get(length)
        const bucket = byFingerprint?.get(digest)
        bucket?.delete(reference)
        if (bucket?.size === 0) byFingerprint?.delete(digest)
        if (byFingerprint?.size === 0) index.delete(length)
    }
    const finalizer = new FinalizationRegistry<RegistryEntry>(removeEntry)

    const encrypt = (value: JsonValue): WrappedParts => {
        const nonce = randomBytes(12)
        const cipher = createCipheriv("aes-256-gcm", wrapperKey, nonce, { authTagLength: 16 })
        const ciphertext = Buffer.concat([cipher.update(encodeJsonValue(value)), cipher.final()])
        return { nonce, ciphertext, tag: cipher.getAuthTag() }
    }

    const reveal = (wrapper: object): JsonValue => {
        const parts = wrappedParts.get(wrapper)
        if (!parts) throw new TypeError("value is not a Secret created in this process")
        const decipher = createDecipheriv("aes-256-gcm", wrapperKey, parts.nonce, { authTagLength: 16 })
        decipher.setAuthTag(parts.tag)
        return decodeJsonValue(Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]))
    }

    const registerString = (wrapper: object, value: string): void => {
        if (Array.from(value).length < 3) return
        const bytes = Buffer.from(value, "utf8")
        const digest = fingerprint(bytes)
        let byFingerprint = index.get(bytes.length)
        if (!byFingerprint) {
            byFingerprint = new Map()
            index.set(bytes.length, byFingerprint)
        }
        let bucket = byFingerprint.get(digest)
        if (!bucket) {
            bucket = new Set()
            byFingerprint.set(digest, bucket)
        }
        const reference = new WeakRef(wrapper)
        bucket.add(reference)
        const entry = { length: bytes.length, fingerprint: digest, reference }
        finalizer.register(wrapper, entry, wrapper)
    }

    const redactString = (value: string): string => {
        if (index.size === 0 || value.length === 0) return value
        const bytes = Buffer.from(value, "utf8")
        const matches: { start: number; length: number }[] = []
        for (const [length, byFingerprint] of index) {
            if (length > bytes.length) continue
            for (let start = 0; start <= bytes.length - length; start += 1) {
                const window = bytes.subarray(start, start + length)
                const bucket = byFingerprint.get(fingerprint(window))
                if (!bucket) continue
                for (const reference of bucket) {
                    const wrapper = reference.deref()
                    if (!wrapper) {
                        bucket.delete(reference)
                        continue
                    }
                    const candidate = reveal(wrapper)
                    if (typeof candidate !== "string") continue
                    const candidateBytes = Buffer.from(candidate, "utf8")
                    if (candidateBytes.length === window.length && timingSafeEqual(candidateBytes, window)) {
                        matches.push({ start, length })
                        break
                    }
                }
            }
        }
        if (matches.length === 0) return value
        matches.sort((left, right) => left.start - right.start || right.length - left.length)
        const output: Buffer[] = []
        let cursor = 0
        for (const match of matches) {
            if (match.start < cursor) continue
            output.push(bytes.subarray(cursor, match.start), Buffer.from(REDACTED))
            cursor = match.start + match.length
        }
        output.push(bytes.subarray(cursor))
        return Buffer.concat(output).toString("utf8")
    }

    return Object.freeze({
        protocolVersion: 1 as const,
        register: (wrapper: object, value: JsonValue) => {
            if (wrappers.has(wrapper)) throw new TypeError("Secret wrapper is already initialized")
            const parts = encrypt(value)
            wrappers.add(wrapper)
            wrappedParts.set(wrapper, parts)
            if (typeof value === "string") registerString(wrapper, value)
        },
        reveal,
        isSecret: (value: unknown): boolean => typeof value === "object" && value !== null && wrappers.has(value),
        redactString,
    })
}

const globalRecord = globalThis as typeof globalThis & Record<symbol, unknown>
const existingService = globalRecord[rendezvous]
if (existingService !== undefined) {
    const protocol = (existingService as Partial<RedactionService>).protocolVersion
    if (protocol !== 1) throw new Error(`incompatible @signalbox/secrets redactor protocol ${String(protocol)}`)
}
const service = (existingService as RedactionService | undefined) ?? installService()
if (existingService === undefined) {
    Object.defineProperty(globalRecord, rendezvous, {
        value: service,
        enumerable: false,
        configurable: false,
        writable: false,
    })
}

/** A JSON-compatible secret protected by process-local authenticated encryption. */
export class Secret<T extends JsonValue> {
    private constructor(value: T) {
        service.register(this, value)
    }

    /** Protect a value and register it with the process-global redactor. */
    static from<T extends JsonValue>(value: T): Secret<T> {
        return new Secret(value)
    }

    get redacted(): typeof REDACTED {
        return REDACTED
    }

    /** Explicitly reveal a fresh JSON-decoded value. */
    reveal(): T {
        return service.reveal(this) as T
    }

    toJSON(): typeof REDACTED {
        return REDACTED
    }

    toString(): typeof REDACTED {
        return REDACTED
    }

    [Symbol.toPrimitive](): typeof REDACTED {
        return REDACTED
    }
}

/** Recognize Secret wrappers created by any compatible package copy in this process. */
export const isSecret = (value: unknown): value is Secret<JsonValue> => service.isSecret(value)

const redactValue = (value: unknown, seen: WeakMap<object, unknown>): unknown => {
    if (isSecret(value)) return REDACTED
    if (typeof value === "string") return service.redactString(value)
    if (value === null || typeof value !== "object") return value
    const previous = seen.get(value)
    if (previous !== undefined) return previous

    if (Array.isArray(value)) {
        const output: unknown[] = []
        seen.set(value, output)
        for (const entry of value) output.push(redactValue(entry, seen))
        return output
    }
    if (value instanceof Map) {
        const output = new Map<unknown, unknown>()
        seen.set(value, output)
        for (const [key, entry] of value) output.set(redactValue(key, seen), redactValue(entry, seen))
        return output
    }
    if (value instanceof Set) {
        const output = new Set<unknown>()
        seen.set(value, output)
        for (const entry of value) output.add(redactValue(entry, seen))
        return output
    }

    const prototype = Object.getPrototypeOf(value) as object | null
    const output = Object.create(prototype) as Record<PropertyKey, unknown>
    seen.set(value, output)
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor) continue
        if ("value" in descriptor) descriptor.value = redactValue(descriptor.value, seen)
        Object.defineProperty(output, key, descriptor)
    }
    return output
}

/** Return a recursively sanitized copy without mutating or revealing wrappers. */
export const redact = <T>(value: T): T => redactValue(value, new WeakMap()) as T
