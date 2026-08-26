import { applyRecords } from "@signalbox/cloudflare"
import { publicIPv4 } from "@signalbox/commons"
import { write } from "@signalbox/core"
import type { CloudflareDdnsConfig } from "./config"

export const runOnce = async (config: CloudflareDdnsConfig): Promise<boolean> => {
    const ip = await publicIPv4(message => {
        write("warn", message)
    })

    const changed = await applyRecords({ ...config, apiToken: config.apiToken.reveal() }, ip, outcome => {
        if (outcome.action === "created") write("info", `created ${outcome.record} -> ${ip}`)
        else if (outcome.action === "updated") write("info", `updated ${outcome.record}: ${outcome.previous} -> ${ip}`)
        else write("info", `${outcome.record} already points at ${ip}`)
    })

    if (!changed) write("info", `no change needed, still ${ip}`)
    return changed
}
