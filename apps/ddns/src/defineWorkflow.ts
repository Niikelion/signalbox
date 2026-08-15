import { createWorkflowDefiner } from "@signalbox/core"
import type { DdnsEvents } from "./events.js"
import type { DdnsPlugins } from "./plugins.js"

export const defineWorkflow = createWorkflowDefiner<DdnsEvents, DdnsPlugins>()
