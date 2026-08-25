import { createWorkflowDefiner, type NoEvents } from "@signalbox/core"
import type { DdnsPlugins } from "./plugins"

export const defineWorkflow = createWorkflowDefiner<NoEvents, DdnsPlugins>()
