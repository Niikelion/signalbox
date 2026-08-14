import { defineWorkflow } from "../defineWorkflow.js"
import { publicIPv4 } from "../publicIp.js"

/** Seconds to wait between attempts while the router's WAN side comes up. */
const RECONNECT_BACKOFF = [5, 15, 30, 60] as const

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms).unref()
    })

/**
 * Safety net for the case UPnP cannot cover: the router reboots and silently
 * forgets our subscription, or there is no UPnP gateway at all (a VPS, or UPnP
 * switched off). Because it emits the same `wan-ip:observed` event as the push
 * path, the tracker de-duplicates it and a quiet connection costs nothing.
 */
export const fallbackPoll = (intervalMinutes: number) =>
    defineWorkflow("fallback-poll", (ctx) => {
        let stopped = false
        ctx.onStop(() => {
            stopped = true
        })

        const check = async (source: "http" | "startup" | "reconnect"): Promise<void> => {
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

        // The router is answering on the LAN again, but its WAN side may still be
        // dialling, so the first lookup can legitimately fail. Retry briefly rather
        // than waiting out the full poll interval with stale DNS.
        ctx.on("upnp:reconnected", async ({ downSeconds }) => {
            ctx.log(`router reachable again after ${String(downSeconds)}s - re-checking WAN IP`)

            for (const waitSeconds of RECONNECT_BACKOFF) {
                if (stopped) return
                try {
                    await check("reconnect")
                    return
                } catch (error) {
                    ctx.log(
                        `re-check failed (${(error as Error).message}), retrying in ${String(waitSeconds)}s`,
                        "warn",
                    )
                    await sleep(waitSeconds * 1000)
                }
            }
            ctx.log(
                `could not confirm WAN IP after reconnect - falling back to the ${String(intervalMinutes)}m poll`,
                "warn",
            )
        })
    })
