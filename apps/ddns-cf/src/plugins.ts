import { cloudflarePlugin } from "@signalbox/cloudflare"
import type { PluginApis } from "@signalbox/core"
import { upnpPlugin } from "@signalbox/upnp"
import type { DdnsCfConfig } from "./config.js"

export const buildPlugins = (config: DdnsCfConfig) => ({
    upnp: upnpPlugin({ port: config.watchPort }),
    cloudflare: cloudflarePlugin({
        apiToken: config.apiToken,
        zoneId: config.zoneId,
        records: config.records,
        ttl: config.ttl,
        proxied: config.proxied,
    }),
})

export type DdnsCfPlugins = PluginApis<ReturnType<typeof buildPlugins>>
