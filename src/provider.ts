import type { IndexerProvider } from "@voyant-travel/catalog-contracts/indexer/contract";
import { createAlgoliaIndexer } from "./adapter.js";

const APPLICATION_ID_CONFIG =
	"@voyant-travel/algolia-adapter#config.application-id";
const API_KEY_SECRET = "@voyant-travel/algolia-adapter#secret.api-key";

export interface AlgoliaProviderContext {
	getConfig<T = unknown>(declarationId: string): T | undefined;
	getSecret<T = unknown>(declarationId: string): T | undefined;
}

/** Runtime factory registered by the Algolia plugin manifest. */
export function createAlgoliaGraphIndexerProvider(
	context: AlgoliaProviderContext,
): IndexerProvider {
	const applicationId = requiredString(
		context.getConfig(APPLICATION_ID_CONFIG),
		"ALGOLIA_APP_ID",
	);
	const apiKey = requiredString(
		context.getSecret(API_KEY_SECRET),
		"ALGOLIA_API_KEY",
	);

	return {
		create: ({ registries, vectorDimensions }) =>
			createAlgoliaIndexer({
				applicationId,
				apiKey,
				registries,
				...(vectorDimensions === undefined ? {} : { vectorDimensions }),
			}),
	};
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${name} must be a non-empty string.`);
	}
	return value.trim();
}
