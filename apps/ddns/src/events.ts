import type { CloudflareEvents } from "@signalbox/cloudflare"
import type { UpnpEvents } from "@signalbox/upnp"

/** Events this app owns, on top of the ones its plugins publish. */
export type DdnsOwnEvents = {
    /** Emitted by the tracker once an observation is genuinely new. */
    "wan-ip:changed": {
        previous: string | null
        current: string
        source: "upnp" | "http" | "startup" | "reconnect"
    }
}

export type DdnsEvents = DdnsOwnEvents & UpnpEvents & CloudflareEvents
