import { describe, expect, it, vi } from "vitest"
import {
    GrantStateCell,
    MembershipStateCell,
    PermissionError,
    createPermissionExecution,
    definePermissionSource,
    entityRef,
    permissionClaim,
    type AuthorizationAuditEvent,
    type IdentityGrant,
} from "../src/index"

const zoneClaim = (id: string) => permissionClaim("cloudflare.records.update", entityRef("zone", id))

const fixture = (audit?: (event: AuthorizationAuditEvent) => void) => {
    const execution = createPermissionExecution({ audit, now: () => 100 })
    const grant = new GrantStateCell({ id: "grant-1" })
    const identity = execution.identities.issue({
        principal: entityRef("user", "alice"),
        contributions: [{ claim: zoneClaim("example.com"), grant }],
    })
    return { ...execution, grant, identity }
}

describe("trusted identities", () => {
    it("derives the principal and authority from an opaque grant", () => {
        const { runtime, identity } = fixture()
        const authority = runtime.authorityFor(identity)

        expect(authority.principal).toEqual(entityRef("user", "alice"))
        expect(authority.allows(zoneClaim("example.com"), 100)).toBe(true)
    })

    it("rejects forged and foreign identity grants", () => {
        const first = fixture()
        const second = fixture()

        expect(() => first.runtime.authorityFor({} as IdentityGrant)).toThrow(
            expect.objectContaining({ code: "GRANT_INVALID" }),
        )
        expect(() => second.runtime.authorityFor(first.identity)).toThrow(
            expect.objectContaining({ code: "GRANT_INVALID" }),
        )
    })

    it("cannot serialize identity grants or active authority", () => {
        const { runtime, identity } = fixture()

        expect(() => JSON.stringify(identity)).toThrow(/cannot be serialized/u)
        expect(() => JSON.stringify(runtime.authorityFor(identity))).toThrow(/cannot be serialized/u)
    })
})

describe("protected execution", () => {
    it("authorizes before handler entry and emits a sanitized allow decision", async () => {
        const events: AuthorizationAuditEvent[] = []
        const { runtime, identity } = fixture(event => events.push(event))
        const handler = vi.fn(async (input: { zoneId: string; secret: string }) => input.zoneId)
        const update = runtime.protect(input => zoneClaim(input.zoneId), handler, { operation: "dns.update" })

        await expect(
            runtime.runAs(identity, { operation: "flow.effect", requestId: "request-1" }, () =>
                update({ zoneId: "example.com", secret: "not-for-audit" }),
            ),
        ).resolves.toBe("example.com")

        expect(handler).toHaveBeenCalledOnce()
        expect(events).toEqual([
            expect.objectContaining({
                decision: "allow",
                operation: "dns.update",
                requestId: "request-1",
                principal: entityRef("user", "alice"),
                contributingGrantIds: ["grant-1"],
            }),
        ])
        expect(JSON.stringify(events)).not.toContain("not-for-audit")
    })

    it("fails closed without an active execution lease", async () => {
        const { runtime } = fixture()
        const handler = vi.fn()
        const update = runtime.protect(() => zoneClaim("example.com"), handler)

        await expect(update(undefined)).rejects.toMatchObject({ code: "AUTHORITY_MISSING" })
        expect(handler).not.toHaveBeenCalled()
    })

    it("closes inherited async context after the callback settles", async () => {
        const { runtime, identity } = fixture()
        let releaseSelector: (() => void) | undefined
        const selectorGate = new Promise<void>(resolve => {
            releaseSelector = resolve
        })
        const handler = vi.fn()
        const update = runtime.protect(async () => {
            await selectorGate
            return zoneClaim("example.com")
        }, handler)
        let delayed: Promise<unknown> | undefined

        await runtime.runAs(identity, { operation: "flow.effect" }, () => {
            delayed = update(undefined)
        })
        releaseSelector?.()

        await expect(delayed).rejects.toMatchObject({ code: "AUTHORITY_MISSING" })
        expect(handler).not.toHaveBeenCalled()
    })

    it("observes grant revocation during an existing execution lease", async () => {
        const events: AuthorizationAuditEvent[] = []
        const { runtime, identity, grant } = fixture(event => events.push(event))
        const handler = vi.fn()
        const update = runtime.protect(() => zoneClaim("example.com"), handler)

        await runtime.runAs(identity, { operation: "dns.update" }, async () => {
            grant.revoke(99)
            await expect(update(undefined)).rejects.toMatchObject({ code: "GRANT_REVOKED" })
        })

        expect(handler).not.toHaveBeenCalled()
        expect(events.at(-1)).toMatchObject({ decision: "deny", code: "GRANT_REVOKED" })
    })

    it("observes membership removal during an existing execution lease", async () => {
        const execution = createPermissionExecution({ now: () => 100 })
        const membership = new MembershipStateCell({
            principal: entityRef("user", "alice"),
            group: entityRef("group", "operators"),
        })
        const identity = execution.identities.issue({
            principal: entityRef("user", "alice"),
            groups: [membership.group],
            contributions: [
                { claim: zoneClaim("example.com"), grant: new GrantStateCell({ id: "group-grant" }), membership },
            ],
        })
        const update = execution.runtime.protect(() => zoneClaim("example.com"), vi.fn())

        await execution.runtime.runAs(identity, { operation: "dns.update" }, async () => {
            membership.setActive(false)
            await expect(update(undefined)).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
        })
    })

    it("prevents handler entry when the audit sink fails", async () => {
        const auditFailure = new Error("audit unavailable")
        const { runtime, identity } = fixture(() => {
            throw auditFailure
        })
        const handler = vi.fn()
        const update = runtime.protect(() => zoneClaim("example.com"), handler)

        await expect(runtime.runAs(identity, { operation: "dns.update" }, () => update(undefined))).rejects.toBe(
            auditFailure,
        )
        expect(handler).not.toHaveBeenCalled()
    })
})

describe("permission-aware source policy", () => {
    it("exposes immutable subscription claims and trusted event identity", async () => {
        const { runtime, identity } = fixture()
        const policy = definePermissionSource<{ identity: IdentityGrant }>({
            entity: entityRef("http-route", "updates"),
            subscriptionClaims: [zoneClaim("example.com")],
            identity: input => input.identity,
        })
        const authority = runtime.authorityFor(identity)

        runtime.authorize(authority, policy.subscriptionClaims, { operation: "source.attach" })
        expect(runtime.authorityFor(await policy.eventIdentity({ identity })).principal).toEqual(
            entityRef("user", "alice"),
        )
        expect(Object.isFrozen(policy.subscriptionClaims)).toBe(true)
    })

    it("cannot turn a forged payload value into event authority", async () => {
        const { runtime } = fixture()
        const policy = definePermissionSource<{ identity: IdentityGrant }>({
            entity: entityRef("http-route", "updates"),
            subscriptionClaims: [],
            identity: input => input.identity,
        })
        const forged = await policy.eventIdentity({ identity: {} as IdentityGrant })

        expect(() => runtime.authorityFor(forged)).toThrow(expect.objectContaining({ code: "GRANT_INVALID" }))
    })
})
