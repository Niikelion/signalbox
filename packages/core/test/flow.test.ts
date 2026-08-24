import { describe, expect, it } from "vitest"
import { combine, makeFlow, type RunContext } from "../src"

const flush = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 0))
}

describe("flow run context", () => {
    it("shares one root run across branches from the same flow handle", async () => {
        const emitters: Array<(value: string) => void> = []
        const source = makeFlow<string>(push => {
            emitters.push(push)
        })
        const runIds: string[] = []

        source.effect((_value, run) => {
            runIds.push(run.id)
        })
        source.effect((_value, run) => {
            runIds.push(run.id)
        })

        for (const emit of emitters) emit("x")
        await flush()

        expect(runIds).toHaveLength(2)
        expect(new Set(runIds).size).toBe(1)
    })

    it("shares operator state after combine while keeping runs independent", async () => {
        let emitA!: (value: string) => void
        let emitB!: (value: string) => void
        const a = makeFlow<string>(push => {
            emitA = push
        })
        const b = makeFlow<string>(push => {
            emitB = push
        })
        const seen: string[] = []
        const runIds: string[] = []
        const dedupe = (() => {
            let last: string | undefined
            return (value: string) => {
                if (value === last) return false
                last = value
                return true
            }
        })()

        combine(a, b)
            .filter(dedupe)
            .effect((value, run) => {
                seen.push(value)
                runIds.push(run.id)
            })

        emitA("same")
        emitB("same")
        emitB("other")
        await flush()

        expect(seen).toEqual(["same", "other"])
        expect(new Set(runIds).size).toBe(2)
    })

    it("creates joined child runs with parent and cause metadata", async () => {
        let emit!: (value: readonly string[]) => void
        const source = makeFlow<readonly string[]>(push => {
            emit = push
        })
        let parent: RunContext | undefined
        const children: RunContext[] = []

        source
            .fork((values, run) => {
                parent = run
                return values
            })
            .effect((_value, run) => {
                children.push(run)
            })

        emit(["a", "b"])
        await flush()

        expect(children).toHaveLength(2)
        expect(children.map(run => run.parentRunId)).toEqual([parent?.id, parent?.id])
        expect(children.map(run => run.causedByRunId)).toEqual([parent?.id, parent?.id])
        expect(children.map(run => run.correlationId)).toEqual([parent?.correlationId, parent?.correlationId])
    })

    it("detaches a continuation from lifecycle parentage while preserving cause metadata", async () => {
        let emit!: (value: string) => void
        const source = makeFlow<string>(push => {
            emit = push
        })
        let parent: RunContext | undefined
        let detached: RunContext | undefined

        source
            .map((value, run) => {
                parent = run
                return value
            })
            .detach()
            .effect((_value, run) => {
                detached = run
            })

        emit("x")
        await flush()

        expect(detached?.parentRunId).toBeUndefined()
        expect(detached?.causedByRunId).toBe(parent?.id)
        expect(detached?.correlationId).toBe(parent?.correlationId)
    })
})
