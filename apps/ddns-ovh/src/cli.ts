#!/usr/bin/env node
import { runCliMain } from "@signalbox/service-cli"
import { createDdnsOvhApp } from "./app.js"
import { APP_NAME, configSchema, createDdnsOvhConfigStore } from "./config.js"

await runCliMain({
    appName: APP_NAME,
    tagline: "OVH DynHost DDNS and a Discord reminders bot in one service",
    schema: configSchema,
    createStore: path => createDdnsOvhConfigStore(path),
    createApp: config => createDdnsOvhApp(config),
    firewallPort: config => config.watchPort ?? 5960,
})
