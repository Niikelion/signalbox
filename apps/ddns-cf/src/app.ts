import { createApp, type App } from "@signalbox/core"
import { APP_NAME, type DdnsCfConfig } from "./config.js"
import { buildPlugins } from "./plugins.js"
import { ddnsCfPipeline } from "./workflows/pipeline.js"

export const createDdnsCfApp = (config: DdnsCfConfig): App =>
    createApp({
        name: APP_NAME,
        plugins: buildPlugins(config),
        workflows: [ddnsCfPipeline(config)],
    })
