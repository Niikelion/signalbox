import { config, createConfigStore, field, type Infer } from "@signalbox/config"

export const APP_NAME = "signalbox-ddns-cf"

export const configSchema = config({
    apiToken: field()
        .string()
        .min(1)
        .secret()
        .describe("Cloudflare API token, scoped to Zone:DNS:Edit on the target zone"),
    zoneId: field().string().min(1).describe("Zone ID from the domain's Overview page"),
    records: field().list().nonempty().describe("Comma-separated hostnames to keep updated"),
    ttl: field().int().positive().default(60).describe("TTL used for records this tool creates"),
    proxied: field().bool().default(false).describe("Route through Cloudflare's proxy (HTTP/HTTPS only)"),
    watchPort: field().int().positive().default(5959).describe("TCP port the UPnP NOTIFY callback listens on"),
    fallbackMinutes: field().int().positive().default(15).describe("Safety-net re-check interval"),

    // Webhook proxy (VS chat -> Discord)
    discordWebhookUrl: field()
        .string()
        .min(1)
        .secret()
        .describe("Discord channel webhook URL to forward cleaned chat to"),
    httpPort: field().int().positive().default(8099).describe("Port the inbound webhook server listens on"),
    webhookPath: field()
        .string()
        .default("/vs-chat")
        .describe("Path the VS mod POSTs chat to; set to something unguessable"),
})

export type DdnsCfConfig = Infer<typeof configSchema>

export const createDdnsCfConfigStore = (path?: string) =>
    createConfigStore({ appName: APP_NAME, schema: configSchema, ...(path ? { path } : {}) })
