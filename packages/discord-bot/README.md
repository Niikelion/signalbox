# @signalbox/discord-bot

signalbox plugin: a Discord gateway bot (slash commands, send, DM) via [discord.js](https://discord.js.org).

Part of [signalbox](https://github.com/Niikelion/signalbox) — see the [full documentation](https://github.com/Niikelion/signalbox/tree/master/docs).

## Install

```bash
npm install @signalbox/discord-bot
```

## Usage

```ts
import { discordBotPlugin } from "@signalbox/discord-bot"

const plugins = {
    bot: discordBotPlugin({
        token,
        guildId, // register commands to one guild (instant) vs globally (~1h)
        commands: [{ name: "ping", description: "check the bot is alive" }],
    }),
}

// in a workflow:
ctx.plugins.bot.events.flow("command").run(async cmd => {
    if (cmd.command === "ping") await cmd.reply("pong")
})

await ctx.plugins.bot.dm(userId, "hi there")
```

Registers the given slash commands on startup and emits a `command` event per invocation. `send(channelId, content)` and `dm(userId, content)` post messages. Build command payloads by hand or with `toApplicationCommand`.

## License

MIT
