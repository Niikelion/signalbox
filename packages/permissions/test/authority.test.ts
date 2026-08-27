import { describe, expect, it } from "vitest"
import {
    CompiledAuthority,
    GrantStateCell,
    MembershipStateCell,
    PermissionError,
    entityKey,
    entityRef,
    permissionClaim,
} from "../src/index"

const update = (id: string) => permissionClaim("cloudflare.records.update", entityRef("zone", id))

describe("permission model", () => {
    it("builds collision-safe structural entity keys", () => {
        expect(entityKey(entityRef("a:b", "c"))).not.toBe(entityKey(entityRef("a", "b:c")))
    })

    it("rejects invalid entities and permission identifiers", () => {
        expect(() => entityRef("user", "")).toThrow(PermissionError)
        expect(() => permissionClaim("update", "*")).toThrow(/namespaced/u)
    })
})

describe("compiled authority", () => {
    it("matches exact scopes without matching another entity", () => {
        const authority = new CompiledAuthority([{ claim: update("one"), grant: new GrantStateCell({ id: "g1" }) }])

        expect(authority.allows(update("one"))).toBe(true)
        expect(authority.allows(update("two"))).toBe(false)
    })

    it("uses wildcard grants as fallback but requires wildcard for wildcard requests", () => {
        const wildcard = permissionClaim("cloudflare.records.update", "*")
        const exact = update("one")
        const broad = new CompiledAuthority([{ claim: wildcard, grant: new GrantStateCell({ id: "broad" }) }])
        const narrow = new CompiledAuthority([{ claim: exact, grant: new GrantStateCell({ id: "narrow" }) }])

        expect(broad.allows(update("anything"))).toBe(true)
        expect(broad.allows(wildcard)).toBe(true)
        expect(narrow.allows(wildcard)).toBe(false)
    })

    it("requires every requested claim and reports stable denial codes", () => {
        const authority = new CompiledAuthority([{ claim: update("one"), grant: new GrantStateCell({ id: "g1" }) }])

        expect(() => authority.require([update("one"), update("two")])).toThrow(
            expect.objectContaining({ code: "PERMISSION_DENIED" }),
        )
    })

    it("returns current contributing grant IDs for audit provenance", () => {
        const first = new GrantStateCell({ id: "first" })
        const second = new GrantStateCell({ id: "second" })
        const authority = new CompiledAuthority([
            { claim: update("one"), grant: first },
            { claim: permissionClaim("cloudflare.records.update", "*"), grant: second },
        ])

        expect(authority.matchingGrantIds(update("one"))).toEqual(["second", "first"])
        first.revoke(10)
        expect(authority.matchingGrantIds(update("one"), 11)).toEqual(["second"])
    })
})

describe("versioned invalidation", () => {
    it("observes revocation without rebuilding compiled authority", () => {
        const grant = new GrantStateCell({ id: "grant" })
        const authority = new CompiledAuthority([{ claim: update("one"), grant }])

        expect(authority.allows(update("one"), 10)).toBe(true)
        grant.revoke(11)
        expect(grant.version).toBe(1)
        expect(authority.allows(update("one"), 12)).toBe(false)
    })

    it("recursively revokes descendants and preserves idempotency", () => {
        const root = new GrantStateCell({ id: "root" })
        const child = new GrantStateCell({ id: "child", parent: root })
        const grandchild = new GrantStateCell({ id: "grandchild", parent: child })

        root.revoke(20)
        root.revoke(21)

        expect([root.revokedAt, child.revokedAt, grandchild.revokedAt]).toEqual([20, 20, 20])
        expect([root.version, child.version, grandchild.version]).toEqual([1, 1, 1])
    })

    it("bounds child expiration by its parent", () => {
        const parent = new GrantStateCell({ id: "parent", expiresAt: 100 })
        const child = new GrantStateCell({ id: "child", parent, expiresAt: 200 })
        const authority = new CompiledAuthority([{ claim: update("one"), grant: child }])

        expect(child.expiresAt).toBe(100)
        expect(authority.allows(update("one"), 99)).toBe(true)
        expect(authority.allows(update("one"), 100)).toBe(false)
        expect(() => authority.require(update("one"), 100)).toThrow(expect.objectContaining({ code: "GRANT_EXPIRED" }))
    })

    it("invalidates and restores group authority through shared membership state", () => {
        const membership = new MembershipStateCell({
            principal: entityRef("user", "alice"),
            group: entityRef("group", "operators"),
        })
        const authority = new CompiledAuthority([
            { claim: update("one"), grant: new GrantStateCell({ id: "group-grant" }), membership },
        ])

        expect(authority.allows(update("one"))).toBe(true)
        membership.setActive(false)
        expect(authority.allows(update("one"))).toBe(false)
        membership.setActive(true)
        expect(authority.allows(update("one"))).toBe(true)
        expect(membership.version).toBe(2)
    })

    it("does not disturb authority when an unrelated state cell changes", () => {
        const relevant = new GrantStateCell({ id: "relevant" })
        const unrelated = new GrantStateCell({ id: "unrelated" })
        const authority = new CompiledAuthority([{ claim: update("one"), grant: relevant }])

        unrelated.revoke(10)

        expect(authority.allows(update("one"), 11)).toBe(true)
        expect(relevant.version).toBe(0)
    })
})
