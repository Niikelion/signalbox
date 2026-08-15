---
"@signalbox/commons": minor
---

Add `@signalbox/commons`, reusable workflow building blocks on top of core.

- `createPoll` (new): a polling workflow — probe on an interval and at startup,
  emit the result as an event, and re-probe with backoff on a trigger event.
- `createDedupe` (new): a workflow that forwards an event only when a selected
  key changes, mapping the input payload to the output event.
- `publicIPv4` / `isIPv4` (new): resolve the host's public IPv4 over HTTP,
  racing several sources.

Both are curried over the app's event and plugin maps, mirroring
`createWorkflowDefiner`. The DDNS apps now build their WAN-IP tracking and
fallback poll from these instead of hand-rolled copies.
