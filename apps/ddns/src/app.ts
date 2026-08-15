import { createApp, type App } from "@signalbox/core"
import { APP_NAME, type DdnsConfig } from "./config.js"
import type { DdnsEvents } from "./events.js"
import { buildPlugins } from "./plugins.js"
import { fallbackPoll } from "./workflows/fallbackPoll.js"
import { trackWanIp } from "./workflows/trackWanIp.js"
import { updateDns } from "./workflows/updateDns.js"

export const createDdnsApp = (config: DdnsConfig): App<DdnsEvents> =>
    createApp({
        name: APP_NAME,
        plugins: buildPlugins(config),
        workflows: [trackWanIp, updateDns, fallbackPoll(config.fallbackMinutes)],
    })
