import { registerNode, type ActionNodeType } from "@flowkit/graph"
import { updateDynHost } from "./api.js"

/**
 * Point one OVH DynHost record at an address. Credentials and the record are
 * templates, so a graph reads them from its config and secrets:
 *
 * ```json
 * { "type": "ovh.update", "config": {
 *   "username": "{{ $secret.ovhUser }}",
 *   "password": "{{ $secret.ovhPassword }}",
 *   "record":   "{{ $config.record }}",
 *   "content":  "{{ ip }}"
 * } }
 * ```
 *
 * DynHost reports whether the address moved, so this passes that straight through
 * as `changed`. Outputs `{ record, current, changed }`.
 */
export const ovhUpdateNode: ActionNodeType = {
    type: "ovh.update",
    kind: "action",
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

/** Register the OVH nodes into the default graph registry. Called on import. */
export const registerOvhNodes = (): void => {
    registerNode(ovhUpdateNode)
}

registerOvhNodes()
