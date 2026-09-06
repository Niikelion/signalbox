---
"@signalbox/service-cli": minor
---

Replace the hand-rolled argument parser with commander and let apps register custom commands.

`ServiceApp` gains a `commands` map of app-supplied subcommands (`{ summary, run }`), each handler receiving `{ config, store, args }`. Command names that collide with a built-in are rejected, and custom commands appear in `--help`.

Rebuild the interactive prompts on `@clack/prompts` with `picocolors`, replacing the hand-rolled raw-keypress terminal code. `config init` and `config interactive` now show a styled intro/outro, a proper highlighted select list, and native masked/confirm prompts. This also fixes two bugs in the old implementation: the interactive editor no longer hangs after Save/Discard, and the field picker renders the whole list instead of a single swapping row.

BREAKING: the built-in `once` command and the `ServiceApp.runOnce` hook are removed — express a one-shot as a custom command instead. The whole CLI (including the `config` subcommands) now runs on commander, so `commander`, `@clack/prompts`, and `picocolors` are new runtime dependencies.
