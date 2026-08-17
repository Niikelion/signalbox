import { defineWorkflow } from "./defineWorkflow.js"

// VS Discord Relay POSTs a Discord webhook payload: { content, username }.
interface WebhookExecute {
    content: string
    username?: string
}

// strip every VS/HTML tag, then any leftover "[Role] Name:" prefix the mod forwards
const LEADING_PREFIX = /^\s*(?:\[[^\]]*]\s*)*[^:<>]+:\s*/
const clean = (content: string): string =>
    content
        .replace(/<[^>]+>/g, "")
        .replace(LEADING_PREFIX, "")
        .trim()

const parse = (body: unknown): WebhookExecute | null => {
    const b = body as Partial<WebhookExecute>
    return typeof b.content === "string" ? { content: b.content, username: b.username } : null
}

export const chatBridge = defineWorkflow("chat-bridge", (ctx) => {
    ctx.plugins.webhook.events
        .flow("vs-chat")
        .map((request) => parse(request.body))
        .filter((payload): payload is WebhookExecute => payload !== null)
        .map((payload) => ({ username: payload.username, content: clean(payload.content) }))
        .filter(({ content }) => content.length > 0)
        .run(({ content, username }) => ctx.plugins.discord.send({ content, username }))
})
