import { write } from "@flowkit/core"
import { createARecord, findARecord, patchARecord } from "@flowkit/cloudflare"
import type { DdnsConfig } from "./config.js"
import { publicIPv4 } from "./publicIp.js"

/**
 * Update every record once and return. Unlike `run`, this is a direct awaited
 * pass — no UPnP subscription, no bus — so it finishes before the process exits.
 * The right pre-flight: it proves the token and zone by doing one real write.
 */
export const runOnce = async (config: DdnsConfig): Promise<boolean> => {
    const ip = await publicIPv4((message) => {
        write("warn", message)
    })
    const credentials = { apiToken: config.apiToken, zoneId: config.zoneId }
    let changed = false

    for (const name of config.records) {
        const existing = await findARecord(credentials, name)

        if (!existing) {
            await createARecord(credentials, { name, content: ip, ttl: config.ttl, proxied: config.proxied })
            write("info", `created ${name} -> ${ip}`)
            changed = true
            continue
        }

        if (existing.content === ip) {
            write("info", `${name} already points at ${ip}`)
            continue
        }

        await patchARecord(credentials, existing.id, {
            name,
            content: ip,
            ttl: existing.ttl,
            proxied: existing.proxied,
        })
        write("info", `updated ${name}: ${existing.content} -> ${ip}`)
        changed = true
    }

    if (!changed) write("info", `no change needed, still ${ip}`)
    return changed
}
