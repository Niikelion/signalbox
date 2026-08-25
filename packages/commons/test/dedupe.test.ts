import { makeFlow } from "@signalbox/core"
import { describe, expect, it } from "vitest"
import { dedupeBy } from "../src/index"

const flush = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
}

describe("dedupeBy", () => {
    it("is a stateful filter predicate", async () => {
        let emit!: (value: string) => void
        const seen: string[] = []

        makeFlow<string>(push => {
            emit = push
        })
            .filter(dedupeBy(value => value))
            .effect(value => {
                seen.push(value)
            })

        emit("a")
        emit("a")
        emit("b")
        await flush()

        expect(seen).toEqual(["a", "b"])
    })
})
