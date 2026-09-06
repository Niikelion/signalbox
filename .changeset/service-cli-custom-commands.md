---
"@signalbox/service-cli": minor
---

Replace the hand-rolled argument parser with commander and let apps register custom commands.

`ServiceApp` gains a `commands` map of app-supplied subcommands (`{ summary, run }`), each handler receiving `{ config, store, args }`. Command names that collide with a built-in are rejected, and custom commands appear in `--help`.

BREAKING: the built-in `once` command and the `ServiceApp.runOnce` hook are removed — express a one-shot as a custom command instead. The whole CLI (including the `config` subcommands) now runs on commander, so `commander` is a new runtime dependency.
