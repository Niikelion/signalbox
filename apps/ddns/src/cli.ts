#!/usr/bin/env node
import { runCliMain } from "@flowkit/service-cli"
import { createDdnsApp } from "./app.js"
import { APP_NAME, configSchema, createDdnsConfigStore } from "./config.js"
import { runOnce } from "./once.js"

await runCliMain({
    appName: APP_NAME,
    tagline: "Cloudflare dynamic DNS driven by your router's UPnP events",
    schema: configSchema,
    createStore: (path) => createDdnsConfigStore(path),
    createApp: (config) => createDdnsApp(config),
    runOnce,
    // the router POSTs its UPnP NOTIFY back to this port
    firewallPort: (config) => config.watchPort ?? 5959,
})
