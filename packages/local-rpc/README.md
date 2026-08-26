# @signalbox/local-rpc

Typed local RPC over Linux Unix sockets, with caller identity supplied by the kernel rather than the request body.

```bash
npm install @signalbox/core @signalbox/local-rpc zod
```

## Server

Define method descriptors once so the server and client share their types:

```ts
import { createApp } from "@signalbox/core"
import { defineLocalRpcMethod, localRpcPlugin } from "@signalbox/local-rpc"
import { z } from "zod"

export const upsertRoute = defineLocalRpcMethod({
    method: "proxy.route.upsert",
    request: z.object({ id: z.string(), port: z.number().int().min(1).max(65535) }),
    response: z.object({ id: z.string() }),
})

const rpc = localRpcPlugin({
    socketPath: "/run/proxybox/proxybox.sock",
    owner: "proxybox",
    group: "proxy-users",
    mode: 0o660,
})

rpc.route(upsertRoute, async (input, ctx) => {
    // Authorization uses ctx.peer.uid/gid/pid, never a claimed identity in input.
    return { id: input.id }
})

await createApp({ name: "proxybox", plugins: { rpc }, workflows: [] }).run()
```

Routes may also be registered through `ctx.plugins.rpc.route(...)` during workflow setup. The server starts accepting only after every workflow has been wired.

## Client

```ts
import { createLocalRpcClient } from "@signalbox/local-rpc"
import { upsertRoute } from "./methods"

const client = createLocalRpcClient({ socketPath: "/run/proxybox/proxybox.sock" })
const result = await client.call(upsertRoute, { id: "app", port: 43127 }, {
    idempotencyKey: pulumiOperationId,
})
```

The idempotency key is transport metadata. Persisting and scoping it by caller UID is the application's responsibility.

## Security and lifecycle

- Linux only. Peer UID, GID, and PID come from `SO_PEERCRED`; supplementary groups are included when `SO_PEERGROUPS` is available. The socket-option numbers vary by CPU ABI: x86-64, ARM, ARM64, RISC-V, s390x, ppc64, and MIPS are supported, and any other architecture throws `UNSUPPORTED_PLATFORM` rather than risk reading the wrong option.
- Signalbox does not ship a native addon. Node handles Unix socket I/O and Koffi provides the maintained FFI binding for peer credential lookup.
- The parent socket directory must already exist. Use systemd `RuntimeDirectory` through `@signalbox/service-cli` in production.
- The plugin rejects symlinks and non-socket files at `socketPath`. It replaces a stale socket only when no server accepts connections there.
- Ownership and mode are applied before accepting begins. An unprivileged daemon can only select an owner/group it has permission to assign.
- Shutdown stops acceptance, rejects incomplete requests, drains dispatched handlers, and removes only the socket inode created by this plugin.
- The default maximum request size is 1 MiB and the default handler timeout is 30 seconds.

Unexpected handler failures become `INTERNAL_ERROR` without exposing stack traces. Throw `LocalRpcError` for stable application error codes.
