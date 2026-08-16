---
"@signalbox/schedule": minor
"@signalbox/store": minor
---

Add the scheduler and store modules that a reminders bot (and dynamic scheduling
in general) needs.

- `@signalbox/schedule` (new): `schedulePlugin()` exposes `at(date, fn)` for
  one-shot jobs, `cron(expr, { timezone }, fn)` for timezone-aware recurring jobs,
  and `next(expr, …)` to compute the next run. Built on Croner; all jobs are
  cancelled on stop.
- `@signalbox/store` (new): `createStore(path)` is a small persistent typed
  document store backed by the built-in `node:sqlite` (no native build).
  `store.collection<T>(name)` gives `insert`/`upsert`/`get`/`update`/`delete`/`all`
  over JSON documents keyed by `id`.
