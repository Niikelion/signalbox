import type { CloudflareEvents } from "@signalbox/cloudflare"
import type { UpnpEvents } from "@signalbox/upnp"

export type DdnsOwnEvents = {
    "wan-ip:changed": {
        previous: string | null
        current: string
        source: "upnp" | "http" | "startup" | "reconnect"
    }
}

export type DdnsEvents = DdnsOwnEvents & UpnpEvents & CloudflareEvents
