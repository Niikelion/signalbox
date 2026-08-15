import { defineWorkflow } from "../defineWorkflow.js"

export const updateDns = defineWorkflow("update-dns", (ctx) => {
    ctx.on("wan-ip:changed", async ({ current }) => {
        await ctx.plugins.cloudflare.update(current)
    })

    ctx.on("dns:updated", ({ record, previous, current }) => {
        ctx.log(`${record}: ${previous ?? "(created)"} -> ${current}`)
    })

    ctx.on("dns:unchanged", ({ ip }) => {
        ctx.log(`records already point at ${ip}`)
    })
})
