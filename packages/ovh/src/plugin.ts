import { definePlugin } from "@signalbox/core"
import { updateDynHost, type OvhDynHostCredentials } from "./api.js"

export type OvhEvents = {
    "dns:updated": { record: string; previous: string | null; current: string }
    "dns:unchanged": { ip: string }
}

export interface OvhOptions extends OvhDynHostCredentials {
    records: string[]
}

export interface OvhApi {
    update: (ip: string) => Promise<boolean>
}

export const ovhPlugin = (options: OvhOptions) =>
    definePlugin<OvhApi, OvhEvents>({
        name: "ovh",
        init: (ctx) => ({
            update: async (ip: string) => {
                let changed = false

                for (const record of options.records) {
                    const result = await updateDynHost(options, record, ip)
                    if (result.changed) {
                        ctx.bus.emit("dns:updated", { record, previous: null, current: ip })
                        changed = true
                    }
                }

                if (!changed) ctx.bus.emit("dns:unchanged", { ip })
                return changed
            },
        }),
    })
