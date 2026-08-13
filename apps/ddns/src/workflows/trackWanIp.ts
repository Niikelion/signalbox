import { defineWorkflow } from "../defineWorkflow.js"

/**
 * Turns a stream of "someone saw an address" into "the address actually moved".
 *
 * Producers (the UPnP plugin, the fallback poll) emit `wan-ip:observed` without
 * knowing what came before. This workflow owns that memory, so every consumer
 * downstream can trust `wan-ip:changed` and skip de-duplicating for itself.
 */
export const trackWanIp = defineWorkflow("track-wan-ip", (ctx) => {
    let previous: string | null = null

    ctx.on("wan-ip:observed", ({ ip, source }) => {
        if (ip === previous) return

        const wasKnown = previous
        previous = ip

        if (wasKnown === null) ctx.log(`WAN IP is ${ip} (via ${source})`)
        else ctx.log(`WAN IP changed ${wasKnown} -> ${ip} (via ${source})`)

        ctx.emit("wan-ip:changed", { previous: wasKnown, current: ip, source })
    })
})
