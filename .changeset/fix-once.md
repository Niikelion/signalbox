---
"@signalbox/ddns": patch
---

Fix `once` exiting before the update ran.

`once` started the reactive app and immediately stopped it, but the startup
update is fire-and-forget, so the process tore down before the Cloudflare write
completed — it silently did nothing. `once` is now a direct awaited pass
(`runOnce`) that fetches the public IP and updates each record, with no UPnP
subscription or bus, so it finishes before returning.
