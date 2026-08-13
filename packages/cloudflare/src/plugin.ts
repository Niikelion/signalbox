import { definePlugin } from "@flowkit/core"
import { createARecord, findARecord, patchARecord, verifyZone, type CloudflareCredentials } from "./api.js"

/** Events this plugin publishes. An app's event map must include them. */
export type CloudflareEvents = {
    "dns:updated": { record: string; previous: string | null; current: string }
    "dns:unchanged": { ip: string }
}

export interface CloudflareOptions extends CloudflareCredentials {
    /** Fully qualified hostnames to keep pointed at the current address. */
    records: string[]
    ttl: number
    proxied: boolean
}

export interface CloudflareApi {
    /** Point every configured record at `ip`. Resolves to true if anything changed. */
    update: (ip: string) => Promise<boolean>
    verify: () => Promise<{ name: string }>
}

/**
 * Applies an address to Cloudflare DNS.
 *
 * Each run re-reads the record from Cloudflare rather than trusting a local
 * cache, so a record edited by hand elsewhere is still corrected, and an
 * unchanged address costs one GET and no write.
 */
export const cloudflarePlugin = (options: CloudflareOptions) =>
    definePlugin<CloudflareApi, CloudflareEvents>({
        name: "cloudflare",
        init: (ctx) => ({
            verify: () => verifyZone(options),
            update: async (ip: string) => {
                let changed = false

                for (const name of options.records) {
                    const existing = await findARecord(options, name)

                    if (!existing) {
                        await createARecord(options, { name, content: ip, ttl: options.ttl, proxied: options.proxied })
                        ctx.bus.emit("dns:updated", { record: name, previous: null, current: ip })
                        changed = true
                        continue
                    }

                    if (existing.content === ip) continue

                    // preserve whatever ttl/proxied the record already had
                    await patchARecord(options, existing.id, {
                        name,
                        content: ip,
                        ttl: existing.ttl,
                        proxied: existing.proxied,
                    })
                    ctx.bus.emit("dns:updated", { record: name, previous: existing.content, current: ip })
                    changed = true
                }

                if (!changed) ctx.bus.emit("dns:unchanged", { ip })
                return changed
            },
        }),
    })
