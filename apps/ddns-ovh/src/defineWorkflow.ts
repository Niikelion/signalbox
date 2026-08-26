import { createWorkflowDefiner, type NoEvents } from "@signalbox/core"
import type { DdnsOvhPlugins } from "./plugins"

export const defineWorkflow = createWorkflowDefiner<NoEvents, DdnsOvhPlugins>()
