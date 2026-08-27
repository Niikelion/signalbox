import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Secret } from "@signalbox/config"
import { ovhDynHostRef, ovhDynHostUpdatePermission } from "@signalbox/ovh"
import { permissionClaim } from "@signalbox/permissions"
import { createStorePermissionBackend } from "@signalbox/permissions-store"
import { createStore } from "@signalbox/store"
import { afterEach, describe, expect, it } from "vitest"
import { createDdnsOvhApp } from "./app"
import type { DdnsOvhConfig } from "./config"

const directories: string[] = []

afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe("DDNS OVH permission composition", () => {
    it("initializes durable hostname-scoped authority and reconstructs it idempotently", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ddns-ovh-permissions-"))
        directories.push(directory)
        const permissionsDb = join(directory, "permissions.db")
        const config: DdnsOvhConfig = {
            dynhostUser: "user",
            dynhostPassword: Secret.from("password"),
            records: ["home.example.com"],
            watchPort: 59_660,
            fallbackMinutes: 15,
            discordToken: Secret.from("discord-token"),
            timezone: "UTC",
            remindersDb: join(directory, "reminders.db"),
            permissionsDb,
        }

        const first = await createDdnsOvhApp(config)
        await first.stop()
        const second = await createDdnsOvhApp(config)
        await second.stop()

        const store = createStore(permissionsDb)
        const snapshot = await createStorePermissionBackend(store).snapshot()
        store.close()
        expect(snapshot.definitions).toContainEqual(ovhDynHostUpdatePermission)
        expect(snapshot.grants).toHaveLength(1)
        expect(snapshot.grants[0]?.claims).toContainEqual({
            claim: permissionClaim(ovhDynHostUpdatePermission.id, ovhDynHostRef("home.example.com")),
            delegation: ["owned-resource", "subject"],
        })
    })
})
