import { createConfigStore, type ConfigOf } from "@flowkit/core"

export const APP_NAME = "flowkit-ddns"

export const configSchema = {
    apiToken: {
        type: "string",
        required: true,
        secret: true,
        description: "Cloudflare API token, scoped to Zone:DNS:Edit on the target zone",
    },
    zoneId: { type: "string", required: true, description: "Zone ID from the domain's Overview page" },
    records: { type: "list", required: true, description: "Comma-separated hostnames to keep updated" },
    ttl: { type: "int", description: "TTL used for records this tool creates" },
    proxied: { type: "bool", description: "Route through Cloudflare's proxy (HTTP/HTTPS only)" },
    watchPort: { type: "int", description: "TCP port the UPnP NOTIFY callback listens on" },
    fallbackMinutes: { type: "int", description: "Safety-net re-check interval" },
} as const satisfies Parameters<typeof createConfigStore>[0]["schema"]

export type DdnsConfig = ConfigOf<typeof configSchema>

export const createDdnsConfigStore = (path?: string) =>
    createConfigStore({
        appName: APP_NAME,
        schema: configSchema,
        defaults: {
            records: [],
            ttl: 60,
            proxied: false,
            watchPort: 5959,
            fallbackMinutes: 15,
        },
        ...(path ? { path } : {}),
    })
