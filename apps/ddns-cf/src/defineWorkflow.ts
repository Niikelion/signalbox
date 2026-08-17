import { createWorkflowDefiner, type NoEvents } from "@signalbox/core"
import type { DdnsCfPlugins } from "./plugins.js"

export const defineWorkflow = createWorkflowDefiner<NoEvents, DdnsCfPlugins>()
