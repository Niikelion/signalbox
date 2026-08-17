import { dedupe, poll, publicIPv4 } from "@signalbox/commons"
import { merge } from "@signalbox/core"
import type { DdnsCfConfig } from "./config.js"
import { defineWorkflow } from "./defineWorkflow.js"

type WanIpSource = "upnp" | "http" | "startup" | "reconnect"
interface Observation {
    ip: string
    source: WanIpSource
}

const phaseSource = { startup: "startup", interval: "http", retry: "reconnect" } as const

export const ddnsCfPipeline = (config: DdnsCfConfig) =>
    defineWorkflow("ddns", (ctx) => {
        const observed = ctx.plugins.upnp.events
            .flow("external-ip")
            .map(({ ip }): Observation => ({ ip, source: "upnp" }))

        const polled = poll({
            ctx,
            every: config.fallbackMinutes * 60 * 1000,
            probe: (log) =>
                publicIPv4((message) => {
                    log(message, "warn")
                }),
            retryOn: ctx.plugins.upnp.events.flow("reconnected"),
        }).map(({ value: ip, phase }): Observation => ({ ip, source: phaseSource[phase] }))

        merge<Observation>(observed, polled)
            .apply(dedupe((observation) => observation.ip))
            .run(async ({ ip, source }) => {
                ctx.log(`WAN IP changed to ${ip} (via ${source})`)
                await ctx.plugins.cloudflare.update(ip)
            })

        ctx.plugins.cloudflare.events.flow("dns:updated").run(({ record, previous, current }) => {
            ctx.log(`${record}: ${previous ?? "(created)"} -> ${current}`)
        })

        ctx.plugins.cloudflare.events.flow("dns:unchanged").run(({ ip }) => {
            ctx.log(`records already point at ${ip}`)
        })

        ctx.plugins.upnp.events.flow("unavailable").run(({ reason }) => {
            ctx.log(`UPnP unavailable: ${reason}`, "warn")
        })
    })
