import type { OvhEvents } from "@signalbox/ovh"
import type { UpnpEvents } from "@signalbox/upnp"

/** Events this app owns, on top of the ones its plugins publish. */
export type DdnsOvhOwnEvents = {
    /** Emitted by the tracker once an observation is genuinely new. */
    "wan-ip:changed": {
        previous: string | null
        current: string
        source: "upnp" | "http" | "startup" | "reconnect"
    }
}

export type DdnsOvhEvents = DdnsOvhOwnEvents & UpnpEvents & OvhEvents
