import { createApp, type App } from "@signalbox/core"
import { APP_NAME, type CloudflareDdnsConfig } from "./config.js"
import { buildPlugins } from "./plugins.js"
import { ddnsPipeline } from "./workflows.js"

export const createDdnsApp = (config: CloudflareDdnsConfig): App =>
    createApp({
        name: APP_NAME,
        plugins: buildPlugins(config),
        workflows: [ddnsPipeline(config)],
    })
