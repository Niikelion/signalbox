import { createApp, type App } from "@signalbox/core"
import { createPermissionExecution, entityRef } from "@signalbox/permissions"
import { APP_NAME, type DdnsOvhConfig } from "./config"
import { buildPlugins } from "./plugins"
import { reminders } from "./reminders"
import { ddnsOvhPipeline } from "./workflows"

export const createDdnsOvhApp = (config: DdnsOvhConfig): App => {
    const permissions = createPermissionExecution()
    return createApp({
        name: APP_NAME,
        permissions: {
            runtime: permissions.runtime,
            core: permissions.core,
            host: permissions.identities.issue({ principal: entityRef("system", APP_NAME) }),
        },
        plugins: buildPlugins(config),
        workflows: [ddnsOvhPipeline(config), reminders(config)],
    })
}
