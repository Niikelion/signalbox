import { definePlugin, SignalboxError, type NoEvents } from "@signalbox/core"

/** A message to post to Discord. */
export interface DiscordMessage {
    /** The message text. */
    content: string
    /** Override the webhook's display name for this message. */
    username?: string
    /** Override the webhook's avatar for this message. */
    avatarUrl?: string
}

/** Options for {@link discordPlugin}. */
export interface DiscordOptions {
    /** A Discord channel webhook URL to post to. */
    webhookUrl: string
    /** Default display name for messages that don't set their own `username`. */
    username?: string
    /** How many times to retry on an HTTP 429 rate limit. Defaults to 3. */
    maxRetries?: number
}

/** The Discord sender exposed to workflows as `ctx.plugins.discord`. */
export interface DiscordApi {
    /**
     * Post a message to the configured webhook. Retries on 429, throws on other failures.
     * @param message the message to send
     */
    send: (message: DiscordMessage) => Promise<void>
}

const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => {
        setTimeout(resolve, ms).unref()
    })

/**
 * Plugin that sends messages to a Discord channel webhook.
 * @param options the webhook URL and defaults
 */
export const discordPlugin = (options: DiscordOptions) =>
    definePlugin<DiscordApi, NoEvents>({
        name: "discord",
        init: () => ({
            send: async message => {
                const body = JSON.stringify({
                    content: message.content,
                    username: message.username ?? options.username,
                    avatar_url: message.avatarUrl,
                })
                const retries = options.maxRetries ?? 3

                for (let attempt = 0; attempt <= retries; attempt++) {
                    const response = await fetch(options.webhookUrl, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body,
                    })
                    if (response.ok) return

                    if (response.status === 429 && attempt < retries) {
                        const retryAfter = Number(response.headers.get("retry-after") ?? "1")
                        await sleep((Number.isFinite(retryAfter) ? retryAfter : 1) * 1000)
                        continue
                    }

                    throw new SignalboxError(
                        `discord webhook failed: ${String(response.status)} ${await response.text()}`,
                    )
                }
            },
        }),
    })
