import { definePlugin, type ReadChannel } from "@signalbox/core"
import { createARecord, findARecord, patchARecord, verifyZone, type CloudflareCredentials } from "./api.js"

/** Events emitted by the Cloudflare plugin. */
export type CloudflareEvents = {
    /** A record was created or its content changed. */
    "dns:updated": { record: string; previous: string | null; current: string }
    /** No record needed changing. */
    "dns:unchanged": { ip: string }
}

/** Options for {@link cloudflarePlugin} and {@link applyRecords}. */
export interface CloudflareOptions extends CloudflareCredentials {
    /** Hostnames (A records) to keep pointed at the IP. */
    records: string[]
    /** TTL for records this tool creates. */
    ttl: number
    /** Whether new records route through Cloudflare's proxy. */
    proxied: boolean
}

/** The outcome for a single record from {@link applyRecords}. */
export type RecordOutcome =
    | { record: string; action: "created"; current: string }
    | { record: string; action: "updated"; previous: string; current: string }
    | { record: string; action: "unchanged"; current: string }

/**
 * Point every configured A record at `ip`, creating or patching as needed.
 * @param options credentials, records, TTL, and proxied flag
 * @param ip the target IPv4 address
 * @param onRecord called with each record's outcome
 * @returns whether anything changed
 */
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

/** The Cloudflare surface exposed to workflows as `ctx.plugins.cloudflare`. */
export interface CloudflareApi {
    /** Subscribe to `dns:updated` / `dns:unchanged`. */
    events: ReadChannel<CloudflareEvents>
    /**
     * Point the configured records at `ip`.
     * @param ip the target IPv4 address
     * @returns whether anything changed
     */
    update: (ip: string) => Promise<boolean>
    /**
     * Verify the zone credentials.
     * @returns the zone name
     */
    verify: () => Promise<{ name: string }>
}

/**
 * Plugin that keeps Cloudflare A records pointed at the current address.
 * @param options credentials and records
 */
export const cloudflarePlugin = (options: CloudflareOptions) =>
    definePlugin<CloudflareApi, CloudflareEvents>({
        name: "cloudflare",
        init: (ctx) => ({
            events: ctx.channel,
            verify: () => verifyZone(options),
            update: async (ip: string) => {
                const changed = await applyRecords(options, ip, (outcome) => {
                    if (outcome.action === "unchanged") return
                    ctx.channel.emit("dns:updated", {
                        record: outcome.record,
                        previous: outcome.action === "updated" ? outcome.previous : null,
                        current: ip,
                    })
                })

                if (!changed) ctx.channel.emit("dns:unchanged", { ip })
                return changed
            },
        }),
    })
