import { createApp } from "@signalbox/core"
import {
    createMemoryPermissionBackend,
    createPermissionSystem,
    definePermission,
    entityRef,
    permissionClaim,
} from "@signalbox/permissions"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ovhDynHostRef, ovhDynHostUpdatePermission, ovhPlugin } from "../src/index"

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const fetchMock = vi.spyOn(globalThis, "fetch")

afterEach(() => fetchMock.mockReset())

describe("OVH permission integration", () => {
    it("propagates user authority, elevates through the workflow ceiling, and observes revocation", async () => {
        const audit = vi.fn()
        const host = entityRef("system", "ovh-test")
        const trigger = entityRef("manual-trigger", "update-now")
        const triggerPermission = definePermission({ id: "trigger.invoke", name: "Invoke manual triggers" })
        const updateClaim = permissionClaim(ovhDynHostUpdatePermission.id, ovhDynHostRef("home.example.com"))
        const triggerClaim = permissionClaim(triggerPermission.id, trigger)
        const system = await createPermissionSystem({
            backend: createMemoryPermissionBackend(),
            host,
            permissions: [ovhDynHostUpdatePermission, triggerPermission],
            hostGrantId: "ovh-host",
            hostClaims: [{ claim: updateClaim, delegation: [] }],
            audit,
        })
        const aliceRef = entityRef("user", "alice")
        await system.bootstrap.grant({
            id: "alice-trigger",
            actor: host,
            subject: aliceRef,
            claims: [{ claim: triggerClaim, delegation: [] }],
        })
        const alice = system.identities.issue({ principal: aliceRef })
        const plugins = {
            ovh: ovhPlugin({ username: "user", password: "secret", records: ["home.example.com"] }),
        }
        const app = createApp<{ update: { ip: string } }, typeof plugins>({
            name: "ovh-permissions",
            logging: false,
            permissions: system.app,
            plugins,
            manualTriggers: [
                {
                    id: "update-now",
                    event: "update",
                    schema: {
                        parse: input => {
                            if (typeof input !== "object" || input === null || !("ip" in input))
                                throw new Error("invalid")
                            return { ip: String(input.ip) }
                        },
                    },
                },
            ],
            workflows: [
                {
                    name: "update",
                    setup: ctx => {
                        ctx.app
                            .flow("update")
                            .elevate(() => updateClaim)
                            .effect(async ({ ip }) => ctx.plugins.ovh.update(ip))
                    },
                },
            ],
        })
        fetchMock.mockResolvedValue(new Response("good 203.0.113.8", { status: 200 }))
        await app.start()

        await app.manualTriggers.invoke("update-now", { ip: "203.0.113.8" }, { identity: alice, operation: "ui" })
        await flush()
        expect(fetchMock).toHaveBeenCalledTimes(1)

        await system.registry.revoke({ id: "ovh-host", actor: host })
        await app.manualTriggers.invoke("update-now", { ip: "203.0.113.9" }, { identity: alice, operation: "ui" })
        await flush()
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(audit.mock.calls.some(([event]) => event.type === "authorization" && event.decision === "deny")).toBe(
            true,
        )

        await system.registry.revoke({ id: "alice-trigger", actor: host })
        await expect(
            app.manualTriggers.invoke("update-now", { ip: "203.0.113.10" }, { identity: alice, operation: "ui" }),
        ).rejects.toMatchObject({ code: "GRANT_REVOKED" })
        await app.stop()
    })
})
