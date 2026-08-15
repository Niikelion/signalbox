import { definePlugin, type ReadChannel } from "@signalbox/core"
import type { GatewayService } from "./discovery.js"
import { createUpnpWatcher, type UpnpWatcher } from "./watch.js"

export type UpnpEvents = {
    "external-ip": { ip: string }
    subscribed: { sid: string; eventUrl: string; serviceType: string }
    unavailable: { reason: string }
    reconnected: { downSeconds: number; attempts: number }
}

export interface UpnpOptions {
    port: number
    retrySeconds?: number
    minRetrySeconds?: number
}

export interface UpnpApi {
    events: ReadChannel<UpnpEvents>
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
                        ctx.channel.emit("external-ip", { ip })
                    },
                    onSubscribed: (info) => {
                        ctx.channel.emit("subscribed", info)
                    },
                    onUnavailable: (reason) => {
                        ctx.channel.emit("unavailable", { reason })
                    },
                    onReconnected: (info) => {
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
