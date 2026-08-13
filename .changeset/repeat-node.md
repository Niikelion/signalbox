---
"@flowkit/graph": minor
---

Add a `repeat` fan-out node, so a graph can act on a list.

`repeat` resolves `over` to a list and sends one flow down its edge per item,
merging each item into the value under `as`. This lets one WAN-IP observation
update several DNS records — `upnp.source → dedupe → repeat → cloudflare.update`
— without an internal bus: fan-out stays edge-routed, so the graph is still a
plain DAG. Backed by a `fanOut()` value wrapper the compiler expands.
