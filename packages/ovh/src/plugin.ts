import { definePlugin, type ReadChannel } from "@signalbox/core"
import { updateDynHost, type OvhDynHostCredentials } from "./api.js"

export type OvhEvents = {
    "dns:updated": { record: string; previous: string | null; current: string }
    "dns:unchanged": { ip: string }
}

export interface OvhOptions extends OvhDynHostCredentials {
    records: string[]
}

export interface RecordOutcome {
    record: string
    changed: boolean
    current: string
}

export const applyRecords = async (
    options: OvhOptions,
    ip: string,
    onRecord?: (outcome: RecordOutcome) => void,
): Promise<boolean> => {
    let changed = false

    for (const record of options.records) {
        const result = await updateDynHost(options, record, ip)
        onRecord?.({ record, changed: result.changed, current: ip })
        if (result.changed) changed = true
    }

    return changed
}

export interface OvhApi {
    events: ReadChannel<OvhEvents>
    update: (ip: string) => Promise<boolean>
}

export const ovhPlugin = (options: OvhOptions) =>
    definePlugin<OvhApi, OvhEvents>({
        name: "ovh",
        init: (ctx) => ({
            events: ctx.channel,
            update: async (ip: string) => {
                const changed = await applyRecords(options, ip, (outcome) => {
                    if (outcome.changed)
                        ctx.channel.emit("dns:updated", { record: outcome.record, previous: null, current: ip })
                })

                if (!changed) ctx.channel.emit("dns:unchanged", { ip })
                return changed
            },
        }),
    })
