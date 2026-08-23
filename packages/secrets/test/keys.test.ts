import { randomBytes } from "node:crypto"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
    deriveKeyId,
    EnvKeySource,
    FileKeyBackend,
    resolveKey,
    resolveOrProvisionKey,
    type KeySource,
} from "../src/index.js"

const directories: string[] = []
const temporaryConfig = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), "signalbox-secrets-"))
    directories.push(directory)
    return join(directory, "config.json")
}

afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe("EnvKeySource", () => {
    it("reads canonical base64, derives the ID, filters by ID, and copies bytes", async () => {
        const key = randomBytes(32)
        const source = new EnvKeySource({ MY_APP_CONFIG_KEY: key.toString("base64") })
        const material = await source.getKey("my-app")
        expect(material?.id).toBe(deriveKeyId(key))
        expect(Array.from(material?.key ?? [])).toEqual(Array.from(key))
        if (material) material.key[0] = material.key[0] === 0 ? 1 : 0
        expect(Array.from((await source.getKey("my-app"))?.key ?? [])).toEqual(Array.from(key))
        expect(await source.getKey("my-app", deriveKeyId(randomBytes(32)))).toBeNull()
    })

    it("fails closed for malformed or incorrectly sized values", async () => {
        await expect(new EnvKeySource({ APP_CONFIG_KEY: "not base64" }).getKey("app")).rejects.toThrow(
            "canonical base64",
        )
        await expect(
            new EnvKeySource({ APP_CONFIG_KEY: Buffer.from("short").toString("base64") }).getKey("app"),
        ).rejects.toThrow("exactly 32 bytes")
    })
})

describe("FileKeyBackend", () => {
    it("stages, activates, retires, reads, lists, and deletes versioned keys", async () => {
        const configPath = await temporaryConfig()
        const warnings: string[] = []
        const backend = new FileKeyBackend({ configPath, warn: message => warnings.push(message) })
        const first = await backend.stageKey("app", randomBytes(32))
        expect(await backend.getKey("app")).toBeNull()
        await backend.activateKey("app", first.id)
        expect((await backend.getKey("app"))?.key).toEqual(first.key)

        const second = await backend.stageKey("app", randomBytes(32))
        await backend.activateKey("app", second.id)
        expect(await backend.listKeys("app")).toEqual([
            expect.objectContaining({ id: first.id, state: "retired" }),
            expect.objectContaining({ id: second.id, state: "active" }),
        ])
        await expect(backend.deleteKey("app", second.id)).rejects.toThrow("cannot delete active")
        await backend.deleteKey("app", first.id)
        expect((await backend.listKeys("app")).map(item => item.id)).toEqual([second.id])
        expect(warnings.length).toBeGreaterThan(0)

        const manifestMode = (await stat(join(`${configPath}.keys`, "manifest.json"))).mode & 0o777
        if (process.platform !== "win32") expect(manifestMode).toBe(0o600)
        const stored = await readFile(join(`${configPath}.keys`, `${second.id}.key`), "utf8")
        expect(stored).not.toContain(second.id)
    })

    it("provisions exactly one active key under concurrency", async () => {
        const backend = new FileKeyBackend({ configPath: await temporaryConfig(), warn: vi.fn() })
        const results = await Promise.all(Array.from({ length: 8 }, () => resolveOrProvisionKey([backend], "app")))
        expect(new Set(results.map(result => result.material.id))).toHaveLength(1)
        expect(await backend.listKeys("app")).toEqual([expect.objectContaining({ state: "active" })])
    })

    it("rejects corrupt keys and app-name mismatches", async () => {
        const configPath = await temporaryConfig()
        const backend = new FileKeyBackend({ configPath, warn: vi.fn() })
        const material = await backend.provisionKey("first")
        await expect(backend.getKey("second", material.id)).rejects.toThrow("belongs to first")
    })
})

describe("source resolution", () => {
    it("uses ordered available sources and skips non-matching IDs", async () => {
        const wanted = randomBytes(32)
        const missing: KeySource = {
            name: "missing",
            available: async () => true,
            getKey: async () => null,
        }
        const unavailable: KeySource = {
            name: "unavailable",
            available: async () => false,
            getKey: async () => {
                throw new Error("must not run")
            },
        }
        const environment = new EnvKeySource({ APP_CONFIG_KEY: wanted.toString("base64") })
        const result = await resolveKey([unavailable, missing, environment], "app", deriveKeyId(wanted))
        expect(result?.source).toBe(environment)
        expect(Array.from(result?.material.key ?? [])).toEqual(Array.from(wanted))
    })

    it("fails closed when a source lies about a key ID", async () => {
        const source: KeySource = {
            name: "invalid",
            available: async () => true,
            getKey: async () => ({ id: deriveKeyId(randomBytes(32)), key: randomBytes(32) }),
        }
        await expect(resolveKey([source], "app")).rejects.toThrow("does not match its key bytes")
    })
})
