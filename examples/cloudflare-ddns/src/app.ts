import { createApp, type App } from "@signalbox/core"
import { createPermissionExecution, entityRef } from "@signalbox/permissions"
import { APP_NAME, type CloudflareDdnsConfig } from "./config"
import { buildPlugins } from "./plugins"
import { ddnsPipeline } from "./workflows"

export const createDdnsApp = (config: CloudflareDdnsConfig): App => {
    const permissions = createPermissionExecution()
    return createApp({
        name: APP_NAME,
        permissions: {
            runtime: permissions.runtime,
            core: permissions.core,
            host: permissions.identities.issue({ principal: entityRef("system", APP_NAME) }),
        },
        plugins: buildPlugins(config),
        workflows: [ddnsPipeline(config)],
    })
}
