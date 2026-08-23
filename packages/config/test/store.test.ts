import { randomBytes } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileKeyBackend, deriveKeyId, encryptSecret, type KeySource } from "@signalbox/secrets"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
    REDACTED,
    config,
    createConfigStore,
    describeOf,
    field,
    isRequired,
    isSecret,
    isSecretValue,
    secret,
    z,
} from "../src/index.js"

const schema = config({
    apiToken: field().string().secret().describe("token"),
    zoneId: field().string(),
    records: field().list().default([]),
    ttl: field().int().positive().default(60),
    logLevel: z.enum(["info", "warn", "error"]).default("info"),
})

const directories: string[] = []
const makeStore = async () => {
    const directory = await mkdtemp(join(tmpdir(), "sbcfg-"))
    directories.push(directory)
    const path = join(directory, "config.json")
    const keySource = new FileKeyBackend({ configPath: path, warn: vi.fn() })
    return { path, keySource, store: createConfigStore({ appName: "test", schema, path, keySource }) }
}

afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe("encrypted config store", () => {
    it("coerces, encrypts, loads wrappers, and applies non-secret defaults", async () => {
        const { path, store } = await makeStore()
        await store.set("apiToken", "supersecrettoken")
        await store.set("zoneId", "zone123")
        await store.set("records", "a.com, b.com")
        await store.set("ttl", "120")

        const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
        expect(persisted["apiToken"]).toMatch(/^enc:1:/u)
        expect(await readFile(path, "utf8")).not.toContain("supersecrettoken")

        const loaded = await store.load()
        expect(isSecretValue(loaded.apiToken)).toBe(true)
        expect(loaded.apiToken.reveal()).toBe("supersecrettoken")
        expect(loaded.records).toEqual(["a.com", "b.com"])
        expect(loaded.ttl).toBe(120)
        expect(loaded.logLevel).toBe("info")
    })

    it("rejects invalid fields, unknown keys, and unavailable keys", async () => {
        const { store } = await makeStore()
        await expect(store.set("ttl", "-5")).rejects.toThrow("invalid value")
        await expect(store.set("ttl", "abc")).rejects.toThrow("must be a number")
        await expect(store.set("nope", "x")).rejects.toThrow("unknown config key")

        const unavailable: KeySource = {
            name: "unavailable",
            available: async () => false,
            getKey: async () => null,
        }
        const blocked = createConfigStore({
            appName: "blocked",
            schema,
            path: join(tmpdir(), `blocked-${randomBytes(8).toString("hex")}.json`),
            keySource: unavailable,
        })
        await expect(blocked.save({ apiToken: "value", zoneId: "zone" })).rejects.toThrow(
            "cannot obtain an encryption key",
        )
    })

    it("migrates a complete legacy plaintext document before returning it", async () => {
        const { path, store } = await makeStore()
        await writeFile(path, `${JSON.stringify({ apiToken: "legacy-token", zoneId: "zone" })}\n`, "utf8")

        const loaded = await store.load()
        expect(loaded.apiToken.reveal()).toBe("legacy-token")
        const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
        expect(persisted["apiToken"]).toMatch(/^enc:1:/u)
        expect(await readFile(path, "utf8")).not.toContain("legacy-token")
    })

    it("does not migrate or return an incomplete legacy document", async () => {
        const { path, store } = await makeStore()
        const original = `${JSON.stringify({ apiToken: "legacy-token" })}\n`
        await writeFile(path, original, "utf8")
        await expect(store.readPartial()).rejects.toThrow("zoneId")
        expect(await readFile(path, "utf8")).toBe(original)
    })

    it("requires an exact matching key for encrypted reads", async () => {
        const directory = await mkdtemp(join(tmpdir(), "sbcfg-missing-key-"))
        directories.push(directory)
        const path = join(directory, "config.json")
        const encrypted = encryptSecret("token", randomBytes(32), {
            appName: "missing-key",
            fieldName: "apiToken",
        })
        await writeFile(path, JSON.stringify({ apiToken: encrypted, zoneId: "zone" }), "utf8")
        const missing: KeySource = {
            name: "missing",
            available: async () => true,
            getKey: async () => null,
        }
        const store = createConfigStore({ appName: "missing-key", schema, path, keySource: missing })
        await expect(store.load()).rejects.toThrow("no key is available")
    })

    it("fails closed on malformed reserved envelopes without rewriting the file", async () => {
        const { path, store } = await makeStore()
        const original = `${JSON.stringify({ apiToken: "enc:2:a:b:c:d", zoneId: "zone" })}\n`
        await writeFile(path, original, "utf8")
        await expect(store.load()).rejects.toThrow("unsupported encrypted secret version")
        expect(await readFile(path, "utf8")).toBe(original)
    })

    it("inspects encrypted and legacy values without resolving a key", async () => {
        const directory = await mkdtemp(join(tmpdir(), "sbcfg-inspect-"))
        directories.push(directory)
        const path = join(directory, "config.json")
        const key = randomBytes(32)
        const encrypted = encryptSecret("token", key, { appName: "inspect", fieldName: "apiToken" })
        await writeFile(path, JSON.stringify({ apiToken: encrypted, zoneId: "zone" }), "utf8")
        const keySource: KeySource = {
            name: "must-not-read",
            available: async () => {
                throw new Error("inspect resolved a source")
            },
            getKey: async () => {
                throw new Error("inspect read a key")
            },
        }
        const store = createConfigStore({ appName: "inspect", schema, path, keySource })
        expect(await store.inspect()).toEqual({
            values: { apiToken: REDACTED, zoneId: "zone" },
            secrets: {
                apiToken: { state: "encrypted", version: 1, keyId: deriveKeyId(key) },
            },
        })

        await writeFile(path, JSON.stringify({ apiToken: "legacy", zoneId: "zone" }), "utf8")
        expect((await store.inspect()).secrets["apiToken"]).toEqual({ state: "plaintext" })
        expect(await readFile(path, "utf8")).toContain("legacy")
    })

    it("redacts loaded values without revealing their wrappers", async () => {
        const { store } = await makeStore()
        const wrapper = (await import("@signalbox/secrets")).Secret.from("do-not-reveal")
        const reveal = vi.spyOn(wrapper, "reveal")
        const output = await store.redacted({ apiToken: wrapper, zoneId: "zone" })
        expect(output).toEqual({ apiToken: REDACTED, zoneId: "zone" })
        expect(reveal).not.toHaveBeenCalled()
    })

    it("encrypts new plaintext beginning with the reserved prefix", async () => {
        const { store } = await makeStore()
        await store.save({ apiToken: "enc:literal-value", zoneId: "zone" })
        expect((await store.load()).apiToken.reveal()).toBe("enc:literal-value")
    })

    it("serializes concurrent read-modify-write operations", async () => {
        const concurrentSchema = config({
            token: field().string().secret().optional(),
            first: field().string().optional(),
            second: field().string().optional(),
            third: field().string().optional(),
        })
        const directory = await mkdtemp(join(tmpdir(), "sbcfg-concurrent-"))
        directories.push(directory)
        const path = join(directory, "config.json")
        const keySource = new FileKeyBackend({ configPath: path, warn: vi.fn() })
        const store = createConfigStore({ appName: "concurrent", schema: concurrentSchema, path, keySource })
        await Promise.all([
            store.set("first", "1"),
            store.set("second", "2"),
            store.set("third", "3"),
            store.set("token", "secret"),
        ])
        expect(await store.load()).toMatchObject({ first: "1", second: "2", third: "3" })
        expect((await store.load()).token?.reveal()).toBe("secret")
    })

    it("uses async existence checks and restrictive config permissions", async () => {
        const { path, store } = await makeStore()
        expect(await store.exists()).toBe(false)
        await store.save({ apiToken: "token", zoneId: "zone" })
        expect(await store.exists()).toBe(true)
        if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o640)
    })

    it("rejects secret values that validate but cannot round-trip through JSON", async () => {
        const dateSchema = config({ when: secret(z.date()) })
        const directory = await mkdtemp(join(tmpdir(), "sbcfg-date-"))
        directories.push(directory)
        const path = join(directory, "config.json")
        const keySource = new FileKeyBackend({ configPath: path, warn: vi.fn() })
        const store = createConfigStore({ appName: "date", schema: dateSchema, path, keySource })
        await expect(store.save({ when: new Date() })).rejects.toThrow("not JSON-compatible")
    })

    it("keeps introspection metadata intact", () => {
        const shape = schema.shape
        expect(isSecret(shape.apiToken)).toBe(true)
        expect(isSecret(shape.zoneId)).toBe(false)
        expect(isRequired(shape.zoneId)).toBe(true)
        expect(isRequired(shape.ttl)).toBe(false)
        expect(describeOf(shape.apiToken)).toBe("token")
    })

    it("rotates keys transactionally, retains the old key, and prunes it explicitly", async () => {
        const { path, store } = await makeStore()
        await store.save({ apiToken: "rotation-secret", zoneId: "zone" })
        const firstId = (await store.inspect()).secrets["apiToken"]?.keyId
        expect(firstId).toBeDefined()

        const result = await store.rekey()
        const secondId = (await store.inspect()).secrets["apiToken"]?.keyId
        expect(result.oldKeyIds).toEqual([firstId])
        expect(secondId).toBe(result.newKeyId)
        expect(secondId).not.toBe(firstId)
        expect((await store.load()).apiToken.reveal()).toBe("rotation-secret")
        expect(await store.keyInventory()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: firstId, state: "retired", referenced: false }),
                expect.objectContaining({ id: secondId, state: "active", referenced: true }),
            ]),
        )

        await store.pruneKeys([firstId as string])
        expect((await store.keyInventory()).map(item => item.id)).not.toContain(firstId)
        await expect(readFile(`${path}.rekey.json`, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("revokes old managed keys and purges config plus remaining managed keys", async () => {
        const { path, store } = await makeStore()
        await store.save({ apiToken: "revoke-secret", zoneId: "zone" })
        const firstId = (await store.inspect()).secrets["apiToken"]?.keyId as string
        const result = await store.rekey({ revokeOld: true })
        expect(result.revokedKeyIds).toEqual([firstId])
        expect((await store.keyInventory()).map(item => item.id)).not.toContain(firstId)

        const purged = await store.purge()
        expect(purged.removedConfig).toBe(true)
        expect(purged.deletedKeyIds).toContain(result.newKeyId)
        expect(await store.exists()).toBe(false)
        expect(await store.keyInventory()).toEqual([])
        await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("resumes a rekey transaction from its staged journal", async () => {
        const { path, keySource, store } = await makeStore()
        await store.save({ apiToken: "resume-secret", zoneId: "zone" })
        const oldKeyId = (await store.inspect()).secrets["apiToken"]?.keyId as string
        const staged = await keySource.stageKey("test", randomBytes(32))
        await writeFile(`${path}.rekey.backup`, await readFile(path, "utf8"))
        await writeFile(
            `${path}.rekey.json`,
            JSON.stringify({
                version: 1,
                appName: "test",
                configPath: path,
                oldKeyIds: [oldKeyId],
                newKeyId: staged.id,
                backend: "file",
                revokeOld: false,
                phase: "staged",
            }),
        )

        const result = await store.rekey()
        expect(result.newKeyId).toBe(staged.id)
        expect((await store.load()).apiToken.reveal()).toBe("resume-secret")
        expect(await keySource.listKeys("test")).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: oldKeyId, state: "retired" }),
                expect.objectContaining({ id: staged.id, state: "active" }),
            ]),
        )
    })

    it("restores the encrypted backup when rekey verification fails", async () => {
        const { path, store } = await makeStore()
        await store.save({ apiToken: "rollback-secret", zoneId: "zone" })
        const original = await readFile(path, "utf8")

        await expect(
            store.rekey({
                verify: async () => {
                    throw new Error("service restart failed")
                },
            }),
        ).rejects.toThrow("service restart failed")
        expect(await readFile(path, "utf8")).toBe(original)
        expect((await store.load()).apiToken.reveal()).toBe("rollback-secret")

        await store.rekey()
        expect((await store.load()).apiToken.reveal()).toBe("rollback-secret")
    })
})
