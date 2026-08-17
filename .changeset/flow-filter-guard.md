---
"@signalbox/core": minor
---

`Flow.filter` now narrows: a type-guard predicate (`(v): v is S`) yields a `Flow<S>`.
The plain boolean predicate still returns `Flow<T>`. Runtime behavior is unchanged.
