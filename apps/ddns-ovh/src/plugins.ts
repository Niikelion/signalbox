import type { PluginApis } from "@flowkit/core"
import { ovhPlugin } from "@flowkit/ovh"
import { upnpPlugin } from "@flowkit/upnp"
import type { DdnsOvhConfig } from "./config.js"

export const buildPlugins = (config: DdnsOvhConfig) => ({
    upnp: upnpPlugin({ port: config.watchPort }),
    ovh: ovhPlugin({
        username: config.dynhostUser,
        password: config.dynhostPassword,
        records: config.records,
    }),
})

export type DdnsOvhPlugins = PluginApis<ReturnType<typeof buildPlugins>>
