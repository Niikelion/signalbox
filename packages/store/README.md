# @signalbox/store

A small persistent typed document store for signalbox, backed by `node:sqlite`.

Part of [signalbox](https://github.com/Niikelion/signalbox) — see the [full documentation](https://github.com/Niikelion/signalbox/tree/master/docs).

## Install

```bash
npm install @signalbox/store
```

Requires a Node version with the built-in `node:sqlite` module.

## Usage

```ts
import { storePlugin } from "@signalbox/store"

const plugins = {
    store: storePlugin({ path: "data.sqlite" }), // or ":memory:"
}

// in a workflow:
interface Todo {
    id: string
    title: string
    done: boolean
}
const todos = ctx.plugins.store.collection<Todo>("todos")
todos.upsert({ id: "1", title: "ship", done: false })
const one = todos.get("1")
```

`collection<T>(name)` returns a typed collection with `all`/`get`/`insert`/`upsert`/`update`/`delete`. The database is closed automatically when the app stops. Use `createStore(path)` directly if you want a store outside the plugin lifecycle.

## License

MIT
