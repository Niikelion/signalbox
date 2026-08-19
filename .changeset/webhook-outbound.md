---
"@signalbox/webhook": minor
---

Add outbound webhook targets. Declare named `targets` (url, method, headers, secret) alongside inbound `routes`, and fire requests at them from workflows with `send(target, body?, options?)`. `send` resolves with `{ status, ok, headers, body }`; object bodies are JSON-encoded, non-2xx statuses don't throw. `http` is now optional — outbound-only plugins don't need a server.
