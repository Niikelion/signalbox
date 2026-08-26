import { describe, expect, it, vi } from "vitest"
import { createWorkflowDefiner, type WorkflowContext } from "@/index"

type AppEvents = {
    started: { ok: true }
}

type Plugins = {
    plugin: { value: number }
}

describe("createWorkflowDefiner", () => {
    it("should create workflow definitions with name and setup", async () => {
        const defineWorkflow = createWorkflowDefiner<AppEvents, Plugins>()
        const setup = vi.fn()

        const workflow = defineWorkflow("workflow", setup)
        const context = { plugins: { plugin: { value: 1 } } } as WorkflowContext<AppEvents, Plugins>

        await workflow.setup(context)

        expect(workflow.name).toBe("workflow")
        expect(setup).toHaveBeenCalledWith(context)
    })
})
