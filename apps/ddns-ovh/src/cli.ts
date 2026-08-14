#!/usr/bin/env node
import { runCliMain } from "@flowkit/service-cli"
import { createDdnsOvhApp } from "./app.js"
import { APP_NAME, configSchema, createDdnsOvhConfigStore } from "./config.js"
import { runOnce } from "./once.js"

await runCliMain({
    appName: APP_NAME,
    tagline: "OVH DynHost dynamic DNS driven by your router's UPnP events",
    schema: configSchema,
    createStore: (path) => createDdnsOvhConfigStore(path),
    createApp: (config) => createDdnsOvhApp(config),
    runOnce,
    // the router POSTs its UPnP NOTIFY back to this port
    firewallPort: (config) => config.watchPort ?? 5960,
})
