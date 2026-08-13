import { cloudflarePlugin } from "@flowkit/cloudflare"
import type { PluginApis } from "@flowkit/core"
import { upnpPlugin } from "@flowkit/upnp"
import type { DdnsConfig } from "./config.js"

export const buildPlugins = (config: DdnsConfig) => ({
    upnp: upnpPlugin({ port: config.watchPort }),
    cloudflare: cloudflarePlugin({
        apiToken: config.apiToken,
        zoneId: config.zoneId,
        records: config.records,
        ttl: config.ttl,
        proxied: config.proxied,
    }),
})

export type DdnsPlugins = PluginApis<ReturnType<typeof buildPlugins>>
