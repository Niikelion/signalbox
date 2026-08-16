---
"@signalbox/discord": minor
---

Add `@signalbox/discord`, a plugin that sends messages to a Discord channel webhook.

`discordPlugin({ webhookUrl, username? })` exposes `send({ content, username?, avatarUrl? })`
which POSTs the Discord webhook execute payload, retrying on HTTP 429 with the
`retry-after` delay and throwing on other errors. This is the outbound half of the
VS-chat bridge.
