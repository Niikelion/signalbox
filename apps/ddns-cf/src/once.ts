import { applyRecords } from "@signalbox/cloudflare"
import { publicIPv4 } from "@signalbox/commons"
import { write } from "@signalbox/core"
import type { DdnsCfConfig } from "./config.js"

export const runOnce = async (config: DdnsCfConfig): Promise<boolean> => {
    const ip = await publicIPv4(message => {
        write("warn", message)
    })

    const changed = await applyRecords(config, ip, outcome => {
        if (outcome.action === "created") write("info", `created ${outcome.record} -> ${ip}`)
        else if (outcome.action === "updated") write("info", `updated ${outcome.record}: ${outcome.previous} -> ${ip}`)
        else write("info", `${outcome.record} already points at ${ip}`)
    })

    if (!changed) write("info", `no change needed, still ${ip}`)
    return changed
}
