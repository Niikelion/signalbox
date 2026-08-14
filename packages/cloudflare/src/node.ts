import { registerNode, type ActionNodeType } from "@signalbox/graph"
import { createARecord, findARecord, patchARecord } from "./api.js"

/**
 * Point one Cloudflare A record at an address. Credentials and the record are
 * templates, so a graph reads them from its config and secrets:
 *
 * ```json
 * { "type": "cloudflare.update", "config": {
 *   "apiToken": "{{ $secret.cfToken }}",
 *   "zoneId":   "{{ $config.zoneId }}",
 *   "record":   "{{ $config.record }}",
 *   "content":  "{{ ip }}"
 * } }
 * ```
 *
 * Idempotent: it re-reads the record and only writes on a real difference, so a
 * repeated address costs one GET. Outputs `{ record, previous, current, changed }`.
 */
export const cloudflareUpdateNode: ActionNodeType = {
    type: "cloudflare.update",
    kind: "action",
    configSchema: {
        apiToken: { type: "string", required: true },
        zoneId: { type: "string", required: true },
        record: { type: "string", required: true },
        content: { type: "string", required: true },
        ttl: { type: "number" },
        proxied: { type: "boolean" },
    },
    create: () => ({
        run: async ({ config, input, ctx }) => {
            const credentials = {
                apiToken: String(ctx.resolve(config["apiToken"], input)),
                zoneId: String(ctx.resolve(config["zoneId"], input)),
            }
            const name = String(ctx.resolve(config["record"], input))
            const content = String(ctx.resolve(config["content"], input))
            const ttl = typeof config["ttl"] === "number" ? config["ttl"] : 60
            const proxied = config["proxied"] === true

            const existing = await findARecord(credentials, name)

            if (!existing) {
                await createARecord(credentials, { name, content, ttl, proxied })
                ctx.log(`created ${name} -> ${content}`)
                return { record: name, previous: null, current: content, changed: true }
            }

            if (existing.content === content) {
                return { record: name, previous: content, current: content, changed: false }
            }

            await patchARecord(credentials, existing.id, {
                name,
                content,
                ttl: existing.ttl,
                proxied: existing.proxied,
            })
            ctx.log(`updated ${name}: ${existing.content} -> ${content}`)
            return { record: name, previous: existing.content, current: content, changed: true }
        },
    }),
}

/** Register the Cloudflare nodes into the default graph registry. Called on import. */
export const registerCloudflareNodes = (): void => {
    registerNode(cloudflareUpdateNode)
}

registerCloudflareNodes()
