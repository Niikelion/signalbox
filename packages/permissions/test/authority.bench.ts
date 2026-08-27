import { bench, describe } from "vitest"
import { CompiledAuthority, GrantStateCell, entityRef, permissionClaim } from "../src/index"

const contributions = Array.from({ length: 10_000 }, (_, index) => ({
    claim: permissionClaim("resource.items.read", entityRef("item", String(index))),
    grant: new GrantStateCell({ id: `grant-${String(index)}` }),
}))
const wildcard = new GrantStateCell({ id: "wildcard" })
const revoked = new GrantStateCell({ id: "revoked" })
revoked.revoke(1)

const authority = new CompiledAuthority([
    ...contributions,
    { claim: permissionClaim("resource.items.write", "*"), grant: wildcard },
    { claim: permissionClaim("resource.items.delete", entityRef("item", "5000")), grant: revoked },
])
const exact = permissionClaim("resource.items.read", entityRef("item", "5000"))
const broad = permissionClaim("resource.items.write", entityRef("item", "5000"))
const denied = permissionClaim("resource.items.delete", entityRef("item", "5000"))

describe("compiled authority with 10,000 grants", () => {
    bench("exact claim", () => authority.allows(exact))
    bench("wildcard fallback", () => authority.allows(broad))
    bench("revoked grant", () => authority.allows(denied))
    bench("multiple claims", () => {
        authority.require([exact, broad])
    })
})
