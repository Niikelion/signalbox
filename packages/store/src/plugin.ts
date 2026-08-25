import { definePlugin, type NoEvents } from "@signalbox/core"
import { createStore, type Store } from "./store"

/** Options for {@link storePlugin}. */
export interface StorePluginOptions {
    /** SQLite file path, or `":memory:"`. */
    path: string
}

/** The store surface a workflow reaches via `ctx.plugins.store`. */
export type StoreApi = Pick<Store, "collection">

/**
 * Plugin wrapping {@link createStore}: exposes typed collections to workflows and
 * closes the database when the app stops.
 * @param options where the SQLite file lives
 */
export const storePlugin = (options: StorePluginOptions) =>
    definePlugin<StoreApi, NoEvents>({
        name: "store",
        init: ctx => {
            const store = createStore(options.path)
            ctx.onStop(() => {
                store.close()
            })
            return { collection: store.collection }
        },
    })
