import { createDedupe, createPoll } from "@signalbox/commons"
import { createWorkflowDefiner } from "@signalbox/core"
import type { DdnsOvhEvents } from "./events.js"
import type { DdnsOvhPlugins } from "./plugins.js"

export const defineWorkflow = createWorkflowDefiner<DdnsOvhEvents, DdnsOvhPlugins>()
export const poll = createPoll<DdnsOvhEvents, DdnsOvhPlugins>()
export const dedupe = createDedupe<DdnsOvhEvents, DdnsOvhPlugins>()
