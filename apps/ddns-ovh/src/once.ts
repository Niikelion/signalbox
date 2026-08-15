import { publicIPv4 } from "@signalbox/commons"
import { write } from "@signalbox/core"
import { applyRecords } from "@signalbox/ovh"
import type { DdnsOvhConfig } from "./config.js"

export const runOnce = async (config: DdnsOvhConfig): Promise<boolean> => {
    const ip = await publicIPv4((message) => {
        write("warn", message)
    })

    const options = { username: config.dynhostUser, password: config.dynhostPassword, records: config.records }

    const changed = await applyRecords(options, ip, (outcome) => {
        write(
            "info",
            outcome.changed ? `updated ${outcome.record} -> ${ip}` : `${outcome.record} already points at ${ip}`,
        )
    })

    if (!changed) write("info", `no change needed, still ${ip}`)
    return changed
}
