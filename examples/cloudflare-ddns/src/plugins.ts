import { cloudflarePlugin } from "@signalbox/cloudflare"
import type { PluginApis } from "@signalbox/core"
import { upnpPlugin } from "@signalbox/upnp"
import type { CloudflareDdnsConfig } from "./config"

export const buildPlugins = (config: CloudflareDdnsConfig) => ({
    upnp: upnpPlugin({ port: config.watchPort }),
    cloudflare: cloudflarePlugin({
        apiToken: config.apiToken.reveal(),
        zoneId: config.zoneId,
        records: config.records,
        ttl: config.ttl,
        proxied: config.proxied,
    }),
})

export type DdnsPlugins = PluginApis<ReturnType<typeof buildPlugins>>
