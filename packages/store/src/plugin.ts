import { definePlugin, type NoEvents } from "@signalbox/core"
import { createStore, type Store } from "./store.js"

export interface StorePluginOptions {
    path: string
}

export type StoreApi = Pick<Store, "collection">

export const storePlugin = (options: StorePluginOptions) =>
    definePlugin<StoreApi, NoEvents>({
        name: "store",
        init: (ctx) => {
            const store = createStore(options.path)
            ctx.onStop(() => {
                store.close()
            })
            return { collection: store.collection }
        },
    })
