import { createApp, type App } from "@signalbox/core"
import { ovhDynHostRef, ovhDynHostUpdatePermission } from "@signalbox/ovh"
import { createPermissionSystem, entityRef, permissionClaim } from "@signalbox/permissions"
import { createStorePermissionBackend } from "@signalbox/permissions-store"
import { createStore } from "@signalbox/store"
import { APP_NAME, type DdnsOvhConfig } from "./config"
import { buildPlugins } from "./plugins"
import { reminders } from "./reminders"
import { ddnsOvhPipeline } from "./workflows"

export const createDdnsOvhApp = async (config: DdnsOvhConfig): Promise<App> => {
    const permissionStore = createStore(config.permissionsDb)
    const host = entityRef("system", APP_NAME)
    const permissions = await createPermissionSystem({
        backend: createStorePermissionBackend(permissionStore),
        host,
        permissions: [ovhDynHostUpdatePermission],
        hostClaims: config.records.map(record => ({
            claim: permissionClaim(ovhDynHostUpdatePermission.id, ovhDynHostRef(record)),
            delegation: ["owned-resource", "subject"],
        })),
    })
    const app = createApp({
        name: APP_NAME,
        permissions: permissions.app,
        plugins: buildPlugins(config),
        workflows: [ddnsOvhPipeline(config), reminders(config)],
    })
    let storeOpen = true
    const closeStore = (): void => {
        if (!storeOpen) return
        storeOpen = false
        permissionStore.close()
    }
    return {
        ...app,
        stop: async reason => {
            try {
                await app.stop(reason)
            } finally {
                closeStore()
            }
        },
        run: async () => {
            try {
                await app.run()
            } finally {
                closeStore()
            }
        },
    }
}
