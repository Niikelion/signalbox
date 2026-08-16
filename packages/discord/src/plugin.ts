import { definePlugin, FlowKitError, type NoEvents } from "@signalbox/core"

export interface DiscordMessage {
    content: string
    username?: string
    avatarUrl?: string
}

export interface DiscordOptions {
    /** A Discord channel webhook URL. */
    webhookUrl: string
    /** Default username override for messages that don't set one. */
    username?: string
    /** Retries on HTTP 429 rate limits (default 3). */
    maxRetries?: number
}

export interface DiscordApi {
    send: (message: DiscordMessage) => Promise<void>
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms).unref()
    })

export const discordPlugin = (options: DiscordOptions) =>
    definePlugin<DiscordApi, NoEvents>({
        name: "discord",
        init: () => ({
            send: async (message) => {
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

                    throw new FlowKitError(
                        `discord webhook failed: ${String(response.status)} ${await response.text()}`,
                    )
                }
            },
        }),
    })
