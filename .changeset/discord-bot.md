---
"@signalbox/discord-bot": minor
---

Add `@signalbox/discord-bot`, a Discord gateway bot plugin (discord.js).

`discordBotPlugin({ token, guildId?, commands })` logs in, registers the given
slash commands (to a guild for instant updates, or globally), and emits each
invocation on its channel as a `command` event — `{ command, options, userId,
channelId, reply }` — so workflows subscribe with `events.flow("command")`. It also
exposes `send(channelId, content)` and `dm(userId, content)`.
