import { createBus, type EventMap, type RunContext, type WorkflowContext } from "@signalbox/core"
import { describe, expect, it } from "vitest"
import { compileGraph, createNodeRegistry, type GraphNodeContext } from "../src/index.js"

const flush = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 0))
}

const setupContext = (): WorkflowContext<EventMap, Record<string, unknown>> => ({
    app: createBus().channel<EventMap>("app"),
    plugins: {},
    log: () => undefined,
    fail: error => {
        throw error
    },
    onStart: () => undefined,
    onStop: () => undefined,
    interval: () => undefined,
})

describe("graph flow runtime", () => {
    it("passes Flow run context through graph actions", async () => {
        const pushes: Array<(value: unknown) => void> = []
        const runs: RunContext[] = []
        const registry = createNodeRegistry()

        registry.register({
            type: "source",
            kind: "trigger",
            configSchema: {},
            create: () => ({
                start: ({ push }: { ctx: GraphNodeContext; push: (value: unknown) => void }) => {
                    pushes.push(push)
                },
            }),
        })
        registry.register({
            type: "capture",
            kind: "map",
            configSchema: {},
            create: () => ({
                run: ({ input, run }) => {
                    runs.push(run)
                    return input
                },
            }),
        })

        const workflow = compileGraph(
            {
                name: "tracked",
                nodes: [
                    { id: "source", type: "source" },
                    { id: "capture", type: "capture" },
                ],
                edges: [{ from: "source", to: "capture" }],
            },
            { registry },
        )

        await workflow.setup(setupContext())
        for (const push of pushes) push("x")
        await flush()

        expect(runs).toHaveLength(1)
        expect(runs[0]?.id).toBeTruthy()
        expect(runs[0]?.correlationId).toBe(runs[0]?.id)
        expect(runs[0]?.parentRunId).toBeUndefined()
        expect(runs[0]?.causedByRunId).toBeUndefined()
    })

    it("creates joined child runs for graph fork nodes", async () => {
        const pushes: Array<(value: unknown) => void> = []
        let parent: RunContext | undefined
        const children: RunContext[] = []
        const registry = createNodeRegistry()

        registry.register({
            type: "source",
            kind: "trigger",
            configSchema: {},
            create: () => ({
                start: ({ push }: { ctx: GraphNodeContext; push: (value: unknown) => void }) => {
                    pushes.push(push)
                },
            }),
        })
        registry.register({
            type: "split",
            kind: "fork",
            configSchema: {},
            create: () => ({
                run: ({ run }) => {
                    parent = run
                    return ["a", "b"]
                },
            }),
        })
        registry.register({
            type: "capture",
            kind: "map",
            configSchema: {},
            create: () => ({
                run: ({ input, run }) => {
                    children.push(run)
                    return input
                },
            }),
        })

        const workflow = compileGraph(
            {
                name: "fanout",
                nodes: [
                    { id: "source", type: "source" },
                    { id: "split", type: "split" },
                    { id: "capture", type: "capture" },
                ],
                edges: [
                    { from: "source", to: "split" },
                    { from: "split", to: "capture" },
                ],
            },
            { registry },
        )

        await workflow.setup(setupContext())
        for (const push of pushes) push("x")
        await flush()

        expect(children).toHaveLength(2)
        expect(children.map(run => run.parentRunId)).toEqual([parent?.id, parent?.id])
        expect(children.map(run => run.causedByRunId)).toEqual([parent?.id, parent?.id])
        expect(children.map(run => run.correlationId)).toEqual([parent?.correlationId, parent?.correlationId])
    })
})
