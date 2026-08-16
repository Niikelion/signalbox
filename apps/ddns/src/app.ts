import { createApp, type App } from "@signalbox/core"
import { APP_NAME, type DdnsConfig } from "./config.js"
import { buildPlugins } from "./plugins.js"
import { ddnsPipeline } from "./workflows/pipeline.js"

export const createDdnsApp = (config: DdnsConfig): App =>
    createApp({
        name: APP_NAME,
        plugins: buildPlugins(config),
        workflows: [ddnsPipeline(config)],
    })
