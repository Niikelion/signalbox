import type { PluginApis } from "@signalbox/core"
import { discordBotPlugin } from "@signalbox/discord-bot"
import { ovhPlugin } from "@signalbox/ovh"
import { schedulePlugin } from "@signalbox/schedule"
import { storePlugin } from "@signalbox/store"
import { upnpPlugin } from "@signalbox/upnp"
import type { DdnsOvhConfig } from "./config.js"
import { REMIND_COMMAND } from "./remind.js"

export const buildPlugins = (config: DdnsOvhConfig) => ({
    upnp: upnpPlugin({ port: config.watchPort }),
    ovh: ovhPlugin({
        username: config.dynhostUser,
        password: config.dynhostPassword,
        records: config.records,
    }),
    schedule: schedulePlugin(),
    store: storePlugin({ path: config.remindersDb }),
    discordBot: discordBotPlugin({
        token: config.discordToken,
        guildId: config.discordGuildId,
        commands: [REMIND_COMMAND],
    }),
})

export type DdnsOvhPlugins = PluginApis<ReturnType<typeof buildPlugins>>
