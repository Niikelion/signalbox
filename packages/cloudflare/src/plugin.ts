import { definePlugin } from "@signalbox/core"
import { createARecord, findARecord, patchARecord, verifyZone, type CloudflareCredentials } from "./api.js"

export type CloudflareEvents = {
    "dns:updated": { record: string; previous: string | null; current: string }
    "dns:unchanged": { ip: string }
}

export interface CloudflareOptions extends CloudflareCredentials {
    records: string[]
    ttl: number
    proxied: boolean
}

export interface CloudflareApi {
    update: (ip: string) => Promise<boolean>
    verify: () => Promise<{ name: string }>
}

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
