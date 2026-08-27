# @signalbox/permissions

Framework-neutral authority primitives for Signalbox.

The package provides validated entity references and claims, a transactional definition and grant registry, constrained delegation, versioned grant and membership state, compiled exact/wildcard authorization indexes, opaque identity grants, asynchronous execution leases, protected actions, source policies, and sanitized auditing. It intentionally has no dependency on `@signalbox/core` or storage packages.

```ts
import { CompiledAuthority, GrantStateCell, entityRef, permissionClaim } from "@signalbox/permissions"

const zone = entityRef("cloudflare-zone", "example.com")
const grant = new GrantStateCell({ id: "grant-1" })
const authority = new CompiledAuthority([
    {
        claim: permissionClaim("cloudflare.records.update", zone),
        grant,
    },
])

authority.require(permissionClaim("cloudflare.records.update", zone))
```

Use `createMemoryPermissionBackend` for ephemeral state. For durable state, install `@signalbox/permissions-store` and pass its backend to `createPermissionRegistry`.
