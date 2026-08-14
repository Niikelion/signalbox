---
"@signalbox/graph": minor
---

Add `@signalbox/graph`: workflows expressed as data.

A node registry (`registerNode` / `createNodeRegistry`) and a compiler
(`compileGraph`) that turns a JSON graph of registered nodes into an ordinary
`WorkflowDefinition`. The compiled workflow makes the same bus calls a
hand-written one would, so it runs on the existing runtime unchanged; the trade
is that a graph is validated when it loads rather than by the type checker.

Ships four built-in nodes — `event.on`, `plugin.call`, `event.emit`, `log` —
and a `{{ field }}` data-mapping resolver.
