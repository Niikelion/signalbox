import { defineWorkflow } from "../defineWorkflow.js"

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
