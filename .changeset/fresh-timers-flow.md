---
"@signalbox/core": minor
"@signalbox/graph": minor
"@signalbox/commons": minor
"@signalbox/cloudflare": patch
"@signalbox/ovh": patch
---

Redesign functional workflow composition around shared run-tracked Flow graphs.

The public Flow API now uses `effect` as the terminal operator, `fork` for joined child runs, `detach` for orphaned continuations, and `combine` for shared downstream suffixes. Graph workflows now compile to the same Flow operator model instead of using graph-specific `STOP` and `fanOut` control values.

Cloudflare and OVH graph nodes were updated to the new graph node-kind model.
