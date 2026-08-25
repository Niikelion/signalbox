import { definePlugin, type ReadChannel } from "@signalbox/core"
import { updateDynHost, type OvhDynHostCredentials } from "./api"

/** Events emitted by the OVH plugin. */
export type OvhEvents = {
    /** A DynHost record was updated. */
    "dns:updated": { record: string; previous: string | null; current: string }
    /** No record needed changing. */
    "dns:unchanged": { ip: string }
}

/** Options for {@link ovhPlugin} and {@link applyRecords}. */
export interface OvhOptions extends OvhDynHostCredentials {
    /** DynHost hostnames to keep pointed at the IP. */
    records: string[]
}

/** The outcome for a single record from {@link applyRecords}. */
export interface RecordOutcome {
    record: string
    changed: boolean
    current: string
}

/**
 * Point every configured DynHost record at `ip`.
 * @param options credentials and records
 * @param ip the target IPv4 address
 * @param onRecord called with each record's outcome
 * @returns whether anything changed
 */
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

/** The OVH surface exposed to workflows as `ctx.plugins.ovh`. */
export interface OvhApi {
    /** Subscribe to `dns:updated` / `dns:unchanged`. */
    events: ReadChannel<OvhEvents>
    /**
     * Point the configured records at `ip`.
     * @param ip the target IPv4 address
     * @returns whether anything changed
     */
    update: (ip: string) => Promise<boolean>
}

/**
 * Plugin that keeps OVH DynHost records pointed at the current address.
 * @param options credentials and records
 */
export const ovhPlugin = (options: OvhOptions) =>
    definePlugin<OvhApi, OvhEvents>({
        name: "ovh",
        init: ctx => ({
            events: ctx.channel,
            update: async (ip: string) => {
                const changed = await applyRecords(options, ip, outcome => {
                    if (outcome.changed)
                        ctx.channel.emit("dns:updated", { record: outcome.record, previous: null, current: ip })
                })

                if (!changed) ctx.channel.emit("dns:unchanged", { ip })
                return changed
            },
        }),
    })
