import { cloudflarePlugin } from "@signalbox/cloudflare"
import type { PluginApis } from "@signalbox/core"
import { discordPlugin } from "@signalbox/discord"
import { httpPlugin } from "@signalbox/http"
import { upnpPlugin } from "@signalbox/upnp"
import { webhookPlugin } from "@signalbox/webhook"
import type { DdnsCfConfig } from "./config.js"

export const buildPlugins = (config: DdnsCfConfig) => {
    const http = httpPlugin({ port: config.httpPort })

    return {
        upnp: upnpPlugin({ port: config.watchPort }),
        cloudflare: cloudflarePlugin({
            apiToken: config.apiToken,
            zoneId: config.zoneId,
            records: config.records,
            ttl: config.ttl,
            proxied: config.proxied,
        }),
        http,
        webhook: webhookPlugin({ http, routes: { "vs-chat": { path: config.webhookPath } } }),
        discord: discordPlugin({ webhookUrl: config.discordWebhookUrl }),
    }
}

export type DdnsCfPlugins = PluginApis<ReturnType<typeof buildPlugins>>
