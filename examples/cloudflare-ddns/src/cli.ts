#!/usr/bin/env node
import { runCliMain } from "@signalbox/service-cli"
import { createDdnsApp } from "./app"
import { APP_NAME, configSchema, createDdnsConfigStore } from "./config"
import { runOnce } from "./once"

await runCliMain({
    appName: APP_NAME,
    tagline: "Cloudflare dynamic DNS driven by your router's UPnP events",
    schema: configSchema,
    createStore: createDdnsConfigStore,
    createApp: createDdnsApp,
    runOnce,
    firewallPort: config => config.watchPort ?? 5959,
})
