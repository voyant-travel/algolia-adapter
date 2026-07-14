# Voyant Algolia Adapter

An external [Algolia](https://www.algolia.com/doc) provider for Voyant Catalog search. It implements the public `IndexerAdapter` contract from `@voyant-travel/catalog-contracts`; it does not depend on the Catalog runtime package.

## Install and select

```bash
pnpm add @voyant-travel/algolia-adapter
```

Add the plugin and select Algolia in the application's `voyant.config.ts`:

```ts
import { defineConfig } from "@voyant-travel/framework/project"

export default defineConfig({
  plugins: [{ resolve: "@voyant-travel/algolia-adapter" }],
  deployment: {
    target: "node",
    mode: "self-hosted",
    providers: { search: "algolia" },
  },
})
```

Supply the plugin's declared `ALGOLIA_APP_ID` config value and `ALGOLIA_API_KEY` secret. The key must have the `search`, `browse`, `addObject`, `deleteObject`, `editSettings`, `listIndexes`, and `deleteIndex` ACLs. The adapter waits for Algolia indexing tasks, so an accepted mutation is visible before the corresponding Catalog operation resolves.

## Behavior

- Each Catalog slice is a separate Algolia primary index. The adapter owns only names prefixed with `voyant__` (or a supplied `indexPrefix`).
- `ensureCollection` configures searchable and facetable policy fields, then creates regular Algolia replicas for supported portable sorts. This follows Algolia's index-settings and replica model instead of attempting unsupported request-time sorting.
- Indexing, deletion, settings, browse, list, and task polling use Algolia's documented REST endpoints. There is no SDK-version coupling.
- The adapter supports keyword search, policy-backed filters, facets, cursor pagination, admin scans, and admin index lifecycle operations.
- It deliberately declares no vector, hybrid, or one-call cross-audience federation capability. Algolia NeuralSearch/vector configuration is plan and index specific, and claiming it without an explicit deployment design would violate the Catalog capability contract.

## Validate

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

The unit suite verifies the REST request shapes, portable query translation, asynchronous task waiting, policy-driven replica setup, and admin behavior with a deterministic transport.

Run the published conformance kit against a disposable Algolia application with a fully privileged key:

```bash
ALGOLIA_APP_ID=... ALGOLIA_API_KEY=... pnpm test:conformance
```

The conformance run creates and removes uniquely prefixed indexes. Do not point it at a production-only key or a shared index namespace.
