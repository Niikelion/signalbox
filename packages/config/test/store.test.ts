import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { config, createConfigStore, describeOf, field, isRequired, isSecret, z, type Infer } from "../src/index.js"

const schema = config({
    apiToken: field().string().secret().describe("token"),
    zoneId: field().string(),
    records: field().list().default([]),
    ttl: field().int().positive().default(60),
    logLevel: z.enum(["info", "warn", "error"]).default("info"),
})

type Cfg = Infer<typeof schema>

describe("config store", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbcfg-"))
    const path = join(dir, "config.json")
    const store = createConfigStore({ appName: "test", schema, path })

    it("coerces, validates, and loads with defaults", () => {
        store.set("apiToken", "supersecrettoken")
        store.set("zoneId", "zone123")
        store.set("records", "a.com, b.com")
        store.set("ttl", "120")

        const cfg: Cfg = store.load()
        expect(cfg.records).toEqual(["a.com", "b.com"])
        expect(cfg.ttl).toBe(120)
        expect(cfg.logLevel).toBe("info")
    })

    it("rejects invalid values", () => {
        expect(() => store.set("ttl", "-5")).toThrow()
        expect(() => store.set("ttl", "abc")).toThrow()
        expect(() => store.set("nope", "x")).toThrow()
    })

    it("redacts secrets only", () => {
        const red = store.redacted(store.readPartial())
        expect(String(red["apiToken"])).toMatch(/\*+oken$/)
        expect(red["zoneId"]).toBe("zone123")
    })

    it("introspection helpers", () => {
        const shape = schema.shape
        expect(isSecret(shape.apiToken)).toBe(true)
        expect(isSecret(shape.zoneId)).toBe(false)
        expect(isRequired(shape.zoneId)).toBe(true)
        expect(isRequired(shape.ttl)).toBe(false)
        expect(describeOf(shape.apiToken)).toBe("token")
    })
})
