import { registerNode, type MapNodeType } from "@signalbox/graph"
import { updateDynHost } from "./api"

export const ovhUpdateNode: MapNodeType = {
    type: "ovh.update",
    kind: "map",
    configSchema: {
        username: { type: "string", required: true },
        password: { type: "string", required: true },
        record: { type: "string", required: true },
        content: { type: "string", required: true },
    },
    create: () => ({
        run: async ({ config, input, ctx }) => {
            const credentials = {
                username: String(ctx.resolve(config["username"], input)),
                password: String(ctx.resolve(config["password"], input)),
            }
            const record = String(ctx.resolve(config["record"], input))
            const content = String(ctx.resolve(config["content"], input))

            const result = await updateDynHost(credentials, record, content)
            if (result.changed) ctx.log(`updated ${record} -> ${content}`)
            return { record, current: content, changed: result.changed }
        },
    }),
}

export const registerOvhNodes = (): void => {
    registerNode(ovhUpdateNode)
}

registerOvhNodes()
