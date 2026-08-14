import { createWorkflowDefiner } from "@flowkit/core"
import type { DdnsOvhEvents } from "./events.js"
import type { DdnsOvhPlugins } from "./plugins.js"

/** `defineWorkflow` bound to this app's event map and plugin set. */
export const defineWorkflow = createWorkflowDefiner<DdnsOvhEvents, DdnsOvhPlugins>()
