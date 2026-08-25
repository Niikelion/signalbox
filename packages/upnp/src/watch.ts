import type { Server } from "node:http"
import { discoverGateway, sourceIpToward, type GatewayService } from "./discovery"
import { createNotifyServer, gena } from "./gena"

/** Severity for the watcher's log hook. */
export type WatchLevel = "info" | "warn" | "error"

/** Callbacks the watcher fires as UPnP state changes. */
export interface UpnpWatcherHooks {
    /** A new external IPv4 was observed. */
    onObserved: (ip: string) => void
    /** Subscribed to the gateway's WAN connection service. */
    onSubscribed?: (info: { sid: string; eventUrl: string; serviceType: string }) => void
    /** UPnP became unavailable. */
    onUnavailable?: (reason: string) => void
    /** The gateway came back after being unreachable. */
    onReconnected?: (info: { downSeconds: number; attempts: number }) => void
    /** Optional log sink. */
    log?: (message: string, level?: WatchLevel) => void
}

/** Options for {@link createUpnpWatcher}. */
export interface UpnpWatcherOptions {
    /** Port the GENA NOTIFY callback server listens on. */
    port: number
    /** Maximum reconnect backoff, in seconds. */
    retrySeconds?: number
    /** Minimum reconnect backoff, in seconds. */
    minRetrySeconds?: number
    /** Clock injection (for tests). */
    now?: () => number
    /** State-change callbacks. */
    hooks: UpnpWatcherHooks
}

/** A running UPnP watcher: subscribe/renew loop with reconnect handling. */
export interface UpnpWatcher {
    /** Start the NOTIFY callback server. */
    listen: () => Promise<void>
    /** Discover the gateway and subscribe (with reconnect on failure). */
    connect: () => Promise<void>
    /** Tear everything down. */
    stop: () => Promise<void>
    /** The last observed external IPv4, or `null`. */
    current: () => string | null
    /** Whether currently subscribed. */
    subscribed: () => boolean
    /** The discovered gateway, or `null`. */
    gateway: () => GatewayService | null
}

const REQUESTED_TIMEOUT = "Second-1800"

/**
 * Create a UPnP watcher that discovers the gateway, subscribes to WAN external-IP
 * events, renews the subscription, and reconnects with backoff.
 * @param options callback port, backoff, and state-change hooks
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

    let attempts = 0
    let downSince: number | null = null

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

    const teardownSubscription = async (): Promise<void> => {
        if (gateway && sid) {
            try {
                await gena(gateway.eventUrl, { SID: sid }, "UNSUBSCRIBE")
            } catch {}
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
            if (aborted()) {
                await teardownSubscription()
                return
            }
            current = null

            options.hooks.onSubscribed?.({
                sid: subscription.sid,
                eventUrl: gateway.eventUrl,
                serviceType: gateway.serviceType,
            })
            log(`subscribed to ${gateway.serviceType} via ${callback}`)
            scheduleRenew(subscription.timeoutSeconds)

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
                isCurrentSid: incoming => sid !== null && incoming === sid,
                onExternalIp: ip => {
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
                await new Promise<void>(resolve =>
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
