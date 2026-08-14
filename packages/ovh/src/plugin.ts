import { definePlugin } from "@signalbox/core"
import { updateDynHost, type OvhDynHostCredentials } from "./api.js"

/** Events this plugin publishes. An app's event map must include them. */
export type OvhEvents = {
    "dns:updated": { record: string; previous: string | null; current: string }
    "dns:unchanged": { ip: string }
}

export interface OvhOptions extends OvhDynHostCredentials {
    /** DynHost hostnames to keep pointed at the current address. */
    records: string[]
}

export interface OvhApi {
    /** Point every configured DynHost record at `ip`. Resolves true if anything changed. */
    update: (ip: string) => Promise<boolean>
}

/**
 * Applies an address to OVH DNS through DynHost.
 *
 * DynHost is OVH's purpose-built dynamic-DNS endpoint: one authenticated GET per
 * record, and the server tells us whether the address actually moved. It cannot
 * create records, so each hostname must already exist as a DynHost record in the
 * OVH panel.
 */
export const ovhPlugin = (options: OvhOptions) =>
    definePlugin<OvhApi, OvhEvents>({
        name: "ovh",
        init: (ctx) => ({
            update: async (ip: string) => {
                let changed = false

                for (const record of options.records) {
                    const result = await updateDynHost(options, record, ip)
                    if (result.changed) {
                        // DynHost does not report the prior address, so previous is unknown
                        ctx.bus.emit("dns:updated", { record, previous: null, current: ip })
                        changed = true
                    }
                }

                if (!changed) ctx.bus.emit("dns:unchanged", { ip })
                return changed
            },
        }),
    })
