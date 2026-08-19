import { definePlugin, type ReadChannel } from "@signalbox/core"
import type { GatewayService } from "./discovery.js"
import { createUpnpWatcher, type UpnpWatcher } from "./watch.js"

/** Events emitted by the UPnP plugin. */
export type UpnpEvents = {
    /** The router reported a new external (WAN) IPv4 address. */
    "external-ip": { ip: string }
    /** Subscribed to the gateway's WAN connection service. */
    subscribed: { sid: string; eventUrl: string; serviceType: string }
    /** UPnP is unavailable (no gateway found, or not on Linux). */
    unavailable: { reason: string }
    /** The gateway came back after being unreachable. */
    reconnected: { downSeconds: number; attempts: number }
}

/** Options for {@link upnpPlugin}. */
export interface UpnpOptions {
    /** TCP port the GENA NOTIFY callback server listens on. */
    port: number
    /** Maximum reconnect backoff, in seconds. */
    retrySeconds?: number
    /** Minimum reconnect backoff, in seconds. */
    minRetrySeconds?: number
}

/** The UPnP surface exposed to workflows as `ctx.plugins.upnp`. */
export interface UpnpApi {
    /** Subscribe to UPnP events (`external-ip`, `reconnected`, …). */
    events: ReadChannel<UpnpEvents>
    /** The last observed external IPv4, or `null`. */
    current: () => string | null
    /** Whether currently subscribed to the gateway. */
    subscribed: () => boolean
    /** The discovered gateway service, or `null`. */
    gateway: () => GatewayService | null
}

/**
 * Plugin that discovers the router's UPnP gateway and pushes external-IP changes
 * via GENA event subscriptions, with reconnect handling.
 * @param options the callback port and reconnect backoff
 */
export const upnpPlugin = (options: UpnpOptions) => {
    let watcher: UpnpWatcher | undefined

    return definePlugin<UpnpApi, UpnpEvents>({
        name: "upnp",
        init: async ctx => {
            watcher = createUpnpWatcher({
                port: options.port,
                retrySeconds: options.retrySeconds,
                minRetrySeconds: options.minRetrySeconds,
                hooks: {
                    onObserved: ip => {
                        ctx.channel.emit("external-ip", { ip })
                    },
                    onSubscribed: info => {
                        ctx.channel.emit("subscribed", info)
                    },
                    onUnavailable: reason => {
                        ctx.channel.emit("unavailable", { reason })
                    },
                    onReconnected: info => {
                        ctx.channel.emit("reconnected", info)
                    },
                    log: (message, level) => {
                        ctx.log(message, level)
                    },
                },
            })
            await watcher.listen()
            ctx.onStop(() => watcher?.stop() ?? Promise.resolve())

            return {
                events: ctx.channel,
                current: () => watcher?.current() ?? null,
                subscribed: () => watcher?.subscribed() ?? false,
                gateway: () => watcher?.gateway() ?? null,
            }
        },
        setup: async () => {
            await watcher?.connect()
        },
    })
}
