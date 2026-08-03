---
"@voyant-travel/algolia-adapter": minor
---

Declare this package with `defineAdapter` from `@voyant-travel/graph-contracts`
and drop the `@voyant-travel/core` peer dependency.

`definePlugin` is retired — RFC #3395 replaced the "plugin" classification with
apps and adapters — and it lived in the runtime kernel, so every consumer of
this adapter had to install the DI container, registry, event bus, saga, and
locking to satisfy the peer. `graph-contracts` carries the declaration surface
with no dependencies at all.

`voyant.kind` is now `adapter`, and the manifest export is
`algoliaVoyantAdapter`.
