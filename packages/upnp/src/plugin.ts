import { definePlugin } from "@signalbox/core"
import type { GatewayService } from "./discovery.js"
import { createUpnpWatcher, type UpnpWatcher } from "./watch.js"

export type UpnpEvents = {
    "wan-ip:observed": { ip: string; source: "upnp" | "http" | "startup" | "reconnect" }
    "upnp:subscribed": { sid: string; eventUrl: string; serviceType: string }
    "upnp:unavailable": { reason: string }
    "upnp:reconnected": { downSeconds: number; attempts: number }
}

export interface UpnpOptions {
    port: number
    retrySeconds?: number
    minRetrySeconds?: number
}

export interface UpnpApi {
    current: () => string | null
    subscribed: () => boolean
    gateway: () => GatewayService | null
}

export const upnpPlugin = (options: UpnpOptions) => {
    let watcher: UpnpWatcher | undefined

    return definePlugin<UpnpApi, UpnpEvents>({
        name: "upnp",
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
        setup: async () => {
            await watcher?.connect()
        },
    })
}
