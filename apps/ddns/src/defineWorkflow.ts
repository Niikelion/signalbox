import { createDedupe, createPoll } from "@signalbox/commons"
import { createWorkflowDefiner } from "@signalbox/core"
import type { DdnsEvents } from "./events.js"
import type { DdnsPlugins } from "./plugins.js"

export const defineWorkflow = createWorkflowDefiner<DdnsEvents, DdnsPlugins>()
export const poll = createPoll<DdnsEvents, DdnsPlugins>()
export const dedupe = createDedupe<DdnsEvents, DdnsPlugins>()
