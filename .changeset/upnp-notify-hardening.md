---
"@flowkit/upnp": patch
---

Harden the UPnP NOTIFY path so only genuine WAN address changes reach the DNS
updater, and so a router that drops offline and returns on a new address is
handled cleanly.

- Validate every ExternalIPAddress before emitting it. A router mid-reconnect
  advertises placeholders (`0.0.0.0`, empty, or its private LAN address) for a
  moment before the WAN link settles; these no longer propagate to a DNS update.
  Exposed as `isPublicIPv4`.
- Reject spoofed and stale callbacks. The NOTIFY server binds `0.0.0.0`, so it
  now accepts a notification only when its `SID` matches the live subscription,
  and drops any `SEQ` at or below the last one handled for that subscription.
- Fix a subscription/emit leak on shutdown. `stop()` during an in-flight
  `connect()` (discovery takes several seconds) could still subscribe and emit
  on a stopping bus; `connect()` now re-checks after each step and tears down a
  subscription it created past the stop.

`createNotifyServer` now takes an options object (`{ port, isCurrentSid,
onExternalIp, log }`) instead of positional args.
