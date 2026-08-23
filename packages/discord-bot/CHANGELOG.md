# @signalbox/discord-bot

## 0.2.1

### Patch Changes

- Updated dependencies [669a2b7]
    - @signalbox/core@0.3.0

## 0.2.0

### Minor Changes

- 8af3f21: Add `@signalbox/discord-bot`, a Discord gateway bot plugin (discord.js).

    `discordBotPlugin({ token, guildId?, commands })` logs in, registers the given
    slash commands (to a guild for instant updates, or globally), and emits each
    invocation on its channel as a `command` event — `{ command, options, userId,
channelId, reply }` — so workflows subscribe with `events.flow("command")`. It also
    exposes `send(channelId, content)` and `dm(userId, content)`.

### Patch Changes

- Updated dependencies [fc7f053]
- Updated dependencies [a52570e]
- Updated dependencies [a7877e4]
- Updated dependencies [ad7aba3]
- Updated dependencies [41f64fd]
    - @signalbox/core@0.2.0
