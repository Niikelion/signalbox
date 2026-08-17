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

const toMessage = (body: unknown): WebhookExecute => {
    const b = body as Partial<WebhookExecute>
    return {
        username: typeof b.username === "string" ? b.username : undefined,
        content: typeof b.content === "string" ? clean(b.content) : "",
    }
}

export const chatBridge = defineWorkflow("chat-bridge", (ctx) => {
    ctx.plugins.webhook.events
        .flow("vs-chat")
        .map((request) => toMessage(request.body))
        .filter(({ content }) => content.length > 0)
        .run(({ content, username }) => ctx.plugins.discord.send({ content, username }))
})
