import { createApp, type App } from "@signalbox/core"
import { APP_NAME, type DdnsOvhConfig } from "./config.js"
import { buildPlugins } from "./plugins.js"
import { bridgeUpnp } from "./workflows/bridgeUpnp.js"
import { fallbackPoll } from "./workflows/fallbackPoll.js"
import { trackWanIp } from "./workflows/trackWanIp.js"
import { updateDns } from "./workflows/updateDns.js"

export const createDdnsOvhApp = (config: DdnsOvhConfig): App =>
    createApp({
        name: APP_NAME,
        plugins: buildPlugins(config),
        workflows: [bridgeUpnp, trackWanIp, updateDns, fallbackPoll(config.fallbackMinutes)],
    })
