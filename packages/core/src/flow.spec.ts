import { describe, expect, it, vi } from "vitest"
import { combine, makeFlow, makePermissionFlow, type Flow, type RunContext } from "@/flow"
import {
    GrantStateCell,
    PermissionError,
    createPermissionExecution,
    entityRef,
    permissionClaim,
    type ActiveAuthority,
} from "@signalbox/permissions"
import * as log from "@/log"

const flush = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 0))
}

class Emitter<T> {
    private readonly listeners: ((value: T) => void)[] = []

    flow(): Flow<T> {
        return makeFlow<T>(push => {
            this.listeners.push(push)
        })
    }

    emit(value: T): void {
        this.listeners.forEach(listener => {
            listener(value)
        })
    }
}

describe("Flow", () => {
    describe("effect", () => {
        it("should run handler once for each flow run", async () => {
            const emitter = new Emitter<number>()
            const result: number[] = []
            emitter.flow().effect(async value => void result.push(value))

            emitter.emit(1)
            emitter.emit(2)
            emitter.emit(3)
            await flush()

            expect(result).toEqual([1, 2, 3])
        })

        it("should pass a stable root run context to sibling effects", async () => {
            const emitter = new Emitter<string>()
            const runs: RunContext[] = []
            const flow = emitter.flow()

            flow.effect((_value, run) => {
                runs.push(run)
            })
            flow.effect((_value, run) => {
                runs.push(run)
            })

            emitter.emit("value")
            await flush()

            expect(runs).toHaveLength(2)
            expect(runs[0]?.id).toBe(runs[1]?.id)
            expect(runs[0]?.workflowId).toBe("workflow")
            expect(runs[0]?.correlationId).toBe(runs[0]?.id)
            expect(runs[0]?.parentRunId).toBeUndefined()
            expect(runs[0]?.causedByRunId).toBeUndefined()
        })

        it("should start the source only once for multiple effects on the same flow", async () => {
            let starts = 0
            let emit!: (value: string) => void
            const flow = makeFlow<string>(push => {
                starts += 1
                emit = push
            })
            const result: string[] = []

            flow.effect(value => {
                result.push(`a:${value}`)
            })
            flow.effect(value => {
                result.push(`b:${value}`)
            })

            emit("value")
            await flush()

            expect(starts).toBe(1)
            expect(result).toEqual(["a:value", "b:value"])
        })

        it("should create independent root runs for separate flow calls over the same source", async () => {
            const emitter = new Emitter<string>()
            const runs: string[] = []

            emitter.flow().effect((_value, run) => {
                runs.push(run.id)
            })
            emitter.flow().effect((_value, run) => {
                runs.push(run.id)
            })

            emitter.emit("value")
            await flush()

            expect(runs).toHaveLength(2)
            expect(runs[0]).not.toBe(runs[1])
        })

        it("should continue sibling branches after one branch fails", async () => {
            const emitter = new Emitter<string>()
            const write = vi.spyOn(log, "write").mockImplementation(() => undefined)
            const flow = emitter.flow()
            const result: string[] = []

            flow.effect(() => {
                throw new Error("branch failed")
            })
            flow.effect(value => {
                result.push(value)
            })

            emitter.emit("value")
            await flush()
            await flush()

            expect(result).toEqual(["value"])
            expect(write).toHaveBeenCalledWith("error", "[flow] 1 of 2 flow branches failed")
        })

        it("should log asynchronous effect failures", async () => {
            const emitter = new Emitter<string>()
            const write = vi.spyOn(log, "write").mockImplementation(() => undefined)

            emitter.flow().effect(async () => {
                throw new Error("effect failed")
            })

            emitter.emit("value")
            await flush()
            await flush()

            expect(write).toHaveBeenCalledWith("error", "[flow] 1 of 1 flow branches failed")
        })
    })

    describe("map", () => {
        it("should transform values before they reach downstream effects", async () => {
            const emitter = new Emitter<number>()
            const result: string[] = []

            emitter
                .flow()
                .map(value => value * 2)
                .map(async value => `value:${String(value)}`)
                .effect(value => {
                    result.push(value)
                })

            emitter.emit(2)
            emitter.emit(4)
            await flush()

            expect(result).toEqual(["value:4", "value:8"])
        })

        it("should preserve the current run context across mapped values", async () => {
            const emitter = new Emitter<number>()
            const runIds: string[] = []

            emitter
                .flow()
                .map((value, run) => {
                    runIds.push(run.id)
                    return value + 1
                })
                .effect((_value, run) => {
                    runIds.push(run.id)
                })

            emitter.emit(1)
            await flush()

            expect(runIds).toHaveLength(2)
            expect(runIds[0]).toBe(runIds[1])
        })

        it("should stop the branch and log when a mapper rejects", async () => {
            const emitter = new Emitter<number>()
            const write = vi.spyOn(log, "write").mockImplementation(() => undefined)
            const result: number[] = []

            emitter
                .flow()
                .map(() => {
                    throw new Error("map failed")
                })
                .effect(value => {
                    result.push(value)
                })

            emitter.emit(1)
            await flush()
            await flush()

            expect(result).toEqual([])
            expect(write).toHaveBeenCalledWith("error", "[flow] 1 of 1 flow branches failed")
        })
    })

    describe("filter", () => {
        it("should only pass values accepted by sync and async predicates", async () => {
            const emitter = new Emitter<number>()
            const result: number[] = []

            emitter
                .flow()
                .filter(value => value > 1)
                .filter(async value => value % 2 === 0)
                .effect(value => {
                    result.push(value)
                })

            emitter.emit(1)
            emitter.emit(2)
            emitter.emit(3)
            emitter.emit(4)
            await flush()

            expect(result).toEqual([2, 4])
        })

        it("should narrow values with a type guard predicate", async () => {
            const emitter = new Emitter<string | number | null>()
            const result: string[] = []

            emitter
                .flow()
                .filter((value): value is string => typeof value === "string")
                .map(value => value.toUpperCase())
                .effect(value => {
                    result.push(value)
                })

            emitter.emit("alpha")
            emitter.emit(1)
            emitter.emit(null)
            emitter.emit("beta")
            await flush()

            expect(result).toEqual(["ALPHA", "BETA"])
        })
    })

    describe("fork", () => {
        it("should emit one joined child run for each returned value", async () => {
            const emitter = new Emitter<readonly string[]>()
            let parent: RunContext | undefined
            const values: string[] = []
            const children: RunContext[] = []

            emitter
                .flow()
                .fork((value, run) => {
                    parent = run
                    return value
                })
                .effect((value, run) => {
                    values.push(value)
                    children.push(run)
                })

            emitter.emit(["a", "b"])
            await flush()

            expect(values).toEqual(["a", "b"])
            expect(children.map(run => run.parentRunId)).toEqual([parent?.id, parent?.id])
            expect(children.map(run => run.causedByRunId)).toEqual([parent?.id, parent?.id])
            expect(children.map(run => run.correlationId)).toEqual([parent?.correlationId, parent?.correlationId])
        })

        it("should close the branch without downstream effects when fork returns no values", async () => {
            const emitter = new Emitter<string>()
            const result: string[] = []

            emitter
                .flow()
                .fork((): readonly string[] => [])
                .effect(value => {
                    result.push(value)
                })

            emitter.emit("value")
            await flush()

            expect(result).toEqual([])
        })

        it("should log joined child failures after running successful children", async () => {
            const emitter = new Emitter<readonly string[]>()
            const write = vi.spyOn(log, "write").mockImplementation(() => undefined)
            const result: string[] = []

            emitter
                .flow()
                .fork(value => value)
                .effect(value => {
                    if (value === "bad") throw new Error("child failed")
                    result.push(value)
                })

            emitter.emit(["ok", "bad", "also-ok"])
            await flush()
            await flush()

            expect(result).toEqual(["ok", "also-ok"])
            expect(write).toHaveBeenCalledWith("error", "[flow] 1 of 1 flow branches failed")
        })
    })

    describe("detach", () => {
        it("should run downstream work with cause metadata but no parent run", async () => {
            const emitter = new Emitter<string>()
            let parent: RunContext | undefined
            let detached: RunContext | undefined

            emitter
                .flow()
                .map((value, run) => {
                    parent = run
                    return value
                })
                .detach()
                .effect((_value, run) => {
                    detached = run
                })

            emitter.emit("value")
            await flush()

            expect(detached?.id).not.toBe(parent?.id)
            expect(detached?.parentRunId).toBeUndefined()
            expect(detached?.causedByRunId).toBe(parent?.id)
            expect(detached?.correlationId).toBe(parent?.correlationId)
        })

        it("should not block sibling branches behind detached work", async () => {
            const emitter = new Emitter<string>()
            const result: string[] = []
            const flow = emitter.flow()
            let releaseDetached!: () => void

            flow.detach().effect(async value => {
                await new Promise<void>(resolve => {
                    releaseDetached = resolve
                })
                result.push(`detached:${value}`)
            })
            flow.effect(value => {
                result.push(`sibling:${value}`)
            })

            emitter.emit("value")
            await flush()

            expect(result).toEqual(["sibling:value"])

            releaseDetached()
            await flush()

            expect(result).toEqual(["sibling:value", "detached:value"])
        })
    })

    describe("combine", () => {
        it("should share downstream operator state across source flows", async () => {
            const a = new Emitter<string>()
            const b = new Emitter<string>()
            const result: string[] = []
            let last: string | undefined

            combine(a.flow(), b.flow())
                .filter(value => {
                    if (value === last) return false
                    last = value
                    return true
                })
                .effect(value => {
                    result.push(value)
                })

            a.emit("same")
            b.emit("same")
            b.emit("other")
            await flush()

            expect(result).toEqual(["same", "other"])
        })

        it("should start each combined source only once across multiple downstream effects", async () => {
            let startA = 0
            let startB = 0
            let emitA!: (value: string) => void
            let emitB!: (value: string) => void
            const a = makeFlow<string>(push => {
                startA += 1
                emitA = push
            })
            const b = makeFlow<string>(push => {
                startB += 1
                emitB = push
            })
            const combined = combine(a, b)
            const result: string[] = []

            combined.effect(value => {
                result.push(`first:${value}`)
            })
            combined.effect(value => {
                result.push(`second:${value}`)
            })

            emitA("a")
            emitB("b")
            await flush()

            expect(startA).toBe(1)
            expect(startB).toBe(1)
            expect(result).toHaveLength(4)
            expect(result).toEqual(expect.arrayContaining(["first:a", "second:a", "first:b", "second:b"]))
        })

        it("should keep runs independent across source flows", async () => {
            const a = new Emitter<string>()
            const b = new Emitter<string>()
            const runIds: string[] = []

            combine(a.flow(), b.flow()).effect((_value, run) => {
                runIds.push(run.id)
            })

            a.emit("a")
            b.emit("b")
            await flush()

            expect(runIds).toHaveLength(2)
            expect(runIds[0]).not.toBe(runIds[1])
        })
    })

    describe("run annotations", () => {
        it("should keep JSON-compatible annotations on the current run context", async () => {
            const emitter = new Emitter<string>()
            const annotations: unknown[] = []

            emitter
                .flow()
                .map((value, run) => {
                    run.annotate("ok", { value, nested: [1, true, null] })
                    run.annotate("ignored", Number.NaN)
                    return value
                })
                .effect((_value, run) => {
                    annotations.push(run)
                })

            emitter.emit("value")
            await flush()

            expect(annotations).toHaveLength(1)
        })
    })
})

describe("permission-bound Flow", () => {
    const record = entityRef("record", "primary")
    const read = permissionClaim("record.read", record)
    const writeClaim = permissionClaim("record.write", record)

    const authority = (
        execution: ReturnType<typeof createPermissionExecution>,
        principal: string,
        claims: readonly { claim: typeof read; id: string }[],
    ): ActiveAuthority =>
        execution.core.authorityFor(
            execution.identities.issue({
                principal: entityRef("user", principal),
                contributions: claims.map(item => ({
                    claim: item.claim,
                    grant: new GrantStateCell({ id: item.id }),
                })),
            }),
        )

    it("intersects event claims with the ceiling before protected effects", async () => {
        const execution = createPermissionExecution()
        const eventAuthority = authority(execution, "alice", [
            { claim: read, id: "event-read" },
            { claim: writeClaim, id: "event-write" },
        ])
        const ceiling = authority(execution, "owner", [{ claim: read, id: "ceiling-read" }])
        const readHandler = vi.fn<(input: string) => void>()
        const writeHandler = vi.fn<(input: string) => void>()
        const readAction = execution.runtime.protect<string, void>(() => read, readHandler)
        const writeAction = execution.runtime.protect<string, void>(() => writeClaim, writeHandler)
        let emit!: (value: string) => void
        const flow = makePermissionFlow<string>(
            push => {
                emit = push
            },
            { permissions: execution.core, ceiling, workflowId: "records", authority: () => eventAuthority },
        )
        flow.effect(async value => readAction(value))
        flow.effect(async value => writeAction(value))

        emit("value")
        await flush()
        await flush()

        expect(readHandler).toHaveBeenCalledOnce()
        expect(writeHandler).not.toHaveBeenCalled()
    })

    it("keeps elevation branch-local", async () => {
        const execution = createPermissionExecution()
        const eventAuthority = authority(execution, "alice", [{ claim: read, id: "event-read" }])
        const ceiling = authority(execution, "owner", [
            { claim: read, id: "ceiling-read" },
            { claim: writeClaim, id: "ceiling-write" },
        ])
        const elevatedHandler = vi.fn<(input: string) => void>()
        const siblingHandler = vi.fn<(input: string) => void>()
        const elevatedAction = execution.runtime.protect<string, void>(() => writeClaim, elevatedHandler)
        const siblingAction = execution.runtime.protect<string, void>(() => writeClaim, siblingHandler)
        let emit!: (value: string) => void
        const flow = makePermissionFlow<string>(
            push => {
                emit = push
            },
            { permissions: execution.core, ceiling, workflowId: "records", authority: () => eventAuthority },
        )
        flow.elevate(() => writeClaim).effect(async value => elevatedAction(value))
        flow.effect(async value => siblingAction(value))

        emit("value")
        await flush()
        await flush()

        expect(elevatedHandler).toHaveBeenCalledOnce()
        expect(siblingHandler).not.toHaveBeenCalled()
    })

    it("keeps narrowing branch-local", async () => {
        const execution = createPermissionExecution()
        const eventAuthority = authority(execution, "alice", [
            { claim: read, id: "event-read" },
            { claim: writeClaim, id: "event-write" },
        ])
        const ceiling = authority(execution, "owner", [
            { claim: read, id: "ceiling-read" },
            { claim: writeClaim, id: "ceiling-write" },
        ])
        const narrowedHandler = vi.fn<(input: string) => void>()
        const siblingHandler = vi.fn<(input: string) => void>()
        const narrowedAction = execution.runtime.protect<string, void>(() => writeClaim, narrowedHandler)
        const siblingAction = execution.runtime.protect<string, void>(() => writeClaim, siblingHandler)
        let emit!: (value: string) => void
        const flow = makePermissionFlow<string>(
            push => {
                emit = push
            },
            { permissions: execution.core, ceiling, workflowId: "records", authority: () => eventAuthority },
        )
        flow.narrow(() => read).effect(value => narrowedAction(value))
        flow.effect(value => siblingAction(value))

        emit("value")
        await flush()
        await flush()

        expect(narrowedHandler).not.toHaveBeenCalled()
        expect(siblingHandler).toHaveBeenCalledOnce()
    })

    it("keeps identity assumption branch-local and bounded by the ceiling", async () => {
        const execution = createPermissionExecution()
        const eventAuthority = authority(execution, "alice", [])
        const ceiling = authority(execution, "owner", [{ claim: writeClaim, id: "ceiling-write" }])
        const bobIdentity = execution.identities.issue({
            principal: entityRef("user", "bob"),
            contributions: [{ claim: writeClaim, grant: new GrantStateCell({ id: "bob-write" }) }],
        })
        const assumedPrincipals: string[] = []
        const siblingHandler = vi.fn<(input: string) => void>()
        const assumedAction = execution.runtime.protect<string, void>(
            () => writeClaim,
            input => {
                assumedPrincipals.push(`${execution.runtime.currentAuthority().principal.id}:${input}`)
            },
        )
        const siblingAction = execution.runtime.protect<string, void>(() => writeClaim, siblingHandler)
        let emit!: (value: string) => void
        const flow = makePermissionFlow<string>(
            push => {
                emit = push
            },
            { permissions: execution.core, ceiling, workflowId: "records", authority: () => eventAuthority },
        )
        flow.assume(() => bobIdentity).effect(value => assumedAction(value))
        flow.effect(value => siblingAction(value))

        emit("value")
        await flush()
        await flush()

        expect(assumedPrincipals).toEqual(["bob:value"])
        expect(siblingHandler).not.toHaveBeenCalled()
    })

    it("denies source attachment when the ceiling lacks subscription claims", () => {
        const execution = createPermissionExecution()
        const eventAuthority = authority(execution, "alice", [])
        const ceiling = authority(execution, "owner", [])
        const flow = makePermissionFlow<string>(() => undefined, {
            permissions: execution.core,
            ceiling,
            workflowId: "records",
            authority: () => eventAuthority,
            subscriptionClaims: [read],
        })

        expect(() => {
            flow.effect(vi.fn())
        }).toThrow(PermissionError)
    })
})
