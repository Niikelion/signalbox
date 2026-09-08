---
"@signalbox/service-cli": minor
---

Rebuild the interactive prompts on `@clack/prompts` with `picocolors`, replacing the hand-rolled raw-keypress terminal code. `config init` and `config interactive` now show a styled intro/outro, a proper highlighted select list, and native masked and confirm prompts.

This fixes two bugs in the previous implementation: the interactive config editor no longer hangs after Save/Discard (stdin is released), and the field picker renders the whole list with the active row highlighted instead of a single row that swapped in place.
