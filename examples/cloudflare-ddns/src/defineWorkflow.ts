import { createWorkflowDefiner, type NoEvents } from "@signalbox/core"
import type { DdnsPlugins } from "./plugins.js"

export const defineWorkflow = createWorkflowDefiner<NoEvents, DdnsPlugins>()
