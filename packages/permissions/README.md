# @signalbox/permissions

Framework-neutral authority primitives for Signalbox.

The package provides validated entity references and claims, a transactional definition and grant registry, constrained delegation, versioned grant and membership state, compiled exact/wildcard authorization indexes, opaque identity grants, workflow ceilings, branch-local authority transformations, asynchronous execution leases, protected actions, source policies, and sanitized auditing. It intentionally has no dependency on `@signalbox/core` or storage packages.

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

Use `createMemoryPermissionBackend` for ephemeral state. For durable state, install `@signalbox/permissions-store`. `createPermissionSystem` composes the registry, execution runtime, trusted registry-backed identities, host authority, and unified audit stream:

```ts
const permissions = await createPermissionSystem({
    backend: createStorePermissionBackend(store),
    host: entityRef("system", "my-app"),
    permissions: [updateDnsRecord],
    hostClaims: [{ claim: permissionClaim(updateDnsRecord.id, zone), delegation: [] }],
    audit: event => audit.write(event),
})

const app = createApp({
    name: "my-app",
    permissions: permissions.app,
    plugins,
    workflows,
})
```

Authentication integrations call `permissions.identities.issue({ principal, groups })`; callers cannot inject contributions. The issuer compiles direct and trusted group authority from the registry.
