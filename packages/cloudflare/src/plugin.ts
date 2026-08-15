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

export type RecordOutcome =
    | { record: string; action: "created"; current: string }
    | { record: string; action: "updated"; previous: string; current: string }
    | { record: string; action: "unchanged"; current: string }

export const applyRecords = async (
    options: CloudflareOptions,
    ip: string,
    onRecord?: (outcome: RecordOutcome) => void,
): Promise<boolean> => {
    let changed = false

    for (const name of options.records) {
        const existing = await findARecord(options, name)

        if (!existing) {
            await createARecord(options, { name, content: ip, ttl: options.ttl, proxied: options.proxied })
            onRecord?.({ record: name, action: "created", current: ip })
            changed = true
            continue
        }

        if (existing.content === ip) {
            onRecord?.({ record: name, action: "unchanged", current: ip })
            continue
        }

        await patchARecord(options, existing.id, {
            name,
            content: ip,
            ttl: existing.ttl,
            proxied: existing.proxied,
        })
        onRecord?.({ record: name, action: "updated", previous: existing.content, current: ip })
        changed = true
    }

    return changed
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
                const changed = await applyRecords(options, ip, (outcome) => {
                    if (outcome.action === "unchanged") return
                    ctx.bus.emit("dns:updated", {
                        record: outcome.record,
                        previous: outcome.action === "updated" ? outcome.previous : null,
                        current: ip,
                    })
                })

                if (!changed) ctx.bus.emit("dns:unchanged", { ip })
                return changed
            },
        }),
    })
