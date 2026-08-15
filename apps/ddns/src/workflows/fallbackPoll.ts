import { defineWorkflow } from "../defineWorkflow.js"
import { publicIPv4 } from "../publicIp.js"

const RECONNECT_BACKOFF = [5, 15, 30, 60] as const

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms).unref()
    })

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

        ctx.on("app:started", () => {
            void check("startup").catch((error: unknown) => {
                ctx.fail(error)
            })
        })

        ctx.interval(intervalMinutes * 60 * 1000, () => check("http"))

        ctx.on("upnp:unavailable", ({ reason }) => {
            ctx.log(`UPnP unavailable (${reason}) - relying on the ${String(intervalMinutes)}m poll`, "warn")
        })

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
