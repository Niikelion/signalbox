import { cloudflarePlugin } from "@signalbox/cloudflare"
import { dedupe, poll, publicIPv4 } from "@signalbox/commons"
import { createApp, createWorkflowDefiner, merge, type NoEvents, type PluginApis } from "@signalbox/core"
import { upnpPlugin } from "@signalbox/upnp"

const required = (name: string): string => {
    const value = process.env[name]
    if (value === undefined || value.length === 0) {
        console.error(`Missing required env var: ${name}`)
        process.exit(1)
    }
    return value
}

const plugins = {
    upnp: upnpPlugin({ port: Number(process.env["UPNP_PORT"] ?? 5959) }),
    cloudflare: cloudflarePlugin({
        apiToken: required("CF_API_TOKEN"),
        zoneId: required("CF_ZONE_ID"),
        records: required("CF_RECORDS")
            .split(",")
            .map(record => record.trim()),
        ttl: Number(process.env["CF_TTL"] ?? 60),
        proxied: process.env["CF_PROXIED"] === "true",
    }),
}

const defineWorkflow = createWorkflowDefiner<NoEvents, PluginApis<typeof plugins>>()

// Two sources of the public IP — the router's UPnP push and a periodic poll — merged into
// one stream, de-duplicated, and written to Cloudflare only when it actually changes.
const ddns = defineWorkflow("ddns", ctx => {
    const pushed = ctx.plugins.upnp.events.flow("external-ip").map(({ ip }) => ip)
    const polled = poll({ ctx, every: 15 * 60 * 1000, probe: publicIPv4 }).map(({ value }) => value)

    merge(pushed, polled)
        .apply(dedupe())
        .run(async ip => {
            if (await ctx.plugins.cloudflare.update(ip)) ctx.log(`updated records to ${ip}`)
        })
})

await createApp({ name: "cloudflare-ddns", plugins, workflows: [ddns] }).run()
