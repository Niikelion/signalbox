import { createApp, type App } from "@signalbox/core"
import { APP_NAME, type DdnsOvhConfig } from "./config"
import { buildPlugins } from "./plugins"
import { reminders } from "./reminders"
import { ddnsOvhPipeline } from "./workflows"

export const createDdnsOvhApp = (config: DdnsOvhConfig): App =>
    createApp({
        name: APP_NAME,
        plugins: buildPlugins(config),
        workflows: [ddnsOvhPipeline(config), reminders(config)],
    })
