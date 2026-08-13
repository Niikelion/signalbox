import type { Server } from "node:http"
import { discoverGateway, sourceIpToward, type GatewayService } from "./discovery.js"
import { createNotifyServer, gena } from "./gena.js"

export type WatchLevel = "info" | "warn" | "error"

export interface UpnpWatcherHooks {
    /** A NOTIFY carried an address. May repeat the same one. */
    onObserved: (ip: string) => void
    onSubscribed?: (info: { sid: string; eventUrl: string; serviceType: string }) => void
    onUnavailable?: (reason: string) => void
    log?: (message: string, level?: WatchLevel) => void
}

export interface UpnpWatcherOptions {
    /** TCP port the NOTIFY callback listens on. */
    port: number
    /** How long to wait before retrying discovery after a failure. Default 600s. */
    retrySeconds?: number
    hooks: UpnpWatcherHooks
}

export interface UpnpWatcher {
    /** Bind the callback server. Fails fast on a port clash. */
    listen: () => Promise<void>
    /** Discover the gateway, subscribe, and keep the subscription renewed. */
    connect: () => Promise<void>
    stop: () => Promise<void>
    current: () => string | null
    subscribed: () => boolean
    gateway: () => GatewayService | null
}

const REQUESTED_TIMEOUT = "Second-1800"

/**
 * The push-based watch loop, shared by the plugin and the `upnp.source` graph
 * node. It subscribes to the router's evented ExternalIPAddress, renews at half
 * the timeout, and resubscribes if the router reboots and forgets us.
 */
export const createUpnpWatcher = (options: UpnpWatcherOptions): UpnpWatcher => {
    const retryMs = (options.retrySeconds ?? 600) * 1000
    const log = options.hooks.log ?? ((): void => undefined)

    let server: Server | null = null
    let gateway: GatewayService | null = null
    let sid: string | null = null
    let current: string | null = null
    let renewTimer: NodeJS.Timeout | undefined
    let retryTimer: NodeJS.Timeout | undefined
    let stopped = false

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
            log(`renew failed, resubscribing: ${(error as Error).message}`, "warn")
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

            options.hooks.onSubscribed?.({
                sid: subscription.sid,
                eventUrl: gateway.eventUrl,
                serviceType: gateway.serviceType,
            })
            log(`subscribed to ${gateway.serviceType} via ${callback}`)
            scheduleRenew(subscription.timeoutSeconds)
        } catch (error) {
            gateway = null
            sid = null
            options.hooks.onUnavailable?.((error as Error).message)
            scheduleRetry()
        }
    }

    return {
        listen: async () => {
            if (server) return
            server = await createNotifyServer(options.port, (ip) => {
                current = ip
                options.hooks.onObserved(ip)
            })
            log(`listening for UPnP NOTIFY on 0.0.0.0:${String(options.port)}`)
        },
        connect,
        stop: async () => {
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
            const active = server
            server = null
            if (active) {
                await new Promise<void>((resolve) =>
                    active.close(() => {
                        resolve()
                    }),
                )
            }
        },
        current: () => current,
        subscribed: () => sid !== null,
        gateway: () => gateway,
    }
}
