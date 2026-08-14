import type { PluginApis } from "@signalbox/core"
import { ovhPlugin } from "@signalbox/ovh"
import { upnpPlugin } from "@signalbox/upnp"
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
