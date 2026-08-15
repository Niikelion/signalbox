import { defineWorkflow } from "../defineWorkflow.js"

export const updateDns = defineWorkflow("update-dns", (ctx) => {
    ctx.app.on("wan-ip:changed", async ({ current }) => {
        await ctx.plugins.ovh.update(current)
    })

    ctx.plugins.ovh.events.on("dns:updated", ({ record, current }) => {
        ctx.log(`${record} -> ${current}`)
    })

    ctx.plugins.ovh.events.on("dns:unchanged", ({ ip }) => {
        ctx.log(`records already point at ${ip}`)
    })
})
