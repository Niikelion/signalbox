import { definePlugin } from "@signalbox/core"
import type { GatewayService } from "./discovery.js"
import { createUpnpWatcher, type UpnpWatcher } from "./watch.js"

/** Events this plugin publishes. An app's event map must include them. */
export type UpnpEvents = {
    "wan-ip:observed": { ip: string; source: "upnp" | "http" | "startup" | "reconnect" }
    "upnp:subscribed": { sid: string; eventUrl: string; serviceType: string }
    "upnp:unavailable": { reason: string }
    /** The router answered again after being unreachable, or after forgetting us. */
    "upnp:reconnected": { downSeconds: number; attempts: number }
}

export interface UpnpOptions {
    /** TCP port the NOTIFY callback listens on. */
    port: number
    /** Ceiling for the retry backoff once the router stops answering. */
    retrySeconds?: number
    /** First retry delay after a failure; doubles up to `retrySeconds`. */
    minRetrySeconds?: number
}

export interface UpnpApi {
    /** Last address the router reported, or null if it has not told us yet. */
    current: () => string | null
    subscribed: () => boolean
    gateway: () => GatewayService | null
}

/**
 * Push-based WAN address source.
 *
 * The router's WANIPConnection/WANPPPConnection service marks ExternalIPAddress
 * as evented, so instead of polling we subscribe (GENA) and let the router POST
 * a NOTIFY the moment the address moves. The subscribe/renew loop lives in
 * `createUpnpWatcher`, which the `upnp.source` graph node shares.
 */
export const upnpPlugin = (options: UpnpOptions) => {
    let watcher: UpnpWatcher | undefined

    return definePlugin<UpnpApi, UpnpEvents>({
        name: "upnp",
        // bind the callback listener in init, so a port clash fails the app fast
        init: async (ctx) => {
            watcher = createUpnpWatcher({
                port: options.port,
                retrySeconds: options.retrySeconds,
                minRetrySeconds: options.minRetrySeconds,
                hooks: {
                    onObserved: (ip) => {
                        ctx.bus.emit("wan-ip:observed", { ip, source: "upnp" })
                    },
                    onSubscribed: (info) => {
                        ctx.bus.emit("upnp:subscribed", info)
                    },
                    onUnavailable: (reason) => {
                        ctx.bus.emit("upnp:unavailable", { reason })
                    },
                    onReconnected: (info) => {
                        ctx.bus.emit("upnp:reconnected", info)
                    },
                    log: (message, level) => {
                        ctx.log(message, level)
                    },
                },
            })
            await watcher.listen()
            ctx.onStop(() => watcher?.stop() ?? Promise.resolve())

            return {
                current: () => watcher?.current() ?? null,
                subscribed: () => watcher?.subscribed() ?? false,
                gateway: () => watcher?.gateway() ?? null,
            }
        },
        // subscribe only once every workflow is listening for the NOTIFY
        setup: async () => {
            await watcher?.connect()
        },
    })
}
