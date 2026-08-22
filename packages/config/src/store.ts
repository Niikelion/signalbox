import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { access, chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { SignalboxError, isRoot } from "@signalbox/core"
import {
    assertJsonValue,
    decryptSecret,
    encryptSecret,
    EnvKeySource,
    FileKeyBackend,
    parseEnvelope,
    REDACTED,
    resolveKey,
    resolveOrProvisionKey,
    Secret,
    type KeyMaterial,
    type KeySource,
} from "@signalbox/secrets"
import type { z } from "zod"
import { baseKind, isSecret } from "./introspect.js"
import type { ConfigOf, ConfigSchema, InputOf } from "./schema.js"

export interface ConfigInspection {
    readonly values: Record<string, unknown>
    readonly secrets: Record<
        string,
        {
            readonly state: "absent" | "plaintext" | "encrypted"
            readonly version?: number
            readonly keyId?: string
        }
    >
}

/** A read/write config store for one app's schema. */
export interface ConfigStore<TSchema extends ConfigSchema> {
    readonly path: string
    readonly schema: TSchema
    exists(): Promise<boolean>
    load(): Promise<ConfigOf<TSchema>>
    readPartial(): Promise<Partial<ConfigOf<TSchema>>>
    save(values: Partial<InputOf<TSchema>>): Promise<void>
    set(key: string, rawValue: string): Promise<void>
    unset(key: string): Promise<void>
    coerce(key: string, rawValue: string): unknown
    redacted(values: Partial<ConfigOf<TSchema>>): Promise<Record<string, unknown>>
    inspect(): Promise<ConfigInspection>
}

/** Options for createConfigStore. */
export interface ConfigStoreOptions<TSchema extends ConfigSchema> {
    readonly appName: string
    readonly schema: TSchema
    readonly path?: string
    /** Use one explicit source instead of automatic environment/file selection. */
    readonly keySource?: KeySource
}

interface DecodedDocument {
    readonly plaintext: Record<string, unknown>
    readonly hasLegacySecrets: boolean
}

const delay = async (milliseconds: number): Promise<void> =>
    new Promise(resolve => {
        setTimeout(resolve, milliseconds)
    })

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)

/** Create an async encrypted config store for an app. Construction itself performs no I/O. */
export const createConfigStore = <TSchema extends ConfigSchema>(
    options: ConfigStoreOptions<TSchema>,
): ConfigStore<TSchema> => {
    const { appName, schema } = options
    const shape = schema.shape as Record<string, z.ZodType>
    const keys = Object.keys(shape)
    const secretEntries = Object.entries(shape).filter(([, fieldSchema]) => isSecret(fieldSchema))

    const systemPath = `/etc/${appName}/config.json`
    const xdgConfigHome = process.env["XDG_CONFIG_HOME"]
    const configHome = xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : join(homedir(), ".config")
    const userPath = join(configHome, appName, "config.json")
    const fromEnvironment = process.env[`${appName.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}_CONFIG`]
    const path = options.path ?? fromEnvironment ?? (isRoot() ? systemPath : userPath)
    const lockPath = `${path}.lock`
    const sources: readonly KeySource[] = options.keySource
        ? [options.keySource]
        : [new EnvKeySource(), new FileKeyBackend({ configPath: path })]

    const fieldOf = (key: string): z.ZodType => {
        const field = shape[key]
        if (!field) throw new SignalboxError(`unknown config key "${key}"`, `known keys: ${keys.join(", ")}`)
        return field
    }

    const coerce = (key: string, rawValue: string): unknown => {
        const field = fieldOf(key)
        switch (baseKind(field)) {
            case "array":
                return rawValue
                    .split(",")
                    .map(entry => entry.trim())
                    .filter(Boolean)
            case "number": {
                const parsed = Number(rawValue)
                if (!Number.isFinite(parsed)) throw new SignalboxError(`${key} must be a number`)
                return parsed
            }
            case "boolean":
                if (rawValue !== "true" && rawValue !== "false") {
                    throw new SignalboxError(`${key} must be true or false`)
                }
                return rawValue === "true"
            default:
                return rawValue
        }
    }

    const exists = async (): Promise<boolean> => {
        try {
            await access(path, constants.F_OK)
            return true
        } catch {
            return false
        }
    }

    const readRaw = async (): Promise<Record<string, unknown> | null> => {
        let text: string
        try {
            text = await readFile(path, "utf8")
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
            throw error
        }
        let parsed: unknown
        try {
            parsed = JSON.parse(text) as unknown
        } catch (error) {
            throw new SignalboxError(`config at ${path} is not valid JSON: ${(error as Error).message}`)
        }
        if (!isRecord(parsed)) throw new SignalboxError(`config at ${path} must contain a JSON object`)
        return parsed
    }

    const atomicWrite = async (document: Record<string, unknown>): Promise<void> => {
        const directory = dirname(path)
        await mkdir(directory, { recursive: true, mode: 0o750 })
        await chmod(directory, 0o750)
        const temporary = join(directory, `.${process.pid}-${randomBytes(8).toString("hex")}.tmp`)
        const handle = await open(temporary, "wx", 0o600)
        try {
            await handle.writeFile(`${JSON.stringify(document, null, 4)}\n`, "utf8")
            await handle.sync()
        } catch (error) {
            await handle.close()
            await rm(temporary, { force: true })
            throw error
        }
        await handle.close()
        try {
            await chmod(temporary, 0o640)
            await rename(temporary, path)
        } catch (error) {
            await rm(temporary, { force: true })
            throw error
        }
        try {
            const directoryHandle = await open(directory, "r")
            try {
                await directoryHandle.sync()
            } finally {
                await directoryHandle.close()
            }
        } catch {
            // Directory fsync is not available on every supported platform.
        }
    }

    const withLock = async <T>(action: () => Promise<T>): Promise<T> => {
        await mkdir(dirname(path), { recursive: true, mode: 0o750 })
        for (let attempt = 0; attempt < 120; attempt += 1) {
            try {
                const handle = await open(lockPath, "wx", 0o600)
                try {
                    return await action()
                } finally {
                    await handle.close()
                    await rm(lockPath, { force: true })
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
                try {
                    const lock = await stat(lockPath)
                    if (Date.now() - lock.mtimeMs > 30_000) await rm(lockPath, { force: true })
                } catch (lockError) {
                    if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError
                }
                await delay(25)
            }
        }
        throw new SignalboxError(`timed out waiting for config lock ${lockPath}`)
    }

    const missingKey = (keyId?: string): SignalboxError =>
        new SignalboxError(
            keyId
                ? `no key is available for encrypted config key ${keyId}`
                : `no encryption key is available for ${appName}`,
            options.keySource
                ? `the explicit ${options.keySource.name} source must provide the required key`
                : `set ${appName.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}_CONFIG_KEY or allow the file fallback`,
        )

    const resolveExistingKey = async (keyId: string): Promise<KeyMaterial> => {
        const resolved = await resolveKey(sources, appName, keyId)
        if (!resolved) throw missingKey(keyId)
        return resolved.material
    }

    const resolveWriteKey = async (): Promise<KeyMaterial> => {
        try {
            return (await resolveOrProvisionKey(sources, appName)).material
        } catch (error) {
            if (error instanceof SignalboxError) throw error
            throw new SignalboxError(`cannot obtain an encryption key for ${appName}: ${(error as Error).message}`)
        }
    }

    const fieldError = (key: string, issues: readonly z.core.$ZodIssue[]): SignalboxError =>
        new SignalboxError(`invalid value for ${key}: ${issues.map(issue => issue.message).join(", ")}`)

    const validateField = (key: string, value: unknown): unknown => {
        const result = fieldOf(key).safeParse(value)
        if (!result.success) throw fieldError(key, result.error.issues)
        return result.data
    }

    const validateFull = (document: Record<string, unknown>): Record<string, unknown> => {
        const result = schema.safeParse(document)
        if (!result.success) {
            const problems = result.error.issues.map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            throw new SignalboxError(`config at ${path} is invalid: ${problems.join("; ")}`)
        }
        return result.data
    }

    const decodeDocument = async (raw: Record<string, unknown>): Promise<DecodedDocument> => {
        const plaintext = { ...raw }
        let hasLegacySecrets = false
        const keyCache = new Map<string, Promise<KeyMaterial>>()
        for (const [key, fieldSchema] of secretEntries) {
            if (!(key in raw)) continue
            const stored = raw[key]
            let value: unknown
            if (typeof stored === "string" && stored.startsWith("enc:")) {
                const envelope = parseEnvelope(stored)
                let keyPromise = keyCache.get(envelope.keyId)
                if (!keyPromise) {
                    keyPromise = resolveExistingKey(envelope.keyId)
                    keyCache.set(envelope.keyId, keyPromise)
                }
                value = decryptSecret(stored, (await keyPromise).key, { appName, fieldName: key })
            } else {
                hasLegacySecrets = true
                value = stored
            }
            const result = fieldSchema.safeParse(value)
            if (!result.success) throw fieldError(key, result.error.issues)
            assertJsonValue(result.data, key)
            plaintext[key] = result.data
        }
        return { plaintext, hasLegacySecrets }
    }

    const encryptDocument = async (
        input: Record<string, unknown>,
        preserveUnknown = false,
    ): Promise<Record<string, unknown>> => {
        const output: Record<string, unknown> = {}
        const writeKey = secretEntries.length > 0 ? await resolveWriteKey() : null
        for (const [key, value] of Object.entries(input)) {
            const fieldSchema = shape[key]
            if (!fieldSchema) {
                if (preserveUnknown) {
                    output[key] = value
                    continue
                }
                throw new SignalboxError(`unknown config key "${key}"`, `known keys: ${keys.join(", ")}`)
            }
            const parsed = validateField(key, value)
            if (parsed === undefined) continue
            if (isSecret(fieldSchema)) {
                assertJsonValue(parsed, key)
                if (!writeKey) throw missingKey()
                output[key] = encryptSecret(parsed, writeKey.key, { appName, fieldName: key })
            } else {
                output[key] = parsed
            }
        }
        return output
    }

    const wrapDocument = (plaintext: Record<string, unknown>): Record<string, unknown> => {
        const output = { ...plaintext }
        for (const [key] of secretEntries) {
            if (!(key in output) || output[key] === undefined) continue
            assertJsonValue(output[key], key)
            output[key] = Secret.from(output[key])
        }
        return output
    }

    const migrateLocked = async (raw: Record<string, unknown>): Promise<DecodedDocument> => {
        const decoded = await decodeDocument(raw)
        if (!decoded.hasLegacySecrets) return decoded
        validateFull(decoded.plaintext)
        await atomicWrite(await encryptDocument(decoded.plaintext, true))
        return decoded
    }

    const readDecoded = async (): Promise<DecodedDocument | null> => {
        const raw = await readRaw()
        if (!raw) return null
        const decoded = await decodeDocument(raw)
        if (!decoded.hasLegacySecrets) return decoded
        return withLock(async () => {
            const current = await readRaw()
            return current ? migrateLocked(current) : null
        })
    }

    const readPartial = async (): Promise<Partial<ConfigOf<TSchema>>> => {
        const decoded = await readDecoded()
        return (decoded ? wrapDocument(decoded.plaintext) : {}) as Partial<ConfigOf<TSchema>>
    }

    const load = async (): Promise<ConfigOf<TSchema>> => {
        const decoded = await readDecoded()
        if (!decoded) {
            throw new SignalboxError(`no config at ${path}`, `run \`${appName} config init\` to create one`)
        }
        return wrapDocument(validateFull(decoded.plaintext)) as ConfigOf<TSchema>
    }

    const save = async (values: Partial<InputOf<TSchema>>): Promise<void> => {
        await withLock(async () => atomicWrite(await encryptDocument(values as Record<string, unknown>)))
    }

    const update = async (change: (current: Record<string, unknown>) => void): Promise<void> => {
        await withLock(async () => {
            const raw = await readRaw()
            const decoded = raw ? await decodeDocument(raw) : { plaintext: {}, hasLegacySecrets: false }
            change(decoded.plaintext)
            await atomicWrite(await encryptDocument(decoded.plaintext, true))
        })
    }

    const inspect = async (): Promise<ConfigInspection> => {
        const raw = (await readRaw()) ?? {}
        const values = { ...raw }
        const secretStates: ConfigInspection["secrets"] = {}
        for (const [key] of secretEntries) {
            if (!(key in raw)) {
                secretStates[key] = { state: "absent" }
                continue
            }
            const stored = raw[key]
            if (typeof stored === "string" && stored.startsWith("enc:")) {
                const envelope = parseEnvelope(stored)
                secretStates[key] = { state: "encrypted", version: envelope.version, keyId: envelope.keyId }
            } else {
                secretStates[key] = { state: "plaintext" }
            }
            values[key] = REDACTED
        }
        return { values, secrets: secretStates }
    }

    return {
        path,
        schema,
        exists,
        load,
        readPartial,
        save,
        coerce,
        set: async (key, rawValue) => {
            const fieldSchema = fieldOf(key)
            const parsed = validateField(key, coerce(key, rawValue))
            if (isSecret(fieldSchema)) assertJsonValue(parsed, key)
            await update(current => {
                current[key] = parsed
            })
        },
        unset: async key => {
            fieldOf(key)
            await update(current => {
                Reflect.deleteProperty(current, key)
            })
        },
        redacted: async values => {
            const output: Record<string, unknown> = { ...(values as Record<string, unknown>) }
            for (const [key] of secretEntries) {
                if (key in output) output[key] = REDACTED
            }
            return output
        },
        inspect,
    }
}
