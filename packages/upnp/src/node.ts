import { registerNode, type TriggerNodeType } from "@signalbox/graph"
import { createUpnpWatcher } from "./watch.js"

/**
 * A trigger node that makes the router the source of a graph. It pushes
 * `{ ip, source: "upnp" }` on every NOTIFY, so downstream nodes reference the
 * address as `{{ ip }}`. Same watch loop as the plugin, configured by the graph.
 */
export const upnpSourceNode: TriggerNodeType = {
    type: "upnp.source",
    kind: "trigger",
    configSchema: {
        port: { type: "number" },
        retrySeconds: { type: "number" },
        minRetrySeconds: { type: "number" },
    },
    create: () => ({
        start: ({ config, ctx, push }) => {
            const port = typeof config["port"] === "number" ? config["port"] : 5959
            const retrySeconds = typeof config["retrySeconds"] === "number" ? config["retrySeconds"] : undefined
            const minRetrySeconds =
                typeof config["minRetrySeconds"] === "number" ? config["minRetrySeconds"] : undefined

            const watcher = createUpnpWatcher({
                port,
                retrySeconds,
                minRetrySeconds,
                hooks: {
                    onObserved: (ip) => {
                        push({ ip, source: "upnp" })
                    },
                    onSubscribed: (info) => {
                        ctx.log(`subscribed to ${info.serviceType}`)
                    },
                    onUnavailable: (reason) => {
                        ctx.log(`UPnP unavailable: ${reason}`, "warn")
                    },
                    onReconnected: ({ downSeconds }) => {
                        ctx.log(`router reachable again after ${String(downSeconds)}s`)
                    },
                    log: (message, level) => {
                        ctx.log(message, level)
                    },
                },
            })

            ctx.onStop(() => watcher.stop())
            void (async () => {
                try {
                    await watcher.listen()
                    await watcher.connect()
                } catch (error) {
                    ctx.fail(error)
                }
            })()
        },
    }),
}

/** Register the UPnP nodes into the default graph registry. Called on import. */
export const registerUpnpNodes = (): void => {
    registerNode(upnpSourceNode)
}

registerUpnpNodes()
