import { createApp, type App } from "@signalbox/core"
import { APP_NAME, type DdnsOvhConfig } from "./config.js"
import { buildPlugins } from "./plugins.js"
import { ddnsOvhPipeline } from "./workflows.js"

export const createDdnsOvhApp = (config: DdnsOvhConfig): App =>
    createApp({
        name: APP_NAME,
        plugins: buildPlugins(config),
        workflows: [ddnsOvhPipeline(config)],
    })
