import { describe, expect, it, vi } from "vitest"
import {
    CompiledAuthority,
    PermissionError,
    createMemoryPermissionBackend,
    createPermissionRegistry,
    emptyPermissionRegistrySnapshot,
    entityRef,
    permissionClaim,
    type PermissionRegistrySnapshot,
} from "../src/index"

const root = entityRef("system", "root")
const alice = entityRef("user", "alice")
const bob = entityRef("user", "bob")
const book = entityRef("signal-book", "book-1")
const read = permissionClaim("signalbook.read", book)
const delegableRead = { claim: read, delegation: ["subject"] as const }

const setup = async () => {
    let timestamp = 100
    const backend = createMemoryPermissionBackend()
    const audit = vi.fn()
    const created = await createPermissionRegistry({ backend, audit, now: () => timestamp })
    return { ...created, backend, audit, setTime: (value: number) => (timestamp = value) }
}

describe("permission definitions", () => {
    it("defines identical metadata idempotently and rejects conflicting metadata", async () => {
        const { registry } = await setup()
        const input = { id: "signalbook.read", name: "Read signal books", actor: root }

        const first = await registry.define(input)
        const second = await registry.define(input)

        expect(second).toEqual(first)
        await expect(registry.define({ ...input, name: "Different" })).rejects.toMatchObject({
            code: "PERMISSION_ALREADY_DEFINED",
        })
    })

    it("rejects reuse of an operation ID with different input", async () => {
        const { registry } = await setup()
        await registry.define({ id: "signalbook.read", name: "Read", actor: root, operationId: "operation-1" })

        await expect(
            registry.define({ id: "signalbook.write", name: "Write", actor: root, operationId: "operation-1" }),
        ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" })
    })
})

describe("authority grants", () => {
    it("builds authority contributions and constrains child delegation", async () => {
        const { registry, bootstrap } = await setup()
        await registry.define({ id: "signalbook.read", name: "Read", actor: root })
        await bootstrap.grant({ id: "grant-alice", actor: root, subject: alice, claims: [delegableRead] })

        await registry.delegate({
            id: "grant-bob",
            actor: alice,
            subject: bob,
            claims: [{ claim: read, delegation: [] }],
            parentGrantId: "grant-alice",
            via: "subject",
        })
        expect(new CompiledAuthority(registry.contributionsFor(bob)).allows(read, 100)).toBe(true)

        await expect(
            registry.delegate({
                id: "grant-invalid",
                actor: bob,
                subject: alice,
                claims: [delegableRead],
                parentGrantId: "grant-bob",
                via: "subject",
            }),
        ).rejects.toMatchObject({ code: "DELEGATION_DENIED" })
    })

    it("invalidates existing parent and child authority snapshots synchronously", async () => {
        const { registry, bootstrap, setTime } = await setup()
        await registry.define({ id: "signalbook.read", name: "Read", actor: root })
        await bootstrap.grant({ id: "grant-alice", actor: root, subject: alice, claims: [delegableRead] })
        await registry.delegate({
            id: "grant-bob",
            actor: alice,
            subject: bob,
            claims: [{ claim: read, delegation: [] }],
            parentGrantId: "grant-alice",
            via: "subject",
        })
        const aliceAuthority = new CompiledAuthority(registry.contributionsFor(alice))
        const bobAuthority = new CompiledAuthority(registry.contributionsFor(bob))

        setTime(200)
        await registry.revoke({ id: "grant-alice", actor: root })

        expect(() => aliceAuthority.require(read, 200)).toThrow(expect.objectContaining({ code: "GRANT_REVOKED" }))
        expect(() => bobAuthority.require(read, 200)).toThrow(expect.objectContaining({ code: "GRANT_REVOKED" }))
    })

    it("retirement invalidates existing authority and prevents new grants", async () => {
        const { registry, bootstrap, setTime } = await setup()
        await registry.define({ id: "signalbook.read", name: "Read", actor: root })
        await bootstrap.grant({ id: "grant-alice", actor: root, subject: alice, claims: [delegableRead] })
        const authority = new CompiledAuthority(registry.contributionsFor(alice))

        setTime(200)
        await registry.retire({ id: "signalbook.read", actor: root })

        expect(authority.allows(read, 200)).toBe(false)
        await expect(
            bootstrap.grant({ id: "grant-bob", actor: root, subject: bob, claims: [delegableRead] }),
        ).rejects.toMatchObject({ code: "PERMISSION_RETIRED" })
    })

    it("preserves inherited-expiry state cells across unrelated mutations", async () => {
        const { registry, bootstrap, setTime } = await setup()
        await registry.define({ id: "signalbook.read", name: "Read", actor: root })
        await bootstrap.grant({
            id: "grant-alice",
            actor: root,
            subject: alice,
            claims: [delegableRead],
            expiresAt: 500,
        })
        await registry.delegate({
            id: "grant-bob",
            actor: alice,
            subject: bob,
            claims: [{ claim: read, delegation: [] }],
            parentGrantId: "grant-alice",
            via: "subject",
        })
        const authority = new CompiledAuthority(registry.contributionsFor(bob))
        await registry.define({ id: "signalbook.write", name: "Write", actor: root })

        setTime(200)
        await registry.retire({ id: "signalbook.read", actor: root })

        expect(authority.allows(read, 200)).toBe(false)
    })
})

describe("durable reconstruction", () => {
    it("rebuilds indexes and idempotency records from a backend snapshot", async () => {
        const first = await setup()
        await first.registry.define({
            id: "signalbook.read",
            name: "Read",
            actor: root,
            operationId: "define-read",
        })
        await first.bootstrap.grant({ id: "grant-alice", actor: root, subject: alice, claims: [delegableRead] })

        const restarted = await createPermissionRegistry({ backend: first.backend, now: () => 100 })

        expect(new CompiledAuthority(restarted.registry.contributionsFor(alice)).allows(read, 100)).toBe(true)
        await expect(
            restarted.registry.define({
                id: "signalbook.write",
                name: "Write",
                actor: root,
                operationId: "define-read",
            }),
        ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" })
    })

    it("fails startup closed when durable grant references are inconsistent", async () => {
        const inconsistent: PermissionRegistrySnapshot = {
            ...emptyPermissionRegistrySnapshot(),
            definitions: [{ id: "signalbook.read", name: "Read" }],
            grants: [
                {
                    id: "orphan",
                    subject: alice,
                    issuer: root,
                    claims: [delegableRead],
                    parentGrantId: "missing",
                    delegatedVia: "subject",
                },
            ],
        }

        await expect(createPermissionRegistry({ backend: createMemoryPermissionBackend(inconsistent) })).rejects.toEqual(
            expect.objectContaining<Partial<PermissionError>>({ code: "BACKEND_INCONSISTENT" }),
        )
    })
})
