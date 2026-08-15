import type { OvhEvents } from "@signalbox/ovh"
import type { UpnpEvents } from "@signalbox/upnp"

export type DdnsOvhOwnEvents = {
    "wan-ip:changed": {
        previous: string | null
        current: string
        source: "upnp" | "http" | "startup" | "reconnect"
    }
}

export type DdnsOvhEvents = DdnsOvhOwnEvents & UpnpEvents & OvhEvents
