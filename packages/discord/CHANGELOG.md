# @signalbox/discord

## 0.2.0

### Minor Changes

- 6852cf1: Add `@signalbox/discord`, a plugin that sends messages to a Discord channel webhook.

    `discordPlugin({ webhookUrl, username? })` exposes `send({ content, username?, avatarUrl? })`
    which POSTs the Discord webhook execute payload, retrying on HTTP 429 with the
    `retry-after` delay and throwing on other errors. This is the outbound half of the
    VS-chat bridge.

### Patch Changes

- Updated dependencies [fc7f053]
- Updated dependencies [a52570e]
- Updated dependencies [a7877e4]
- Updated dependencies [ad7aba3]
- Updated dependencies [41f64fd]
    - @signalbox/core@0.2.0
