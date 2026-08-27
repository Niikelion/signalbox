import { describe, expect, it, vi } from "vitest"
import {
    createMemoryPermissionBackend,
    createPermissionSystem,
    definePermission,
    entityRef,
    permissionClaim,
} from "../src/index"

const host = entityRef("system", "test")
const record = entityRef("dns-record", "home.example.com")
const update = definePermission({ id: "dns.records.update", name: "Update DNS records" })

describe("permission system", () => {
    it("initializes declarations and host authority idempotently", async () => {
        const backend = createMemoryPermissionBackend()
        const options = {
            backend,
            host,
            permissions: [update],
            hostClaims: [{ claim: permissionClaim(update.id, record), delegation: ["owned-resource"] as const }],
        }

        const first = await createPermissionSystem(options)
        const second = await createPermissionSystem(options)

        expect(first.runtime.authorityFor(first.host).allows(permissionClaim(update.id, record))).toBe(true)
        expect(second.registry.snapshot()).toMatchObject({ definitions: [update] })
        expect(second.registry.snapshot().grants).toHaveLength(1)
    })

    it("issues user and group identities only from registry contributions", async () => {
        const system = await createPermissionSystem({ backend: createMemoryPermissionBackend(), host })
        await system.registry.define({ ...update, actor: host })
        const group = entityRef("group", "operators")
        await system.bootstrap.grant({
            id: "operators-update",
            actor: host,
            subject: group,
            claims: [{ claim: permissionClaim(update.id, record), delegation: [] }],
        })

        const alice = system.identities.issue({ principal: entityRef("user", "alice"), groups: [group] })
        const mallory = system.identities.issue({ principal: entityRef("user", "mallory") })

        expect(system.runtime.authorityFor(alice).allows(permissionClaim(update.id, record))).toBe(true)
        expect(system.runtime.authorityFor(mallory).allows(permissionClaim(update.id, record))).toBe(false)
    })

    it("replaces managed host authority when configured claims change", async () => {
        const backend = createMemoryPermissionBackend()
        const otherRecord = entityRef("dns-record", "other.example.com")
        await createPermissionSystem({
            backend,
            host,
            permissions: [update],
            hostClaims: [{ claim: permissionClaim(update.id, record), delegation: [] }],
        })
        const second = await createPermissionSystem({
            backend,
            host,
            permissions: [update],
            hostClaims: [{ claim: permissionClaim(update.id, otherRecord), delegation: [] }],
        })

        expect(second.runtime.authorityFor(second.host).allows(permissionClaim(update.id, record))).toBe(false)
        expect(second.runtime.authorityFor(second.host).allows(permissionClaim(update.id, otherRecord))).toBe(true)
        expect(second.registry.snapshot().grants.filter(grant => grant.revokedAt === undefined)).toHaveLength(1)
    })

    it("routes registry and authorization events through one audit sink", async () => {
        const audit = vi.fn()
        const system = await createPermissionSystem({
            backend: createMemoryPermissionBackend(),
            host,
            permissions: [update],
            hostClaims: [{ claim: permissionClaim(update.id, record), delegation: [] }],
            audit,
        })

        await system.runtime.runAs(system.host, { operation: "dns.update" }, () => {
            system.runtime.authorize(system.runtime.currentAuthority(), permissionClaim(update.id, record), {
                operation: "dns.update",
            })
        })

        expect(audit.mock.calls.map(([event]) => event.type)).toEqual([
            "permission-registry",
            "permission-registry",
            "authorization",
        ])
    })
})
