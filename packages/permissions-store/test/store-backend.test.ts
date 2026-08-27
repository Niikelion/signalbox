import { createPermissionRegistry, entityRef, permissionClaim } from "@signalbox/permissions"
import { createStore } from "@signalbox/store"
import { describe, expect, it } from "vitest"
import { createStorePermissionBackend } from "../src/index"

const root = entityRef("system", "root")
const alice = entityRef("user", "alice")

describe("store permission backend", () => {
    it("atomically persists and reconstructs a registry snapshot", async () => {
        const store = createStore(":memory:")
        const firstBackend = createStorePermissionBackend(store)
        const first = await createPermissionRegistry({ backend: firstBackend, now: () => 100 })
        await first.registry.define({ id: "signalbook.read", name: "Read", actor: root })
        await first.bootstrap.grant({
            id: "grant-alice",
            actor: root,
            subject: alice,
            claims: [{ claim: permissionClaim("signalbook.read", "*"), delegation: [] }],
        })

        const restarted = await createPermissionRegistry({ backend: createStorePermissionBackend(store), now: () => 100 })

        expect(restarted.registry.definition("signalbook.read")?.name).toBe("Read")
        expect(restarted.registry.contributionsFor(alice)).toHaveLength(1)
        store.close()
    })

    it("does not publish a transaction whose callback throws", async () => {
        const store = createStore(":memory:")
        const backend = createStorePermissionBackend(store)

        await expect(
            backend.transaction(draft => {
                draft.definitions = [{ id: "signalbook.read", name: "Read" }]
                throw new Error("stop")
            }),
        ).rejects.toThrow("stop")

        expect((await backend.snapshot()).definitions).toEqual([])
        store.close()
    })
})
