# @signalbox/schedule

## 0.2.2

### Patch Changes

- Updated dependencies [c332137]
    - @signalbox/core@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [669a2b7]
    - @signalbox/core@0.3.0

## 0.2.0

### Minor Changes

- a596ee7: Add the scheduler and store modules that a reminders bot (and dynamic scheduling
  in general) needs.

    - `@signalbox/schedule` (new): `schedulePlugin()` exposes `at(date, fn)` for
      one-shot jobs, `cron(expr, { timezone }, fn)` for timezone-aware recurring jobs,
      and `next(expr, …)` to compute the next run. Built on Croner; all jobs are
      cancelled on stop.
    - `@signalbox/store` (new): `createStore(path)` is a small persistent typed
      document store backed by the built-in `node:sqlite` (no native build).
      `store.collection<T>(name)` gives `insert`/`upsert`/`get`/`update`/`delete`/`all`
      over JSON documents keyed by `id`.

### Patch Changes

- Updated dependencies [fc7f053]
- Updated dependencies [a52570e]
- Updated dependencies [a7877e4]
- Updated dependencies [ad7aba3]
- Updated dependencies [41f64fd]
    - @signalbox/core@0.2.0
