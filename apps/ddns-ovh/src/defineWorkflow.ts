import { createWorkflowDefiner, type NoEvents } from "@signalbox/core"
import type { DdnsOvhPlugins } from "./plugins.js"

export const defineWorkflow = createWorkflowDefiner<NoEvents, DdnsOvhPlugins>()
