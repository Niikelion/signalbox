import type { Server } from "node:http"
import { discoverGateway, sourceIpToward, type GatewayService } from "./discovery.js"
import { createNotifyServer, gena } from "./gena.js"

export type WatchLevel = "info" | "warn" | "error"

export interface UpnpWatcherHooks {
    /** A NOTIFY carried an address. May repeat the same one. */
    onObserved: (ip: string) => void
    onSubscribed?: (info: { sid: string; eventUrl: string; serviceType: string }) => void
    /** Fired once when the router first stops answering, not on every retry. */
    onUnavailable?: (reason: string) => void
    /** The router answered again after a spell of being unreachable. */
    onReconnected?: (info: { downSeconds: number; attempts: number }) => void
    log?: (message: string, level?: WatchLevel) => void
}

export interface UpnpWatcherOptions {
    /** TCP port the NOTIFY callback listens on. */
    port: number
    /** Ceiling for the retry backoff once the router stops answering. Default 600s. */
    retrySeconds?: number
    /** First retry delay after a failure; doubles up to `retrySeconds`. Default 5s. */
    minRetrySeconds?: number
    /** Injectable clock, so the reconnect report is testable. */
    now?: () => number
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
    const maxRetryMs = (options.retrySeconds ?? 600) * 1000
    const minRetryMs = Math.min((options.minRetrySeconds ?? 5) * 1000, maxRetryMs)
    const now = options.now ?? Date.now
    const log = options.hooks.log ?? ((): void => undefined)

    let server: Server | null = null
    let gateway: GatewayService | null = null
    let sid: string | null = null
    let current: string | null = null
    let renewTimer: NodeJS.Timeout | undefined
    let retryTimer: NodeJS.Timeout | undefined
    let stopped = false

    // Retry state. `downSince` doubles as "are we currently unreachable?", which
    // keeps onUnavailable a one-shot edge rather than one event per attempt.
    let attempts = 0
    let downSince: number | null = null

    // read through a function so TS does not narrow `stopped` to false after the
    // entry guard and then flag every post-await re-check as dead code
    const aborted = (): boolean => stopped

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

    /**
     * Back off from `minRetryMs` to `maxRetryMs`, doubling each attempt. A router
     * reboot is over in a minute or two, so probing every 5s at first gets us
     * resubscribed almost as soon as it answers; the ceiling stops a permanently
     * UPnP-less host (a VPS) from searching forever.
     */
    const scheduleRetry = (): void => {
        const delay = Math.min(maxRetryMs, minRetryMs * 2 ** attempts)
        attempts += 1

        clearTimeout(retryTimer)
        retryTimer = setTimeout(() => {
            void connect()
        }, delay)
        retryTimer.unref()

        log(`router unreachable, retrying in ${String(Math.round(delay / 1000))}s`, "warn")
    }

    /** UNSUBSCRIBE if we hold a live subscription, then forget it. */
    const teardownSubscription = async (): Promise<void> => {
        if (gateway && sid) {
            try {
                await gena(gateway.eventUrl, { SID: sid }, "UNSUBSCRIBE")
            } catch {
                /* the router will expire it on its own */
            }
        }
        sid = null
        gateway = null
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
            // A rejected renew means the router forgot us, which in practice means
            // it rebooted — and rebooted onto a new WAN address while we were idle.
            // Mark us as down so the successful resubscribe reports a recovery.
            downSince ??= now()
            await connect()
        }
    }

    const connect = async (): Promise<void> => {
        if (aborted()) return
        try {
            gateway = await discoverGateway()
            if (aborted()) {
                gateway = null
                return
            }

            const callbackIp = await sourceIpToward(new URL(gateway.eventUrl).hostname)
            if (aborted()) {
                gateway = null
                return
            }
            const callback = `http://${callbackIp}:${String(options.port)}/`

            const subscription = await gena(gateway.eventUrl, {
                CALLBACK: `<${callback}>`,
                NT: "upnp:event",
                TIMEOUT: REQUESTED_TIMEOUT,
            })
            sid = subscription.sid
            // stop() may have run during discovery/subscribe; it could not tear
            // down a subscription that did not exist yet, so we must do it here.
            if (aborted()) {
                await teardownSubscription()
                return
            }
            current = null // the initial NOTIFY re-syncs us

            options.hooks.onSubscribed?.({
                sid: subscription.sid,
                eventUrl: gateway.eventUrl,
                serviceType: gateway.serviceType,
            })
            log(`subscribed to ${gateway.serviceType} via ${callback}`)
            scheduleRenew(subscription.timeoutSeconds)

            // A router that went away and came back almost certainly came back on
            // a different WAN address, and the reboot wiped the old subscription
            // before it could tell us. Announce the recovery so the app can go and
            // check the address itself rather than trust the initial NOTIFY alone.
            const recovery =
                downSince === null ? null : { downSeconds: Math.round((now() - downSince) / 1000), attempts }
            downSince = null
            attempts = 0

            if (recovery) {
                log(`router back after ${String(recovery.downSeconds)}s (${String(recovery.attempts)} attempts)`)
                options.hooks.onReconnected?.(recovery)
            }
        } catch (error) {
            gateway = null
            sid = null
            if (downSince === null) {
                downSince = now()
                options.hooks.onUnavailable?.((error as Error).message)
            }
            scheduleRetry()
        }
    }

    return {
        listen: async () => {
            if (server) return
            server = await createNotifyServer({
                port: options.port,
                // only trust a NOTIFY tagged with the SID of our live subscription
                isCurrentSid: (incoming) => sid !== null && incoming === sid,
                onExternalIp: (ip) => {
                    current = ip
                    options.hooks.onObserved(ip)
                },
                log,
            })
            log(`listening for UPnP NOTIFY on 0.0.0.0:${String(options.port)}`)
        },
        connect,
        stop: async () => {
            stopped = true
            clearTimeout(renewTimer)
            clearTimeout(retryTimer)
            await teardownSubscription()
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
