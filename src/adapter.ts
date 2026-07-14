import type { FieldPolicyRegistry } from "@voyant-travel/catalog-contracts/contract";
import {
	type IndexerAdapter,
	type IndexerDocument,
	type IndexerProviderOptions,
	type IndexerSlice,
	indexFieldNameForPolicyPath,
	resolveFacetBucketLimit,
	resolveSearchSort,
	type SearchFilter,
	type SearchRequest,
	type SearchResults,
} from "@voyant-travel/catalog-contracts/indexer/contract";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 1_000;
const SORT_OPTIONS = [
	"price-asc",
	"price-desc",
	"departure-asc",
	"newest",
] as const;
const PRIMARY_MARKER = "__voyant_primary";
const SORT_MARKER = "__voyant_sort__";
const META_FIELDS = new Set([
	"_highlightResult",
	"_snippetResult",
	"_rankingInfo",
	"_distinctSeqID",
	"_geoloc",
	"_queryID",
]);

export interface AlgoliaRequest {
	path: string;
	method?: string;
	body?: unknown;
}

export type AlgoliaTransport = (request: AlgoliaRequest) => Promise<unknown>;

export interface AlgoliaIndexerOptions extends IndexerProviderOptions {
	applicationId: string;
	apiKey: string;
	/** Stable prefix for every Algolia index owned by this adapter. */
	indexPrefix?: string;
	/** Injected transport is primarily useful for deterministic tests. */
	transport?: AlgoliaTransport;
	/** Override for a proxy or an Algolia-compatible test server. */
	baseUrl?: string;
	taskPollIntervalMs?: number;
	taskTimeoutMs?: number;
}

/** Error returned when Algolia rejects an API request. */
export class AlgoliaHttpError extends Error {
	constructor(
		readonly status: number,
		readonly path: string,
		readonly body: string,
	) {
		super(`Algolia ${status} ${path}: ${body}`);
		this.name = "AlgoliaHttpError";
	}
}

/**
 * Create an Algolia implementation of Voyant's portable catalog indexer.
 *
 * Algolia's vector/NeuralSearch configuration is product- and index-specific,
 * so this adapter intentionally declares keyword-only capabilities. It uses
 * regular replicas for the portable sorted searches and waits for every
 * asynchronous indexing task before resolving a mutation.
 */
export function createAlgoliaIndexer(
	options: AlgoliaIndexerOptions,
): IndexerAdapter {
	const registries = new Map(options.registries);
	const prefix = normalizePrefix(options.indexPrefix);
	const transport =
		options.transport ??
		createFetchTransport({
			applicationId: options.applicationId,
			apiKey: options.apiKey,
			...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
		});
	const pollIntervalMs = options.taskPollIntervalMs ?? 100;
	const taskTimeoutMs = options.taskTimeoutMs ?? 30_000;

	const waitForTask = async (
		indexName: string,
		response: unknown,
	): Promise<void> => {
		const taskId = taskIdFrom(response);
		if (taskId === undefined) return;
		const deadline = Date.now() + taskTimeoutMs;
		for (;;) {
			const task = asRecord(
				await transport({
					path: `/1/indexes/${encodeURIComponent(indexName)}/task/${taskId}`,
				}),
			);
			if (task.status === "published") return;
			if (task.status === "failed") {
				throw new Error(
					`Algolia task ${taskId} failed for index "${indexName}".`,
				);
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`Timed out waiting for Algolia task ${taskId} on index "${indexName}".`,
				);
			}
			await sleep(pollIntervalMs);
		}
	};

	const updateSettings = async (
		indexName: string,
		body: Record<string, unknown>,
	): Promise<void> => {
		const response = await transport({
			path: `/1/indexes/${encodeURIComponent(indexName)}/settings`,
			method: "PUT",
			body,
		});
		await waitForTask(indexName, response);
	};

	const adapter: IndexerAdapter = {
		capabilities: {
			supportsKeywordSearch: true,
			supportsHybridSearch: false,
			supportsVectorFields: false,
			vectorDimensions: null,
			maxVectorsPerDocument: null,
			supportsCrossAudienceFederation: false,
			supportsAdminDenormalization: true,
		},
		admin: {
			async list() {
				const slices: IndexerSlice[] = [];
				let page = 0;
				for (;;) {
					const response = asRecord(
						await transport({
							path: `/1/indexes?page=${page}&hitsPerPage=${MAX_PAGE_SIZE}`,
						}),
					);
					const items = Array.isArray(response.items) ? response.items : [];
					for (const item of items) {
						const name = asRecord(item).name;
						if (typeof name !== "string") continue;
						const slice = parsePrimaryIndexName(name, prefix);
						if (slice) slices.push(slice);
					}
					const pages = finiteInteger(response.nbPages);
					if (items.length === 0 || pages === undefined || page + 1 >= pages)
						return slices;
					page += 1;
				}
			},
			async drop(slice) {
				const admin = adapter.admin;
				if (!admin)
					throw new Error("Algolia adapter admin operations are unavailable.");
				const existing = await admin.list();
				if (!existing.some((candidate) => sameSlice(candidate, slice)))
					return false;
				const primary = primaryIndexName(slice, prefix);
				const registry = registries.get(slice.vertical);
				const replicaNames = registry
					? sortReplicas(primary, registry, slice).map(({ name }) => name)
					: [];
				for (const name of [...replicaNames, primary]) {
					try {
						const response = await transport({
							path: `/1/indexes/${encodeURIComponent(name)}`,
							method: "DELETE",
						});
						await waitForTask(name, response);
					} catch (error) {
						if (isNotFound(error)) continue;
						throw error;
					}
				}
				return true;
			},
			async *scan(slice, scanOptions) {
				const indexName = primaryIndexName(slice, prefix);
				let cursor: string | undefined;
				do {
					const body: Record<string, unknown> = {
						query: "",
						hitsPerPage: normalizePageSize(scanOptions?.batchSize),
					};
					if (cursor) body.cursor = cursor;
					const response = asRecord(
						await transport({
							path: `/1/indexes/${encodeURIComponent(indexName)}/browse`,
							method: "POST",
							body,
						}),
					);
					const hits = Array.isArray(response.hits) ? response.hits : [];
					for (const hit of hits) yield documentFromHit(asRecord(hit));
					cursor =
						typeof response.cursor === "string" ? response.cursor : undefined;
				} while (cursor);
			},
		},

		async ensureCollection(slice, registry) {
			registries.set(slice.vertical, registry);
			const primary = primaryIndexName(slice, prefix);
			const replicas = sortReplicas(primary, registry, slice);
			const searchableAttributes = searchableFields(registry);
			const attributesForFaceting = facetableFields(registry);

			await updateSettings(primary, {
				searchableAttributes,
				attributesForFaceting,
				replicas: replicas.map(({ name }) => name),
				paginationLimitedTo: MAX_PAGE_SIZE,
			});
			for (const replica of replicas) {
				await updateSettings(replica.name, {
					searchableAttributes,
					attributesForFaceting,
					paginationLimitedTo: MAX_PAGE_SIZE,
					ranking: [
						`${replica.direction}(${replica.field})`,
						"typo",
						"geo",
						"words",
						"filters",
						"proximity",
						"attribute",
						"exact",
						"custom",
					],
				});
			}
		},

		async upsert(slice, documents) {
			rejectEmbeddings(documents);
			if (documents.length === 0) return;
			const indexName = primaryIndexName(slice, prefix);
			for (const batch of batches(documents, MAX_PAGE_SIZE)) {
				const response = await transport({
					path: `/1/indexes/${encodeURIComponent(indexName)}/batch`,
					method: "POST",
					body: {
						requests: batch.map((document) => ({
							action: "addObject",
							body: { objectID: document.id, ...document.fields },
						})),
					},
				});
				await waitForTask(indexName, response);
			}
		},

		async delete(slice, ids) {
			if (ids.length === 0) return;
			const indexName = primaryIndexName(slice, prefix);
			for (const batch of batches(ids, MAX_PAGE_SIZE)) {
				const response = await transport({
					path: `/1/indexes/${encodeURIComponent(indexName)}/batch`,
					method: "POST",
					body: {
						requests: batch.map((objectID) => ({
							action: "deleteObject",
							body: { objectID },
						})),
					},
				});
				await waitForTask(indexName, response);
			}
		},

		async search(slice, request) {
			if (request.mode !== "keyword") {
				throw new Error(
					`Algolia adapter does not support ${request.mode} search.`,
				);
			}
			if (request.search_audiences?.length) {
				throw new Error(
					"Algolia adapter does not support cross-audience federation in one search call.",
				);
			}
			const registry = registries.get(slice.vertical);
			if (!registry) {
				throw new Error(
					`No field-policy registry is configured for catalog vertical "${slice.vertical}".`,
				);
			}
			const primary = primaryIndexName(slice, prefix);
			const sort = resolveSearchSort(request.sort, registry, slice);
			const indexName = sort
				? `${primary}${SORT_MARKER}${sort.direction}__${sort.field}`
				: primary;
			const limit = normalizePageSize(request.pagination?.limit);
			const fingerprint = searchFingerprint(indexName, request);
			const page = request.pagination?.cursor
				? decodeCursor(request.pagination.cursor, fingerprint)
				: 0;
			const alternatives = filtersToDnf(request.filters);
			const useClientSideUnion = alternatives.length > 1;
			const responses = await Promise.all(
				alternatives.map(async (alternative) => {
					const params = searchParams({
						request,
						filters: filtersToAlgolia(alternative),
						page: useClientSideUnion ? 0 : page,
						limit: useClientSideUnion ? MAX_PAGE_SIZE : limit,
					});
					return asRecord(
						await transport({
							path: `/1/indexes/${encodeURIComponent(indexName)}/query`,
							method: "POST",
							body: { params: params.toString() },
						}),
					);
				}),
			);
			if (responses.length === 1) {
				const [response] = responses;
				if (!response) throw new Error("Algolia search returned no response.");
				return resultsFromSearchResponse(
					response,
					page,
					limit,
					fingerprint,
					request.facets,
				);
			}
			return resultsFromUnionResponses({
				responses,
				page,
				limit,
				fingerprint,
				facets: request.facets,
				sort,
			});
		},

		async bulkReindex(slice, stream) {
			const batch: IndexerDocument[] = [];
			for await (const document of stream) {
				batch.push(document);
				if (batch.length === MAX_PAGE_SIZE) {
					await adapter.upsert(slice, batch);
					batch.length = 0;
				}
			}
			await adapter.upsert(slice, batch);
		},
	};

	return adapter;
}

function createFetchTransport(input: {
	applicationId: string;
	apiKey: string;
	baseUrl?: string;
}): AlgoliaTransport {
	const baseUrl = (
		input.baseUrl ?? `https://${input.applicationId}.algolia.net`
	).replace(/\/$/, "");
	return async ({ path, method = "GET", body }) => {
		const response = await fetch(`${baseUrl}${path}`, {
			method,
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"X-Algolia-Application-Id": input.applicationId,
				"X-Algolia-API-Key": input.apiKey,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) {
			throw new AlgoliaHttpError(response.status, path, await response.text());
		}
		if (response.status === 204) return undefined;
		return response.json() as Promise<unknown>;
	};
}

function primaryIndexName(slice: IndexerSlice, prefix: string): string {
	const parts = [
		slice.vertical,
		slice.locale,
		slice.audience,
		slice.market,
		slice.channel,
	].filter((value): value is string => value !== undefined);
	for (const part of parts) {
		if (!part || part.includes("__")) {
			throw new TypeError(
				`Catalog index slice values must be non-empty and cannot contain "__"; received "${part}".`,
			);
		}
	}
	return `${prefix}${parts.join("__")}${PRIMARY_MARKER}`;
}

function parsePrimaryIndexName(
	name: string,
	prefix: string,
): IndexerSlice | undefined {
	if (!name.startsWith(prefix) || !name.endsWith(PRIMARY_MARKER))
		return undefined;
	const parts = name.slice(prefix.length, -PRIMARY_MARKER.length).split("__");
	if (parts.length !== 4 && parts.length !== 5) return undefined;
	const [vertical, locale, audience, market, channel] = parts;
	if (!vertical || !locale || !market || !isAudience(audience))
		return undefined;
	return {
		vertical,
		locale,
		audience,
		market,
		...(channel ? { channel } : {}),
	};
}

function sortReplicas(
	primary: string,
	registry: FieldPolicyRegistry,
	slice: IndexerSlice,
) {
	return SORT_OPTIONS.flatMap((option) => {
		const sort = resolveSearchSort(option, registry, slice);
		return sort
			? [
					{
						name: `${primary}${SORT_MARKER}${sort.direction}__${sort.field}`,
						...sort,
					},
				]
			: [];
	});
}

function searchableFields(registry: FieldPolicyRegistry): string[] {
	return [
		...new Set(
			registry.policies
				.filter((policy) => policy.query !== "blob-only")
				.map((policy) => indexFieldNameForPolicyPath(policy.path)),
		),
	].map(safeField);
}

function facetableFields(registry: FieldPolicyRegistry): string[] {
	return [
		...new Set(
			registry.policies
				.filter((policy) => policy.query === "indexed-column")
				.map((policy) => indexFieldNameForPolicyPath(policy.path)),
		),
	].map(safeField);
}

function searchParams(input: {
	request: SearchRequest;
	filters: string | undefined;
	page: number;
	limit: number;
}): URLSearchParams {
	const params = new URLSearchParams({
		query: input.request.query,
		page: String(input.page),
		hitsPerPage: String(input.limit),
		attributesToRetrieve: "*",
	});
	if (input.filters) params.set("filters", input.filters);
	if (input.request.facets?.length) {
		params.set(
			"facets",
			JSON.stringify(input.request.facets.map(({ field }) => safeField(field))),
		);
		params.set(
			"maxValuesPerFacet",
			String(
				Math.max(
					...input.request.facets.map(({ limit }) =>
						resolveFacetBucketLimit(limit),
					),
				),
			),
		);
	}
	return params;
}

function filtersToAlgolia(
	filters: readonly SearchFilter[],
): string | undefined {
	if (!filters?.length) return undefined;
	return filters.map(filterToAlgolia).join(" AND ");
}

/** Algolia disallows some mixed-type OR filters, so each branch is searched separately. */
function filtersToDnf(filters: SearchFilter[] | undefined): SearchFilter[][] {
	return (filters ?? []).reduce<SearchFilter[][]>(
		(clauses, filter) => cartesianAnd(clauses, filterToDnf(filter)),
		[[]],
	);
}

function filterToDnf(filter: SearchFilter): SearchFilter[][] {
	if (filter.kind === "and") {
		return filter.clauses.reduce<SearchFilter[][]>(
			(clauses, child) => cartesianAnd(clauses, filterToDnf(child)),
			[[]],
		);
	}
	if (filter.kind === "or") return filter.clauses.flatMap(filterToDnf);
	return [[filter]];
}

function cartesianAnd(
	left: SearchFilter[][],
	right: SearchFilter[][],
): SearchFilter[][] {
	return left.flatMap((leftClause) =>
		right.map((rightClause) => [...leftClause, ...rightClause]),
	);
}

function filterToAlgolia(filter: SearchFilter): string {
	switch (filter.kind) {
		case "eq":
			return comparison(filter.field, "=", filter.value);
		case "in":
			if (filter.values.length === 0) return 'objectID = "__voyant_no_match__"';
			return `(${filter.values.map((value) => comparison(filter.field, "=", value)).join(" OR ")})`;
		case "range": {
			const terms = [
				...(filter.gte === undefined
					? []
					: [comparison(filter.field, ">=", filter.gte)]),
				...(filter.lte === undefined
					? []
					: [comparison(filter.field, "<=", filter.lte)]),
			];
			if (!terms.length)
				throw new TypeError("A range filter must define gte, lte, or both.");
			const [firstTerm] = terms;
			return terms.length === 1 && firstTerm
				? firstTerm
				: `(${terms.join(" AND ")})`;
		}
		case "and":
			return `(${filter.clauses.map(filterToAlgolia).join(" AND ")})`;
		case "or":
			return `(${filter.clauses.map(filterToAlgolia).join(" OR ")})`;
	}
}

function comparison(
	field: string,
	operator: "=" | ">=" | "<=",
	value: string | number | boolean,
): string {
	const resolved = field === "id" ? "objectID" : safeField(field);
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new TypeError(`Filter value for "${field}" must be finite.`);
		return `${resolved} ${operator} ${value}`;
	}
	if (typeof value === "boolean") return `${resolved}:${value}`;
	return `${resolved}:${JSON.stringify(value)}`;
}

function resultsFromSearchResponse(
	response: Record<string, unknown>,
	page: number,
	limit: number,
	fingerprint: string,
	requestedFacets: SearchRequest["facets"],
): SearchResults {
	const hits = Array.isArray(response.hits) ? response.hits.map(asRecord) : [];
	const total = finiteInteger(response.nbHits) ?? 0;
	const exhaustive = asRecord(response.exhaustive).nbHits;
	const facets = requestedFacets?.length
		? mapFacets(asRecord(response.facets), requestedFacets)
		: undefined;
	return {
		hits: hits.map((hit, index) => ({
			id: objectId(hit),
			score: total - page * limit - index,
			document: documentFromHit(hit),
		})),
		total,
		...(exhaustive === false ? { totalRelation: "gte" as const } : {}),
		...(hits.length === limit && (page + 1) * limit < total
			? { next_cursor: encodeCursor(fingerprint, page + 1) }
			: {}),
		...(facets ? { facets } : {}),
	};
}

function resultsFromUnionResponses(input: {
	responses: Record<string, unknown>[];
	page: number;
	limit: number;
	fingerprint: string;
	facets: SearchRequest["facets"];
	sort: { field: string; direction: "asc" | "desc" } | undefined;
}): SearchResults {
	const unique = new Map<string, Record<string, unknown>>();
	let fullyRepresented = true;
	for (const response of input.responses) {
		const hits = Array.isArray(response.hits)
			? response.hits.map(asRecord)
			: [];
		for (const hit of hits) unique.set(objectId(hit), hit);
		const total = finiteInteger(response.nbHits) ?? 0;
		if (asRecord(response.exhaustive).nbHits === false || total > hits.length) {
			fullyRepresented = false;
		}
	}
	const ordered = [...unique.values()];
	const sort = input.sort;
	if (sort) {
		ordered.sort((left, right) => {
			const comparison = compareValues(left[sort.field], right[sort.field]);
			return sort.direction === "asc" ? comparison : -comparison;
		});
	}
	const start = input.page * input.limit;
	const pageHits = ordered.slice(start, start + input.limit);
	const facets = input.facets?.length
		? facetsFromUnionHits(ordered, input.facets)
		: undefined;
	return {
		hits: pageHits.map((hit, index) => ({
			id: objectId(hit),
			score: ordered.length - start - index,
			document: documentFromHit(hit),
		})),
		total: ordered.length,
		...(fullyRepresented ? {} : { totalRelation: "gte" as const }),
		...(fullyRepresented && start + input.limit < ordered.length
			? { next_cursor: encodeCursor(input.fingerprint, input.page + 1) }
			: {}),
		...(facets ? { facets } : {}),
	};
}

function facetsFromUnionHits(
	hits: readonly Record<string, unknown>[],
	requested: NonNullable<SearchRequest["facets"]>,
): Record<string, Array<{ value: string | number; count: number }>> {
	return Object.fromEntries(
		requested.map(({ field, limit }) => {
			const counts = new Map<string | number, number>();
			for (const hit of hits) {
				const values = Array.isArray(hit[field]) ? hit[field] : [hit[field]];
				for (const value of values) {
					if (typeof value === "string" || typeof value === "number") {
						counts.set(value, (counts.get(value) ?? 0) + 1);
					}
				}
			}
			return [
				field,
				[...counts.entries()]
					.map(([value, count]) => ({ value, count }))
					.sort(
						(left, right) =>
							right.count - left.count ||
							String(left.value).localeCompare(String(right.value)),
					)
					.slice(0, resolveFacetBucketLimit(limit)),
			];
		}),
	);
}

function compareValues(left: unknown, right: unknown): number {
	if (left === right) return 0;
	if (left === undefined || left === null) return 1;
	if (right === undefined || right === null) return -1;
	if (typeof left === "number" && typeof right === "number")
		return left - right;
	return String(left).localeCompare(String(right));
}

function mapFacets(
	response: Record<string, unknown>,
	requested: NonNullable<SearchRequest["facets"]>,
): Record<string, Array<{ value: string | number; count: number }>> {
	return Object.fromEntries(
		requested.map(({ field, limit }) => {
			const values = asRecord(response[field]);
			const buckets = Object.entries(values)
				.map(([value, count]) => ({
					value: numericFacetValue(value),
					count: finiteInteger(count) ?? 0,
				}))
				.sort(
					(left, right) =>
						right.count - left.count ||
						String(left.value).localeCompare(String(right.value)),
				)
				.slice(0, resolveFacetBucketLimit(limit));
			return [field, buckets];
		}),
	);
}

function documentFromHit(hit: Record<string, unknown>): IndexerDocument {
	const id = objectId(hit);
	const fields = Object.fromEntries(
		Object.entries(hit).filter(
			([key]) => key !== "objectID" && !META_FIELDS.has(key),
		),
	);
	return { id, fields };
}

function objectId(hit: Record<string, unknown>): string {
	if (typeof hit.objectID !== "string" || hit.objectID.length === 0) {
		throw new TypeError(
			"Algolia search hit did not include a non-empty objectID.",
		);
	}
	return hit.objectID;
}

function rejectEmbeddings(documents: readonly IndexerDocument[]): void {
	if (
		documents.some(
			(document) => document.embeddings || document.embedding_model_id,
		)
	) {
		throw new Error(
			"Algolia adapter does not support vector embeddings; configure a vector-capable provider instead.",
		);
	}
}

function normalizePageSize(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_PAGE_SIZE;
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new RangeError(
			`Search pagination limit must be a positive integer; received ${String(limit)}.`,
		);
	}
	return Math.min(limit, MAX_PAGE_SIZE);
}

function searchFingerprint(indexName: string, request: SearchRequest): string {
	return JSON.stringify({
		indexName,
		query: request.query,
		filters: request.filters ?? [],
		facets: request.facets ?? [],
		sort: request.sort,
		mode: request.mode,
	});
}

function encodeCursor(fingerprint: string, page: number): string {
	return base64Url(JSON.stringify({ fingerprint, page }));
}

function decodeCursor(cursor: string, fingerprint: string): number {
	let decoded: unknown;
	try {
		decoded = JSON.parse(fromBase64Url(cursor));
	} catch {
		throw new TypeError("Algolia search cursor is malformed.");
	}
	const value = asRecord(decoded);
	if (
		value.fingerprint !== fingerprint ||
		!Number.isInteger(value.page) ||
		(value.page as number) < 0
	) {
		throw new TypeError("Algolia search cursor does not belong to this query.");
	}
	return value.page as number;
}

function base64Url(value: string): string {
	const binary = String.fromCharCode(...new TextEncoder().encode(value));
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
	const padded = value
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	return new TextDecoder().decode(
		Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)),
	);
}

function normalizePrefix(prefix: string | undefined): string {
	if (!prefix) return "voyant__";
	return prefix.endsWith("__") ? prefix : `${prefix}__`;
}

function safeField(field: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(field)) {
		throw new TypeError(`Unsupported Algolia field name "${field}".`);
	}
	return field;
}

function taskIdFrom(response: unknown): number | undefined {
	const taskId = asRecord(response).taskID;
	return finiteInteger(taskId);
}

function finiteInteger(value: unknown): number | undefined {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		Number.isInteger(value)
		? value
		: undefined;
}

function numericFacetValue(value: string): string | number {
	const numeric = Number(value);
	return value.trim() !== "" &&
		Number.isFinite(numeric) &&
		String(numeric) === value
		? numeric
		: value;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function isAudience(
	value: string | undefined,
): value is IndexerSlice["audience"] {
	return (
		value === "staff" ||
		value === "customer" ||
		value === "partner" ||
		value === "supplier" ||
		value === "staff-admin"
	);
}

function sameSlice(left: IndexerSlice, right: IndexerSlice): boolean {
	return (
		left.vertical === right.vertical &&
		left.locale === right.locale &&
		left.audience === right.audience &&
		left.market === right.market &&
		left.channel === right.channel
	);
}

function isNotFound(error: unknown): boolean {
	return error instanceof AlgoliaHttpError && error.status === 404;
}

function batches<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let start = 0; start < items.length; start += size)
		result.push(items.slice(start, start + size));
	return result;
}

function sleep(milliseconds: number): Promise<void> {
	return milliseconds > 0
		? new Promise((resolve) => setTimeout(resolve, milliseconds))
		: Promise.resolve();
}
