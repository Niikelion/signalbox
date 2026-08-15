---
"@signalbox/cloudflare": minor
"@signalbox/ovh": minor
---

Export `applyRecords`, the per-record update loop each provider plugin runs.

The plugin's `update(ip)` and the DDNS apps' one-shot `once` command had separate
copies of the same find/create/patch loop. Both now call `applyRecords`, which
reports each record's outcome through a callback so callers choose whether to emit
bus events or log directly.
