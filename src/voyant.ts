import { definePlugin } from "@voyant-travel/core/project";

/** Import-cheap declaration for the external Algolia catalog search provider. */
export const algoliaAdapterVoyantPlugin = definePlugin({
	id: "@voyant-travel/algolia-adapter",
	packageName: "@voyant-travel/algolia-adapter",
	localId: "algolia-adapter",
	config: [
		{
			id: "@voyant-travel/algolia-adapter#config.application-id",
			key: "ALGOLIA_APP_ID",
			required: true,
		},
	],
	secrets: [
		{
			id: "@voyant-travel/algolia-adapter#secret.api-key",
			key: "ALGOLIA_API_KEY",
			required: true,
			description:
				"Algolia Admin API key with search, browse, indexing, settings, and index deletion ACLs.",
			rotation: "replace-only",
		},
	],
	providers: [
		{
			id: "@voyant-travel/algolia-adapter#provider.algolia",
			port: "catalog.indexer",
			selection: { role: "search", value: "algolia" },
			uses: {
				config: ["@voyant-travel/algolia-adapter#config.application-id"],
				secrets: ["@voyant-travel/algolia-adapter#secret.api-key"],
			},
			runtime: {
				entry: "@voyant-travel/algolia-adapter/provider",
				export: "createAlgoliaGraphIndexerProvider",
			},
			config: { engine: "algolia" },
		},
	],
	meta: { ownership: "package" },
});

export default algoliaAdapterVoyantPlugin;
