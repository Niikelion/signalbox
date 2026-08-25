import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { deriveKeyId } from "./cipher"
import type { KeyMaterial, KeySource } from "./keys"

export interface SystemdCredentialManifest {
    readonly version: 1
    readonly appName: string
    readonly activeKeyId: string
    readonly keyIds: readonly string[]
}

export interface SystemdCredentialKeySourceOptions {
    readonly credentialDirectory?: string
    readonly archiveDirectories?: readonly string[]
    readonly decrypt?: (path: string) => Promise<Uint8Array>
}

const safeAppName = (appName: string): string => appName.replace(/[^A-Za-z0-9_.-]+/gu, "-")

/** Stable credential name used in systemd units and sealed archives. */
export const systemdCredentialName = (appName: string, keyId: string): string => {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(keyId)) throw new Error(`invalid key ID "${keyId}"`)
    return `${safeAppName(appName)}-config-key-${keyId}`
}

/** Non-secret manifest name used to identify the active sealed key. */
export const systemdManifestName = (appName: string): string => `${safeAppName(appName)}-config-keys.json`

/** Credential containing the active key ID inside a running service. */
export const systemdActiveCredentialName = (appName: string): string => `${safeAppName(appName)}-config-key-active`

const decryptWithScope = async (path: string, user: boolean): Promise<Uint8Array> =>
    new Promise((resolve, reject) => {
        const child = spawn("systemd-creds", [...(user ? ["--user"] : []), "decrypt", path, "-"], {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
        child.once("error", reject)
        child.once("close", code => {
            if (code === 0) resolve(Buffer.concat(stdout))
            else reject(new Error(`systemd-creds decrypt failed: ${Buffer.concat(stderr).toString("utf8").trim()}`))
        })
    })

const runDecrypt = async (path: string): Promise<Uint8Array> => {
    try {
        return await decryptWithScope(path, false)
    } catch (systemError) {
        try {
            return await decryptWithScope(path, true)
        } catch {
            throw systemError
        }
    }
}

const validateKey = (bytes: Uint8Array, expectedId?: string): KeyMaterial => {
    if (bytes.byteLength !== 32) throw new Error("systemd credential must contain exactly 32 key bytes")
    const key = Uint8Array.from(bytes)
    const id = deriveKeyId(key)
    if (expectedId !== undefined && id !== expectedId) {
        throw new Error(`systemd credential key ID ${id} does not match ${expectedId}`)
    }
    return { id, key }
}

const isManifest = (value: unknown, appName: string): value is SystemdCredentialManifest => {
    if (typeof value !== "object" || value === null) return false
    const candidate = value as Record<string, unknown>
    return (
        candidate["version"] === 1 &&
        candidate["appName"] === appName &&
        typeof candidate["activeKeyId"] === "string" &&
        /^[A-Za-z0-9_-]{43}$/u.test(candidate["activeKeyId"]) &&
        Array.isArray(candidate["keyIds"]) &&
        candidate["keyIds"].every(keyId => typeof keyId === "string" && /^[A-Za-z0-9_-]{43}$/u.test(keyId)) &&
        candidate["keyIds"].includes(candidate["activeKeyId"])
    )
}

/** Read keys exposed through `$CREDENTIALS_DIRECTORY` or an authorized sealed archive. */
export class SystemdCredentialKeySource implements KeySource {
    readonly name = "systemd-creds"
    private readonly credentialDirectory: string | undefined
    private readonly archiveDirectories: readonly string[]
    private readonly decrypt: (path: string) => Promise<Uint8Array>

    constructor(options: SystemdCredentialKeySourceOptions = {}) {
        this.credentialDirectory = options.credentialDirectory ?? process.env["CREDENTIALS_DIRECTORY"]
        this.archiveDirectories = options.archiveDirectories ?? [
            "/etc/credstore.encrypted",
            join(homedir(), ".config", "systemd", "credstore.encrypted"),
        ]
        this.decrypt = options.decrypt ?? runDecrypt
    }

    async available(): Promise<boolean> {
        if (this.credentialDirectory) return true
        for (const directory of this.archiveDirectories) {
            try {
                await access(directory, constants.R_OK)
                return true
            } catch {
                // Try the next archive.
            }
        }
        return false
    }

    async getKey(appName: string, keyId?: string): Promise<KeyMaterial | null> {
        const resolvedId = keyId ?? (await this.activeKeyId(appName))
        if (!resolvedId) return null
        const credential = systemdCredentialName(appName, resolvedId)

        if (this.credentialDirectory) {
            try {
                const bytes = await readFile(join(this.credentialDirectory, credential))
                return validateKey(bytes, resolvedId)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            }
        }

        for (const directory of this.archiveDirectories) {
            const path = join(directory, credential)
            try {
                await access(path, constants.R_OK)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
                throw error
            }
            return validateKey(await this.decrypt(path), resolvedId)
        }
        return null
    }

    /** List key IDs advertised by the sealed archive manifest without decrypting them. */
    async listKeyIds(
        appName: string,
    ): Promise<{ readonly activeKeyId: string; readonly keyIds: readonly string[] } | null> {
        for (const directory of this.archiveDirectories) {
            try {
                const value = JSON.parse(
                    await readFile(join(directory, systemdManifestName(appName)), "utf8"),
                ) as unknown
                if (!isManifest(value, appName)) throw new Error(`invalid systemd credential manifest for ${appName}`)
                return { activeKeyId: value.activeKeyId, keyIds: [...value.keyIds] }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            }
        }
        return null
    }

    private async activeKeyId(appName: string): Promise<string | null> {
        if (this.credentialDirectory) {
            try {
                return (
                    await readFile(join(this.credentialDirectory, systemdActiveCredentialName(appName)), "utf8")
                ).trim()
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            }
        }
        for (const directory of this.archiveDirectories) {
            try {
                const value = JSON.parse(
                    await readFile(join(directory, systemdManifestName(appName)), "utf8"),
                ) as unknown
                if (!isManifest(value, appName)) throw new Error(`invalid systemd credential manifest for ${appName}`)
                return value.activeKeyId
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            }
        }
        return null
    }
}
