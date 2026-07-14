import { assertIndexerAdapterConformance } from "@voyant-travel/catalog-contracts/indexer/conformance";
import { createAlgoliaIndexer } from "../src/adapter.js";

const applicationId = requiredEnv("ALGOLIA_APP_ID");
const apiKey = requiredEnv("ALGOLIA_API_KEY");

await assertIndexerAdapterConformance({
	createAdapter: () =>
		createAlgoliaIndexer({
			applicationId,
			apiKey,
			registries: new Map(),
			indexPrefix: `voyant-conformance-${Date.now().toString(36)}`,
		}),
});

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value)
		throw new Error(`${name} is required to run live Algolia conformance.`);
	return value;
}
