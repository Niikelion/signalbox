---
"@signalbox/store": minor
---

Add `storePlugin({ path })`, a plugin wrapper around `createStore` that exposes the
store's `collection` to workflows via `ctx.plugins.store` and closes the database on
stop.
