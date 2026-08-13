import { createWorkflowDefiner } from "@flowkit/core"
import type { DdnsEvents } from "./events.js"
import type { DdnsPlugins } from "./plugins.js"

/** `defineWorkflow` bound to this app's event map and plugin set. */
export const defineWorkflow = createWorkflowDefiner<DdnsEvents, DdnsPlugins>()
