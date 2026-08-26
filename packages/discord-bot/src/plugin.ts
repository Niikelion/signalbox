import { definePlugin, type ReadChannel } from "@signalbox/core"
import { Client, GatewayIntentBits, MessageFlags, REST, Routes } from "discord.js"
import { toApplicationCommand, type CommandSpec } from "./commands"

/** A slash-command invocation, emitted on the bot's channel as the `command` event. */
export interface CommandEvent {
    /** The command name (without the leading `/`). */
    command: string
    /** The supplied option values, keyed by option name. */
    options: Record<string, string | number | boolean>
    /** Discord user id of the invoker. */
    userId: string
    /** Channel id the command was used in. */
    channelId: string
    /**
     * Reply to the invocation (ephemeral).
     * @param content the reply text
     */
    reply: (content: string) => Promise<void>
}

/** The bot's event map. */
export type DiscordBotEvents = {
    /** Emitted whenever a registered slash command is invoked. */
    command: CommandEvent
}

/** Options for {@link discordBotPlugin}. */
export interface DiscordBotOptions {
    /** The Discord bot token. */
    token: string
    /** Register commands to this guild (instant) instead of globally (~1h propagation). */
    guildId?: string
    /** Slash commands to register on startup. */
    commands?: CommandSpec[]
}

/** The bot surface exposed to workflows as `ctx.plugins.<name>`. */
export interface DiscordBotApi {
    /** Subscribe to slash-command invocations via `events.flow("command")`. */
    events: ReadChannel<DiscordBotEvents>
    /**
     * Send a message to a channel.
     * @param channelId the target channel id
     * @param content the message text
     */
    send: (channelId: string, content: string) => Promise<void>
    /**
     * Direct-message a user.
     * @param userId the target user id
     * @param content the message text
     */
    dm: (userId: string, content: string) => Promise<void>
}

/**
 * Plugin running a Discord gateway bot (discord.js): registers slash commands, emits
 * each invocation on its channel, and can send channel messages or DMs.
 * @param options the bot token, optional target guild, and commands to register
 */
export const discordBotPlugin = (options: DiscordBotOptions) => {
    const client = new Client({ intents: [GatewayIntentBits.Guilds] })

    return definePlugin<DiscordBotApi, DiscordBotEvents>({
        name: "discord-bot",
        init: ctx => {
            client.on("interactionCreate", interaction => {
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
                    reply: async content => {
                        await interaction.reply({ content, flags: MessageFlags.Ephemeral })
                    },
                })
            })

            client.on("error", error => {
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
        setup: async ctx => {
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
