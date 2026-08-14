import { createConfigStore, type ConfigOf } from "@flowkit/core"

export const APP_NAME = "flowkit-ddns-ovh"

export const configSchema = {
    dynhostUser: {
        type: "string",
        required: true,
        description: "DynHost username created in the OVH panel (e.g. example.com-home)",
    },
    dynhostPassword: {
        type: "string",
        required: true,
        secret: true,
        description: "Password set for that DynHost username",
    },
    records: { type: "list", required: true, description: "Comma-separated DynHost hostnames to keep updated" },
    watchPort: { type: "int", description: "TCP port the UPnP NOTIFY callback listens on" },
    fallbackMinutes: { type: "int", description: "Safety-net re-check interval" },
} as const satisfies Parameters<typeof createConfigStore>[0]["schema"]

export type DdnsOvhConfig = ConfigOf<typeof configSchema>

export const createDdnsOvhConfigStore = (path?: string) =>
    createConfigStore({
        appName: APP_NAME,
        schema: configSchema,
        defaults: {
            records: [],
            // one higher than the Cloudflare app's 5959, so both can run on one host
            watchPort: 5960,
            fallbackMinutes: 15,
        },
        ...(path ? { path } : {}),
    })
