import { write } from "@signalbox/core"
import { updateDynHost } from "@signalbox/ovh"
import type { DdnsOvhConfig } from "./config.js"
import { publicIPv4 } from "@signalbox/commons"

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
