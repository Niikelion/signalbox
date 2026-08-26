import { randomBytes } from "node:crypto"
import { access, chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { constants } from "node:fs"
import { dirname, join } from "node:path"
import { deriveKeyId } from "./cipher"

export interface KeyMaterial {
    readonly id: string
    readonly key: Uint8Array
}

export interface KeyMetadata {
    readonly id: string
    readonly state: "staged" | "active" | "retired"
    readonly createdAt: string
}

export interface KeySource {
    readonly name: string
    available(): Promise<boolean>
    getKey(appName: string, keyId?: string): Promise<KeyMaterial | null>
}

export interface WritableKeyBackend extends KeySource {
    stageKey(appName: string, key: Uint8Array): Promise<KeyMaterial>
    activateKey(appName: string, keyId: string): Promise<void>
    retireKey(appName: string, keyId: string): Promise<void>
    deleteKey(appName: string, keyId: string): Promise<void>
    listKeys(appName: string): Promise<KeyMetadata[]>
}

export interface ResolvedKey {
    readonly source: KeySource
    readonly material: KeyMaterial
}

const copyMaterial = (key: Uint8Array): KeyMaterial => {
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error("secret encryption key must be 32 bytes")
    const copied = Uint8Array.from(key)
    return { id: deriveKeyId(copied), key: copied }
}

const validateMaterial = (material: KeyMaterial, expectedId?: string): KeyMaterial => {
    const copied = copyMaterial(material.key)
    if (material.id !== copied.id) throw new Error(`key material ID ${material.id} does not match its key bytes`)
    if (expectedId !== undefined && copied.id !== expectedId) {
        throw new Error(`key source returned ${copied.id} when ${expectedId} was requested`)
    }
    return copied
}

const envName = (appName: string): string => `${appName.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}_CONFIG_KEY`

/** Read a single active AES key from an application-specific environment variable. */
export class EnvKeySource implements KeySource {
    readonly name = "env"

    constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

    async available(): Promise<boolean> {
        return true
    }

    async getKey(appName: string, keyId?: string): Promise<KeyMaterial | null> {
        const variable = envName(appName)
        const encoded = this.environment[variable]
        if (encoded === undefined || encoded === "") return null
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
            throw new Error(`${variable} must contain canonical base64`)
        }
        const decoded = Buffer.from(encoded, "base64")
        if (decoded.toString("base64") !== encoded || decoded.byteLength !== 32) {
            throw new Error(`${variable} must contain exactly 32 bytes encoded as base64`)
        }
        const material = copyMaterial(decoded)
        return keyId !== undefined && keyId !== material.id ? null : material
    }
}

interface KeyManifest {
    readonly version: 1
    readonly appName: string
    readonly keys: KeyMetadata[]
}

export interface FileKeyBackendOptions {
    readonly configPath: string
    readonly warn?: (message: string) => void
}

const wait = async (milliseconds: number): Promise<void> =>
    new Promise(resolve => {
        setTimeout(resolve, milliseconds)
    })

/** A writable key backend stored beside the config file as an explicit insecure fallback. */
export class FileKeyBackend implements WritableKeyBackend {
    readonly name = "file"
    readonly directory: string
    private readonly manifestPath: string
    private readonly lockPath: string
    private readonly warn: (message: string) => void

    constructor(options: FileKeyBackendOptions) {
        this.directory = `${options.configPath}.keys`
        this.manifestPath = join(this.directory, "manifest.json")
        this.lockPath = join(this.directory, ".lock")
        this.warn =
            options.warn ??
            (message => {
                process.emitWarning(message, { code: "SIGNALBOX_INSECURE_KEY_STORAGE" })
            })
    }

    async available(): Promise<boolean> {
        try {
            await access(this.directory, constants.R_OK | constants.W_OK)
            return true
        } catch {
            let candidate = dirname(this.directory)
            for (;;) {
                try {
                    await access(candidate, constants.W_OK)
                    return true
                } catch {
                    const parent = dirname(candidate)
                    if (parent === candidate) return false
                    candidate = parent
                }
            }
        }
    }

    async getKey(appName: string, keyId?: string): Promise<KeyMaterial | null> {
        const manifest = await this.readManifest(appName)
        if (!manifest) return null
        const metadata = keyId
            ? manifest.keys.find(item => item.id === keyId)
            : manifest.keys.find(item => item.state === "active")
        if (!metadata) return null
        this.emitWarning()
        const key = await this.readKey(metadata.id)
        return copyMaterial(key)
    }

    async stageKey(appName: string, key: Uint8Array): Promise<KeyMaterial> {
        const material = copyMaterial(key)
        await this.withLock(async () => {
            const manifest = (await this.readManifest(appName)) ?? { version: 1, appName, keys: [] }
            const existing = manifest.keys.find(item => item.id === material.id)
            if (existing) {
                this.emitWarning()
                await this.readKey(material.id)
                return
            }
            this.emitWarning()
            await this.atomicWrite(this.keyPath(material.id), Buffer.from(material.key).toString("base64"), 0o400)
            await this.writeManifest({
                ...manifest,
                keys: [...manifest.keys, { id: material.id, state: "staged", createdAt: new Date().toISOString() }],
            })
        })
        return copyMaterial(material.key)
    }

    /** Atomically reuse the active file key or create and activate the first one. */
    async provisionKey(appName: string): Promise<KeyMaterial> {
        return this.withLock(async () => {
            const manifest = (await this.readManifest(appName)) ?? { version: 1, appName, keys: [] }
            const active = manifest.keys.find(item => item.state === "active")
            if (active) {
                this.emitWarning()
                return copyMaterial(await this.readKey(active.id))
            }

            this.emitWarning()
            const material = copyMaterial(randomBytes(32))
            await this.atomicWrite(this.keyPath(material.id), Buffer.from(material.key).toString("base64"), 0o400)
            await this.writeManifest({
                ...manifest,
                keys: [...manifest.keys, { id: material.id, state: "active", createdAt: new Date().toISOString() }],
            })
            return copyMaterial(material.key)
        })
    }

    async activateKey(appName: string, keyId: string): Promise<void> {
        await this.updateManifest(appName, keyId, keys =>
            keys.map(item => ({
                ...item,
                state: item.id === keyId ? "active" : item.state === "active" ? "retired" : item.state,
            })),
        )
    }

    async retireKey(appName: string, keyId: string): Promise<void> {
        await this.updateManifest(appName, keyId, keys =>
            keys.map(item => (item.id === keyId ? { ...item, state: "retired" } : item)),
        )
    }

    async deleteKey(appName: string, keyId: string): Promise<void> {
        await this.withLock(async () => {
            const manifest = await this.requireManifest(appName)
            const metadata = manifest.keys.find(item => item.id === keyId)
            if (!metadata) throw new Error(`file key ${keyId} does not exist`)
            if (metadata.state === "active") throw new Error(`cannot delete active file key ${keyId}`)
            this.emitWarning()
            await this.writeManifest({ ...manifest, keys: manifest.keys.filter(item => item.id !== keyId) })
            await rm(this.keyPath(keyId))
        })
    }

    async listKeys(appName: string): Promise<KeyMetadata[]> {
        const manifest = await this.readManifest(appName)
        return manifest?.keys.map(item => ({ ...item })) ?? []
    }

    private emitWarning(): void {
        this.warn(
            `Encryption keys are stored beside the config at ${this.directory}; use a secure key backend when available.`,
        )
    }

    private keyPath(keyId: string): string {
        if (!/^[A-Za-z0-9_-]{43}$/u.test(keyId)) throw new Error(`invalid key ID "${keyId}"`)
        return join(this.directory, `${keyId}.key`)
    }

    private async readKey(keyId: string): Promise<Uint8Array> {
        let encoded: string
        try {
            encoded = await readFile(this.keyPath(keyId), "utf8")
        } catch (error) {
            throw new Error(`cannot read file key ${keyId}: ${(error as Error).message}`, { cause: error })
        }
        const decoded = Buffer.from(encoded, "base64")
        const material = copyMaterial(decoded)
        if (material.id !== keyId || decoded.toString("base64") !== encoded) {
            throw new Error(`file key ${keyId} is invalid or does not match its ID`)
        }
        return material.key
    }

    private async readManifest(appName: string): Promise<KeyManifest | null> {
        let text: string
        try {
            text = await readFile(this.manifestPath, "utf8")
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
            throw error
        }
        let value: unknown
        try {
            value = JSON.parse(text) as unknown
        } catch (error) {
            throw new Error(`file key manifest is not valid JSON: ${(error as Error).message}`, { cause: error })
        }
        if (!this.isManifest(value)) throw new Error("file key manifest has an invalid shape")
        if (value.appName !== appName) {
            throw new Error(`file key manifest belongs to ${value.appName}, not ${appName}`)
        }
        if (value.keys.filter(item => item.state === "active").length > 1) {
            throw new Error("file key manifest contains multiple active keys")
        }
        return value
    }

    private isManifest(value: unknown): value is KeyManifest {
        if (typeof value !== "object" || value === null) return false
        const candidate = value as Record<string, unknown>
        if (candidate["version"] !== 1 || typeof candidate["appName"] !== "string") return false
        const keys = candidate["keys"]
        if (!Array.isArray(keys)) return false
        if (
            !keys.every(item => {
                if (typeof item !== "object" || item === null) return false
                const metadata = item as Record<string, unknown>
                return (
                    typeof metadata["id"] === "string" &&
                    /^[A-Za-z0-9_-]{43}$/u.test(metadata["id"]) &&
                    typeof metadata["state"] === "string" &&
                    ["staged", "active", "retired"].includes(metadata["state"]) &&
                    typeof metadata["createdAt"] === "string" &&
                    !Number.isNaN(Date.parse(metadata["createdAt"]))
                )
            })
        )
            return false
        return new Set(keys.map(item => (item as Record<string, unknown>)["id"])).size === keys.length
    }

    private async requireManifest(appName: string): Promise<KeyManifest> {
        const manifest = await this.readManifest(appName)
        if (!manifest) throw new Error(`no file keys exist for ${appName}`)
        return manifest
    }

    private async updateManifest(
        appName: string,
        keyId: string,
        update: (keys: KeyMetadata[]) => KeyMetadata[],
    ): Promise<void> {
        await this.withLock(async () => {
            const manifest = await this.requireManifest(appName)
            if (!manifest.keys.some(item => item.id === keyId)) throw new Error(`file key ${keyId} does not exist`)
            await this.readKey(keyId)
            this.emitWarning()
            await this.writeManifest({ ...manifest, keys: update(manifest.keys) })
        })
    }

    private async writeManifest(manifest: KeyManifest): Promise<void> {
        await this.atomicWrite(this.manifestPath, `${JSON.stringify(manifest, null, 4)}\n`, 0o600)
    }

    private async atomicWrite(path: string, contents: string, mode: number): Promise<void> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        await chmod(this.directory, 0o700)
        const temporary = join(this.directory, `.${process.pid}-${randomBytes(8).toString("hex")}.tmp`)
        const handle = await open(temporary, "wx", mode)
        try {
            await handle.writeFile(contents, "utf8")
            await handle.sync()
        } catch (error) {
            await handle.close()
            await rm(temporary, { force: true })
            throw error
        }
        await handle.close()
        try {
            await chmod(temporary, mode)
            await rename(temporary, path)
        } catch (error) {
            await rm(temporary, { force: true })
            throw error
        }
        try {
            const directory = await open(this.directory, "r")
            try {
                await directory.sync()
            } finally {
                await directory.close()
            }
        } catch {
            // Directory fsync is unavailable on some supported platforms.
        }
    }

    private async withLock<T>(action: () => Promise<T>): Promise<T> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        await chmod(this.directory, 0o700)
        for (let attempt = 0; attempt < 120; attempt += 1) {
            try {
                const handle = await open(this.lockPath, "wx", 0o600)
                try {
                    return await action()
                } finally {
                    await handle.close()
                    await rm(this.lockPath, { force: true })
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
                try {
                    const lock = await stat(this.lockPath)
                    if (Date.now() - lock.mtimeMs > 30_000) await rm(this.lockPath, { force: true })
                } catch (lockError) {
                    if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError
                }
                await wait(25)
            }
        }
        throw new Error(`timed out waiting for file key lock ${this.lockPath}`)
    }
}

/** Narrow a key source to one that supports lifecycle mutations. */
export const isWritableKeyBackend = (source: KeySource): source is WritableKeyBackend =>
    "stageKey" in source && typeof (source as Partial<WritableKeyBackend>).stageKey === "function"

/** Resolve a matching key from the first available ordered source. */
export const resolveKey = async (
    sources: readonly KeySource[],
    appName: string,
    keyId?: string,
): Promise<ResolvedKey | null> => {
    for (const source of sources) {
        if (!(await source.available())) continue
        const material = await source.getKey(appName, keyId)
        if (material) return { source, material: validateMaterial(material, keyId) }
    }
    return null
}

/** Reuse an active key or provision and activate one in the first writable source. */
export const resolveOrProvisionKey = async (sources: readonly KeySource[], appName: string): Promise<ResolvedKey> => {
    const existing = await resolveKey(sources, appName)
    if (existing) return existing
    for (const source of sources) {
        if (!(await source.available()) || !isWritableKeyBackend(source)) continue
        if (source instanceof FileKeyBackend) {
            const material = await source.provisionKey(appName)
            return { source, material }
        }
        const staged = validateMaterial(await source.stageKey(appName, randomBytes(32)))
        await source.activateKey(appName, staged.id)
        const material = await source.getKey(appName, staged.id)
        if (!material) throw new Error(`${source.name} did not return the key it provisioned`)
        return { source, material: validateMaterial(material, staged.id) }
    }
    throw new Error(`no writable key backend is available for ${appName}`)
}
