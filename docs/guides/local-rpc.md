# Local RPC

`@signalbox/local-rpc` exposes a typed, local-only API over a Linux Unix socket. It is intended for admin-owned daemons that authorize local callers using their real operating-system identity.

```ts
const inspect = defineLocalRpcMethod({
    method: "proxy.route.inspect",
    request: z.object({ id: z.string() }),
    response: z.object({ id: z.string(), active: z.boolean() }),
})

const rpc = localRpcPlugin({
    socketPath: "/run/proxybox/proxybox.sock",
    group: "proxy-users",
    mode: 0o660,
})

rpc.route(inspect, async (input, { peer }) => {
    return inspectOwnedRoute(peer.uid, input.id)
})
```

The socket's filesystem permissions decide who may connect. `peer.uid`, `peer.gid`, and `peer.pid` are captured from Linux `SO_PEERCRED`; the client cannot replace them with JSON values. Signalbox uses Node's Unix socket server and Koffi's maintained FFI bindings instead of shipping platform-specific binaries.

Method request and response schemas use Zod. Share descriptors with clients and call them through `createLocalRpcClient`. Calls may carry an idempotency key, but durable deduplication belongs to the application because only it knows the correct transaction and ownership boundary.

The protocol uses one length-prefixed JSON request and response per connection. It is intentionally not a network protocol and must not be exposed through a TCP bridge.

For production, configure `RuntimeDirectory` and the service account with [`@signalbox/service-cli`](deploying-with-service-cli.md). Systemd creates the parent directory; the plugin creates and manages only the socket file.
