import { dedupeBy, poll, publicIPv4 } from "@signalbox/commons"
import { combine } from "@signalbox/core"
import type { CloudflareDdnsConfig } from "./config.js"
import { defineWorkflow } from "./defineWorkflow.js"

type WanIpSource = "upnp" | "http" | "startup" | "reconnect"
interface Observation {
    ip: string
    source: WanIpSource
}

const phaseSource = { startup: "startup", interval: "http", retry: "reconnect" } as const

export const ddnsPipeline = (config: CloudflareDdnsConfig) =>
    defineWorkflow("ddns", ctx => {
        const observed = ctx.plugins.upnp.events
            .flow("external-ip")
            .map(({ ip }): Observation => ({ ip, source: "upnp" }))

        const polled = poll({
            ctx,
            every: config.fallbackMinutes * 60 * 1000,
            probe: log =>
                publicIPv4(message => {
                    log(message, "warn")
                }),
            retryOn: ctx.plugins.upnp.events.flow("reconnected"),
        }).map(({ value: ip, phase }): Observation => ({ ip, source: phaseSource[phase] }))

        combine<Observation>(observed, polled)
            .filter(dedupeBy(observation => observation.ip))
            .effect(async ({ ip, source }) => {
                ctx.log(`WAN IP changed to ${ip} (via ${source})`)
                await ctx.plugins.cloudflare.update(ip)
            })

        ctx.plugins.cloudflare.events.flow("dns:updated").effect(({ record, previous, current }) => {
            ctx.log(`${record}: ${previous ?? "(created)"} -> ${current}`)
        })

        ctx.plugins.cloudflare.events.flow("dns:unchanged").effect(({ ip }) => {
            ctx.log(`records already point at ${ip}`)
        })

        ctx.plugins.upnp.events.flow("unavailable").effect(({ reason }) => {
            ctx.log(`UPnP unavailable: ${reason}`, "warn")
        })
    })
