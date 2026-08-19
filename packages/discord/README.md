# @signalbox/discord

signalbox plugin: send messages to Discord via a channel webhook.

Part of [signalbox](https://github.com/Niikelion/signalbox) — see the [full documentation](https://github.com/Niikelion/signalbox/tree/master/docs).

## Install

```bash
npm install @signalbox/discord
```

## Usage

```ts
import { discordPlugin } from "@signalbox/discord"

const plugins = {
    discord: discordPlugin({
        webhookUrl, // a Discord channel webhook URL
        username: "my-bot", // optional default display name
    }),
}

// in a workflow:
await ctx.plugins.discord.send({ content: "deploy finished ✅" })
```

`send(message)` posts to the configured webhook, retrying on HTTP 429 rate limits (up to `maxRetries`, default 3) and throwing on other failures. A message may set its own `username` to override the default.

For a full gateway bot (slash commands, DMs) see [`@signalbox/discord-bot`](https://github.com/Niikelion/signalbox/tree/master/packages/discord-bot).

## License

MIT
