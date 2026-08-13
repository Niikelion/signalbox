import { createApp, type App } from "@flowkit/core"
import { APP_NAME, type DdnsConfig } from "./config.js"
import type { DdnsEvents } from "./events.js"
import { buildPlugins } from "./plugins.js"
import { fallbackPoll } from "./workflows/fallbackPoll.js"
import { trackWanIp } from "./workflows/trackWanIp.js"
import { updateDns } from "./workflows/updateDns.js"

/**
 * The app is only composition: which plugins produce events, which workflows
 * react to them. All the behaviour lives in those two lists.
 */
export const createDdnsApp = (config: DdnsConfig): App<DdnsEvents> =>
    createApp({
        name: APP_NAME,
        plugins: buildPlugins(config),
        workflows: [trackWanIp, updateDns, fallbackPoll(config.fallbackMinutes)],
    })
