import { defineWorkflow } from "@/defineWorkflow"

export const updateDns = defineWorkflow("update-dns", (ctx) => {
    ctx.on("wan-ip:changed", async ({ current }) => {
        await ctx.plugins.ovh.update(current)
    })

    ctx.on("dns:updated", ({ record, current }) => {
        ctx.log(`${record} -> ${current}`)
    })

    ctx.on("dns:unchanged", ({ ip }) => {
        ctx.log(`records already point at ${ip}`)
    })
})
