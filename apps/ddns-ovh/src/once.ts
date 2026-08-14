import { write } from "@flowkit/core"
import { updateDynHost } from "@flowkit/ovh"
import type { DdnsOvhConfig } from "./config.js"
import { publicIPv4 } from "./publicIp.js"

/**
 * Update every record once and return. Unlike `run`, this is a direct awaited
 * pass — no UPnP subscription, no bus — so it finishes before the process exits.
 * A good pre-flight: it proves the DynHost credentials by doing one real update.
 */
export const runOnce = async (config: DdnsOvhConfig): Promise<boolean> => {
    const ip = await publicIPv4((message) => {
        write("warn", message)
    })
    const credentials = { username: config.dynhostUser, password: config.dynhostPassword }
    let changed = false

    for (const record of config.records) {
        const result = await updateDynHost(credentials, record, ip)
        if (result.changed) {
            write("info", `updated ${record} -> ${ip}`)
            changed = true
        } else {
            write("info", `${record} already points at ${ip}`)
        }
    }

    if (!changed) write("info", `no change needed, still ${ip}`)
    return changed
}
