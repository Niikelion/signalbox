import { createWorkflowDefiner } from "@signalbox/core"
import type { DdnsCfEvents } from "./events.js"
import type { DdnsCfPlugins } from "./plugins.js"

export const defineWorkflow = createWorkflowDefiner<DdnsCfEvents, DdnsCfPlugins>()
