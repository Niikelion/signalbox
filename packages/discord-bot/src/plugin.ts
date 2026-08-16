import { definePlugin, type ReadChannel } from "@signalbox/core"
import { Client, GatewayIntentBits, MessageFlags, REST, Routes } from "discord.js"
import { toApplicationCommand, type CommandSpec } from "./commands.js"

export interface CommandEvent {
    command: string
    options: Record<string, string | number | boolean>
    userId: string
    channelId: string
    reply: (content: string) => Promise<void>
}

export type DiscordBotEvents = {
    command: CommandEvent
}

export interface DiscordBotOptions {
    token: string
    guildId?: string
    commands?: CommandSpec[]
}

export interface DiscordBotApi {
    events: ReadChannel<DiscordBotEvents>
    send: (channelId: string, content: string) => Promise<void>
    dm: (userId: string, content: string) => Promise<void>
}

export const discordBotPlugin = (options: DiscordBotOptions) => {
    const client = new Client({ intents: [GatewayIntentBits.Guilds] })

    return definePlugin<DiscordBotApi, DiscordBotEvents>({
        name: "discord-bot",
        init: (ctx) => {
            client.on("interactionCreate", (interaction) => {
                if (!interaction.isChatInputCommand()) return

                const values: Record<string, string | number | boolean> = {}
                for (const option of interaction.options.data) {
                    if (option.value !== undefined) values[option.name] = option.value
                }

                ctx.channel.emit("command", {
                    command: interaction.commandName,
                    options: values,
                    userId: interaction.user.id,
                    channelId: interaction.channelId,
                    reply: async (content) => {
                        await interaction.reply({ content, flags: MessageFlags.Ephemeral })
                    },
                })
            })

            client.on("error", (error) => {
                ctx.fail(error)
            })

            const send: DiscordBotApi["send"] = async (channelId, content) => {
                const channel = await client.channels.fetch(channelId)
                if (channel?.isSendable()) await channel.send(content)
            }

            const dm: DiscordBotApi["dm"] = async (userId, content) => {
                const user = await client.users.fetch(userId)
                await user.send(content)
            }

            ctx.onStop(() => client.destroy())

            return { events: ctx.channel, send, dm }
        },
        setup: async (ctx) => {
            await client.login(options.token)

            const appId = client.application?.id
            if (options.commands && options.commands.length > 0 && appId !== undefined) {
                const rest = new REST().setToken(options.token)
                const body = options.commands.map(toApplicationCommand)
                await rest.put(
                    options.guildId !== undefined
                        ? Routes.applicationGuildCommands(appId, options.guildId)
                        : Routes.applicationCommands(appId),
                    { body },
                )
            }

            ctx.log(`logged in as ${client.user?.tag ?? "bot"}`)
        },
    })
}
