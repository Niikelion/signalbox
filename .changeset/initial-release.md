---
"@flowkit/cloudflare": minor
"@flowkit/core": minor
"@flowkit/upnp": minor
"@flowkit/ddns": minor
---

Initial release.

`@flowkit/core` provides the event-based framework: a typed event bus, plugins that
produce events, workflows that react to them, ordered teardown, and a schema-driven
config store.

`@flowkit/upnp` subscribes to the router's UPnP `ExternalIPAddress` event so address
changes arrive as a push instead of being polled for. `@flowkit/cloudflare` applies an
address to Cloudflare DNS A records, re-reading each record so out-of-band edits are
corrected.

`@flowkit/ddns` composes them into a dynamic DNS daemon with a CLI for config and
systemd lifecycle.
