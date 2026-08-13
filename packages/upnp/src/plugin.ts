import { definePlugin } from "@flowkit/core"
import { discoverGateway, sourceIpToward, type GatewayService } from "./discovery.js"
import { createNotifyServer, gena } from "./gena.js"

/** Events this plugin publishes. An app's event map must include them. */
export type UpnpEvents = {
    "wan-ip:observed": { ip: string; source: "upnp" | "http" | "startup" }
    "upnp:subscribed": { sid: string; eventUrl: string; serviceType: string }
    "upnp:unavailable": { reason: string }
}

export interface UpnpOptions {
    /** TCP port the NOTIFY callback listens on. */
    port: number
    /** How long to wait before retrying discovery after a failure. */
    retrySeconds?: number
}

export interface UpnpApi {
    /** Last address the router reported, or null if it has not told us yet. */
    current: () => string | null
    subscribed: () => boolean
    gateway: () => GatewayService | null
}

const REQUESTED_TIMEOUT = "Second-1800"

/**
 * Push-based WAN address source.
 *
 * The router's WANIPConnection/WANPPPConnection service marks ExternalIPAddress
 * as evented, so instead of polling we subscribe (GENA) and let the router POST
 * a NOTIFY the moment the address moves. The subscription is renewed at half its
 * timeout; if the router reboots and forgets us, renewal fails and we resubscribe.
 */
export const upnpPlugin = (options: UpnpOptions) => {
    // Held between the two phases: the callback listener binds in `init`, so a
    // port clash still fails the app fast, but subscribing waits for `setup` —
    // the router answers a SUBSCRIBE with an immediate NOTIFY, and that must not
    // arrive before the workflows are listening for it.
    let beginSubscription: (() => Promise<void>) | undefined

    return definePlugin<UpnpApi, UpnpEvents>({
        name: "upnp",
        setup: async () => {
            await beginSubscription?.()
        },
        init: async (ctx) => {
            const retryMs = (options.retrySeconds ?? 600) * 1000

            let gateway: GatewayService | null = null
            let sid: string | null = null
            let current: string | null = null
            let renewTimer: NodeJS.Timeout | undefined
            let retryTimer: NodeJS.Timeout | undefined
            let stopped = false

            const server = await createNotifyServer(options.port, (ip) => {
                current = ip
                ctx.bus.emit("wan-ip:observed", { ip, source: "upnp" })
            })
            ctx.log(`listening for UPnP NOTIFY on 0.0.0.0:${String(options.port)}`)

            const scheduleRenew = (timeoutSeconds: number): void => {
                clearTimeout(renewTimer)
                renewTimer = setTimeout(
                    () => {
                        void renew()
                    },
                    Math.max(60, timeoutSeconds / 2) * 1000,
                )
                renewTimer.unref()
            }

            const scheduleRetry = (): void => {
                clearTimeout(retryTimer)
                retryTimer = setTimeout(() => {
                    void connect()
                }, retryMs)
                retryTimer.unref()
            }

            const renew = async (): Promise<void> => {
                if (stopped || !gateway || !sid) return
                try {
                    const renewed = await gena(gateway.eventUrl, { SID: sid, TIMEOUT: REQUESTED_TIMEOUT })
                    sid = renewed.sid || sid
                    scheduleRenew(renewed.timeoutSeconds)
                } catch (error) {
                    ctx.log(`renew failed, resubscribing: ${(error as Error).message}`, "warn")
                    sid = null
                    await connect()
                }
            }

            const connect = async (): Promise<void> => {
                if (stopped) return
                try {
                    gateway = await discoverGateway()
                    const callbackIp = await sourceIpToward(new URL(gateway.eventUrl).hostname)
                    const callback = `http://${callbackIp}:${String(options.port)}/`

                    const subscription = await gena(gateway.eventUrl, {
                        CALLBACK: `<${callback}>`,
                        NT: "upnp:event",
                        TIMEOUT: REQUESTED_TIMEOUT,
                    })
                    sid = subscription.sid
                    current = null // the initial NOTIFY re-syncs us

                    ctx.bus.emit("upnp:subscribed", {
                        sid: subscription.sid,
                        eventUrl: gateway.eventUrl,
                        serviceType: gateway.serviceType,
                    })
                    ctx.log(`subscribed to ${gateway.serviceType} via ${callback}`)
                    scheduleRenew(subscription.timeoutSeconds)
                } catch (error) {
                    gateway = null
                    sid = null
                    ctx.bus.emit("upnp:unavailable", { reason: (error as Error).message })
                    scheduleRetry()
                }
            }

            ctx.onStop(async () => {
                stopped = true
                clearTimeout(renewTimer)
                clearTimeout(retryTimer)
                if (gateway && sid) {
                    try {
                        await gena(gateway.eventUrl, { SID: sid }, "UNSUBSCRIBE")
                    } catch {
                        /* the router will expire it on its own */
                    }
                }
                await new Promise<void>((resolve) =>
                    server.close(() => {
                        resolve()
                    }),
                )
            })

            beginSubscription = connect

            return {
                current: () => current,
                subscribed: () => sid !== null,
                gateway: () => gateway,
            }
        },
    })
}
