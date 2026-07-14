import type {
	FieldPolicy,
	FieldPolicyRegistry,
} from "@voyant-travel/catalog-contracts/contract";
import { createFieldPolicyRegistry } from "@voyant-travel/catalog-contracts/contract";
import type { IndexerSlice } from "@voyant-travel/catalog-contracts/indexer/contract";
import { describe, expect, it } from "vitest";
import { type AlgoliaRequest, createAlgoliaIndexer } from "./adapter.js";

const slice: IndexerSlice = {
	vertical: "products",
	locale: "en-GB",
	audience: "customer",
	market: "default",
};

function registry(): FieldPolicyRegistry {
	return createFieldPolicyRegistry([
		policy("title", "merchandisable"),
		policy("categorySlugs[]", "structural", "facet-affecting"),
		policy("priceFromAmountCents", "structural"),
		policy("isFeatured", "structural"),
		policy("customerTitle", "merchandisable"),
	]);
}

function policy(
	path: string,
	fieldClass: "merchandisable" | "structural",
	reindex: "entry" | "facet-affecting" = "entry",
): FieldPolicy {
	return {
		path,
		class: fieldClass,
		merge: "replace" as const,
		drift: "low" as const,
		reindex,
		snapshot: "never" as const,
		query: "indexed-column" as const,
		localized: false,
		visibility: ["staff", "customer", "partner", "supplier"],
		editRole: "none" as const,
		overrideFriction: "none" as const,
		sourceFreshness: "sync" as const,
	};
}

function createTransport(respond: (request: AlgoliaRequest) => unknown) {
	const calls: AlgoliaRequest[] = [];
	return {
		calls,
		transport: async (request: AlgoliaRequest) => {
			calls.push(request);
			if (request.path.includes("/task/")) return { status: "published" };
			return respond(request);
		},
	};
}

describe("createAlgoliaIndexer", () => {
	it("configures the primary index and sorted replicas from field policy", async () => {
		const fake = createTransport((request) => {
			if (request.method === "PUT") return { taskID: 1 };
			throw new Error(
				`Unexpected request: ${request.method ?? "GET"} ${request.path}`,
			);
		});
		const adapter = createAlgoliaIndexer({
			applicationId: "app",
			apiKey: "key",
			registries: new Map([["products", registry()]]),
			transport: fake.transport,
			taskPollIntervalMs: 0,
		});

		await adapter.ensureCollection(slice, registry());

		const settings = fake.calls.filter((call) => call.method === "PUT");
		expect(settings).toHaveLength(3);
		expect(settings[0]).toMatchObject({
			path: "/1/indexes/voyant__products__en-GB__customer__default__voyant_primary/settings",
			body: {
				searchableAttributes: [
					"title",
					"categorySlugs",
					"priceFromAmountCents",
					"isFeatured",
					"customerTitle",
				],
				attributesForFaceting: [
					"title",
					"categorySlugs",
					"priceFromAmountCents",
					"isFeatured",
					"customerTitle",
				],
			},
		});
		const primarySettings = settings[0];
		if (!primarySettings)
			throw new Error("Primary settings request was not recorded.");
		expect((primarySettings.body as { replicas: string[] }).replicas).toEqual([
			"voyant__products__en-GB__customer__default__voyant_primary__voyant_sort__asc__priceFromAmountCents",
			"voyant__products__en-GB__customer__default__voyant_primary__voyant_sort__desc__priceFromAmountCents",
		]);
	});

	it("uses Algolia's documented query endpoint and maps filters, facets, sorting, and cursors", async () => {
		const fake = createTransport((request) => {
			if (request.path.endsWith("/query")) {
				return {
					hits: [
						{
							objectID: "product_1",
							title: "Voyant Alpine Escape",
							categorySlugs: ["ski", "featured"],
							_highlightResult: { title: {} },
						},
					],
					nbHits: 3,
					exhaustive: { nbHits: true },
					facets: { categorySlugs: { ski: 2, featured: 2, beach: 1 } },
				};
			}
			throw new Error(
				`Unexpected request: ${request.method ?? "GET"} ${request.path}`,
			);
		});
		const adapter = createAlgoliaIndexer({
			applicationId: "app",
			apiKey: "key",
			registries: new Map([["products", registry()]]),
			transport: fake.transport,
		});

		const first = await adapter.search(slice, {
			mode: "keyword",
			query: "Alpine",
			sort: "price-asc",
			filters: [
				{ kind: "eq", field: "isFeatured", value: true },
				{ kind: "range", field: "priceFromAmountCents", gte: 100 },
			],
			facets: [{ field: "categorySlugs", limit: 2 }],
			pagination: { limit: 1 },
		});

		const query = fake.calls.find((call) => call.path.endsWith("/query"));
		if (!query) throw new Error("Search request was not recorded.");
		expect(query.path).toContain(
			"__voyant_sort__asc__priceFromAmountCents/query",
		);
		const params = new URLSearchParams(
			(query.body as { params: string }).params,
		);
		expect(params.get("query")).toBe("Alpine");
		expect(params.get("filters")).toBe(
			"isFeatured:true AND priceFromAmountCents >= 100",
		);
		expect(params.get("facets")).toBe('["categorySlugs"]');
		expect(first).toMatchObject({
			total: 3,
			hits: [
				{
					id: "product_1",
					document: {
						id: "product_1",
						fields: {
							title: "Voyant Alpine Escape",
							categorySlugs: ["ski", "featured"],
						},
					},
				},
			],
			facets: {
				categorySlugs: [
					{ value: "featured", count: 2 },
					{ value: "ski", count: 2 },
				],
			},
		});
		expect(first.next_cursor).toBeTruthy();
	});

	it("waits for indexing tasks and sends batch upserts and deletes", async () => {
		const fake = createTransport((request) => {
			if (request.path.endsWith("/batch")) return { taskID: 42 };
			throw new Error(
				`Unexpected request: ${request.method ?? "GET"} ${request.path}`,
			);
		});
		const adapter = createAlgoliaIndexer({
			applicationId: "app",
			apiKey: "key",
			registries: new Map([["products", registry()]]),
			transport: fake.transport,
			taskPollIntervalMs: 0,
		});

		await adapter.upsert(slice, [
			{ id: "product_1", fields: { title: "Voyant Alpine Escape" } },
		]);
		await adapter.delete(slice, ["product_1"]);

		const batches = fake.calls.filter((call) => call.path.endsWith("/batch"));
		expect(batches).toEqual([
			expect.objectContaining({
				method: "POST",
				body: {
					requests: [
						{
							action: "addObject",
							body: { objectID: "product_1", title: "Voyant Alpine Escape" },
						},
					],
				},
			}),
			expect.objectContaining({
				method: "POST",
				body: {
					requests: [
						{ action: "deleteObject", body: { objectID: "product_1" } },
					],
				},
			}),
		]);
		expect(
			fake.calls.filter((call) => call.path.includes("/task/42")),
		).toHaveLength(2);
	});

	it("unions mixed-type OR branches that Algolia cannot express in one filter", async () => {
		const fake = createTransport((request) => {
			if (request.path.endsWith("/query")) {
				const filter = new URLSearchParams(
					(request.body as { params: string }).params,
				).get("filters");
				return filter === "isFeatured:true"
					? {
							hits: [{ objectID: "featured", title: "Featured" }],
							nbHits: 1,
							exhaustive: { nbHits: true },
						}
					: {
							hits: [{ objectID: "budget", title: "Budget" }],
							nbHits: 1,
							exhaustive: { nbHits: true },
						};
			}
			throw new Error(
				`Unexpected request: ${request.method ?? "GET"} ${request.path}`,
			);
		});
		const adapter = createAlgoliaIndexer({
			applicationId: "app",
			apiKey: "key",
			registries: new Map([["products", registry()]]),
			transport: fake.transport,
		});

		const result = await adapter.search(slice, {
			mode: "keyword",
			query: "",
			filters: [
				{
					kind: "or",
					clauses: [
						{ kind: "eq", field: "isFeatured", value: true },
						{ kind: "range", field: "priceFromAmountCents", lte: 100 },
					],
				},
			],
		});

		const queries = fake.calls.filter((call) => call.path.endsWith("/query"));
		expect(queries).toHaveLength(2);
		expect(result.hits.map((hit) => hit.id).sort()).toEqual([
			"budget",
			"featured",
		]);
		expect(result.total).toBe(2);
		expect(result.totalRelation).toBeUndefined();
	});

	it("lists only owned primary slices and scans records without leaking objectID", async () => {
		const fake = createTransport((request) => {
			if (request.path.startsWith("/1/indexes?")) {
				return {
					nbPages: 1,
					items: [
						{
							name: "voyant__products__en-GB__customer__default__voyant_primary",
						},
						{
							name: "voyant__products__en-GB__customer__default__voyant_primary__voyant_sort__asc__priceFromAmountCents",
						},
						{ name: "another-team-index" },
					],
				};
			}
			if (request.path.endsWith("/browse")) {
				return {
					hits: [{ objectID: "product_1", title: "Voyant Alpine Escape" }],
				};
			}
			throw new Error(
				`Unexpected request: ${request.method ?? "GET"} ${request.path}`,
			);
		});
		const adapter = createAlgoliaIndexer({
			applicationId: "app",
			apiKey: "key",
			registries: new Map([["products", registry()]]),
			transport: fake.transport,
		});

		const admin = adapter.admin;
		if (!admin)
			throw new Error("Algolia adapter must expose admin operations.");
		await expect(admin.list()).resolves.toEqual([slice]);
		const scanned = [];
		for await (const document of admin.scan(slice)) scanned.push(document);
		expect(scanned).toEqual([
			{ id: "product_1", fields: { title: "Voyant Alpine Escape" } },
		]);
	});

	it("rejects vector and federated requests instead of silently changing their semantics", async () => {
		const adapter = createAlgoliaIndexer({
			applicationId: "app",
			apiKey: "key",
			registries: new Map([["products", registry()]]),
			transport: async () => ({}),
		});

		await expect(
			adapter.search(slice, { mode: "semantic", query: "Alpine" }),
		).rejects.toThrow("does not support semantic search");
		await expect(
			adapter.search(slice, {
				mode: "keyword",
				query: "Alpine",
				search_audiences: ["customer"],
			}),
		).rejects.toThrow("does not support cross-audience federation");
		await expect(
			adapter.upsert(slice, [
				{ id: "product_1", fields: {}, embeddings: { text: [1, 2] } },
			]),
		).rejects.toThrow("does not support vector embeddings");
	});
});
