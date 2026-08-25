import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createStore } from "../src/index"

interface Reminder {
    id: string
    message: string
    at: number
}

describe("store", () => {
    it("round-trips insert/get/update/upsert/delete/all", () => {
        const store = createStore(":memory:")
        try {
            const reminders = store.collection<Reminder>("reminders")
            expect(reminders.all()).toEqual([])

            reminders.insert({ id: "a", message: "hi", at: 1 })
            reminders.insert({ id: "b", message: "yo", at: 2 })
            expect(reminders.get("a")).toEqual({ id: "a", message: "hi", at: 1 })
            expect(reminders.all()).toHaveLength(2)

            reminders.update("a", { message: "hello" })
            expect(reminders.get("a")?.message).toBe("hello")

            reminders.upsert({ id: "a", message: "up", at: 9 })
            expect(reminders.get("a")).toEqual({ id: "a", message: "up", at: 9 })

            reminders.delete("b")
            expect(reminders.get("b")).toBeUndefined()
            expect(reminders.all()).toHaveLength(1)
        } finally {
            store.close()
        }
    })

    it("persists across reopen", () => {
        const path = join(mkdtempSync(join(tmpdir(), "sbstore-")), "data.db")

        const first = createStore(path)
        first.collection<Reminder>("reminders").insert({ id: "x", message: "keep me", at: 1 })
        first.close()

        const second = createStore(path)
        try {
            expect(second.collection<Reminder>("reminders").get("x")?.message).toBe("keep me")
        } finally {
            second.close()
        }
    })

    it("rejects invalid collection names", () => {
        const store = createStore(":memory:")
        try {
            expect(() => store.collection("bad name")).toThrow()
        } finally {
            store.close()
        }
    })
})
