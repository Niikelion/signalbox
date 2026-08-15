type WanIpSource = "upnp" | "http" | "startup" | "reconnect"

export type DdnsEvents = {
    "wan-ip:observed": { ip: string; source: WanIpSource }
    "wan-ip:changed": { previous: string | null; current: string; source: WanIpSource }
    "wan-ip:recheck": { downSeconds: number }
}
