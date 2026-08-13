import { defineWorkflow } from "../defineWorkflow.js"
import { publicIPv4 } from "../publicIp.js"

/**
 * Safety net for the case UPnP cannot cover: the router reboots and silently
 * forgets our subscription, or there is no UPnP gateway at all (a VPS, or UPnP
 * switched off). Because it emits the same `wan-ip:observed` event as the push
 * path, the tracker de-duplicates it and a quiet connection costs nothing.
 */
export const fallbackPoll = (intervalMinutes: number) =>
    defineWorkflow("fallback-poll", (ctx) => {
        const check = async (source: "http" | "startup"): Promise<void> => {
            const ip = await publicIPv4((message) => {
                ctx.log(message, "warn")
            })
            ctx.emit("wan-ip:observed", { ip, source })
        }

        // one immediate check so DNS is correct even if the router never notifies
        ctx.on("app:started", () => {
            void check("startup").catch((error: unknown) => {
                ctx.fail(error)
            })
        })

        ctx.interval(intervalMinutes * 60 * 1000, () => check("http"))

        ctx.on("upnp:unavailable", ({ reason }) => {
            ctx.log(`UPnP unavailable (${reason}) - relying on the ${String(intervalMinutes)}m poll`, "warn")
        })
    })
