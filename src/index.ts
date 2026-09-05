import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { handleAccessRequest } from "./access-handler";
import { getCreativeAssetResponse } from "./creative-assets";
import type { Props } from "./workers-oauth-utils";

const DEFAULT_META_API_VERSION = "v26.0";
const META_GRAPH_ORIGIN = "https://graph.facebook.com";
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const META_ID_PATTERN = /^\d+$/;
const IDEMPOTENCY_TTL_SECONDS = 86_400;
const CONNECTOR_VERSION = "2.2.5";

type MetaEnv = Env & {
	META_ACCESS_TOKEN?: string;
	META_AD_ACCOUNT_ID?: string;
	META_API_VERSION?: string;
	META_WRITE_ENABLED?: string;
};

type MetaGraphErrorPayload = {
	error?: {
		code?: number;
		error_user_msg?: string;
		error_user_title?: string;
		error_subcode?: number;
		fbtrace_id?: string;
		message?: string;
		type?: string;
	};
};

type MetaPaging = {
	cursors?: { after?: string; before?: string };
};

type OwnedObjectType = "CAMPAIGN" | "ADSET" | "AD";

const writeResponseSchema = z
	.object({ id: z.string().optional(), success: z.boolean().optional() })
	.passthrough();

const graphListSchema = z
	.object({
		data: z.array(z.record(z.string(), z.unknown())).default([]),
		paging: z
			.object({
				next: z.string().optional(),
				cursors: z
					.object({ after: z.string().optional(), before: z.string().optional() })
					.optional(),
			})
			.optional(),
	})
	.passthrough();

const objectSchema = z
	.object({
		account_id: z.union([z.string(), z.number()]),
		id: z.string(),
		name: z.string(),
	})
	.passthrough();

const targetingSchema = z
	.record(z.string(), z.unknown())
	.refine((value) => JSON.stringify(value).length <= 50_000, {
		message: "targeting must be at most 50,000 serialized characters.",
	});

const promotedObjectSchema = z
	.record(z.string(), z.unknown())
	.refine((value) => JSON.stringify(value).length <= 20_000, {
		message: "promoted_object must be at most 20,000 serialized characters.",
	});

const leadFormQuestionSchema = z
	.object({
		key: z.string().min(1).max(100).optional(),
		label: z.string().min(1).max(500).optional(),
		options: z.array(z.string().min(1).max(500)).min(2).max(20).optional(),
		type: z.enum(["CITY", "CUSTOM", "EMAIL", "FULL_NAME", "PHONE", "STATE"]),
	})
	.strict();

function getMetaConfig(env: MetaEnv) {
	const accessToken = env.META_ACCESS_TOKEN?.trim();
	const rawAccountId = env.META_AD_ACCOUNT_ID?.trim();
	const apiVersion = env.META_API_VERSION?.trim() || DEFAULT_META_API_VERSION;

	if (!accessToken) {
		throw new Error("META_ACCESS_TOKEN is not configured in Worker secrets.");
	}
	if (!rawAccountId) {
		throw new Error("META_AD_ACCOUNT_ID is not configured in Worker variables.");
	}
	if (!/^v\d+\.\d+$/.test(apiVersion)) {
		throw new Error("META_API_VERSION must use a value such as v26.0.");
	}

	const accountId = rawAccountId.startsWith("act_")
		? rawAccountId
		: `act_${rawAccountId}`;
	if (!/^act_\d+$/.test(accountId)) {
		throw new Error("META_AD_ACCOUNT_ID must contain only the numeric ad account ID.");
	}

	return {
		accessToken,
		accountId,
		accountNumericId: accountId.slice(4),
		apiVersion,
	};
}

function assertWritesEnabled(env: MetaEnv) {
	if (env.META_WRITE_ENABLED?.trim().toLowerCase() !== "true") {
		throw new Error(
			"Meta write tools are disabled by META_WRITE_ENABLED. Enable only after ads_management is granted.",
		);
	}
}

function safeMetaError(payload: MetaGraphErrorPayload, status: number) {
	const metaError = payload.error;
	if (!metaError) return `Meta API returned HTTP ${status}.`;
	return [
		metaError.error_user_title,
		metaError.error_user_msg,
		metaError.message,
		metaError.type ? `type=${metaError.type}` : undefined,
		metaError.code !== undefined ? `code=${metaError.code}` : undefined,
		metaError.error_subcode !== undefined
			? `subcode=${metaError.error_subcode}`
			: undefined,
	]
		.filter(Boolean)
		.join(" | ")
		.slice(0, 800);
}

function encodeMetaValue(value: string | number | boolean | object) {
	return typeof value === "object" ? JSON.stringify(value) : String(value);
}

async function callMetaGraph(
	env: MetaEnv,
	method: "GET" | "POST",
	path: string,
	params: Record<string, string | number | boolean | object>,
): Promise<unknown> {
	const { accessToken, apiVersion } = getMetaConfig(env);
	const cleanPath = path.replace(/^\/+/, "");
	const url = new URL(`/${apiVersion}/${cleanPath}`, META_GRAPH_ORIGIN);
	const headers = new Headers({
		Accept: "application/json",
		Authorization: `Bearer ${accessToken}`,
	});
	const requestInit: RequestInit = { headers, method };

	if (method === "GET") {
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, encodeMetaValue(value));
		}
	} else {
		const body = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			body.set(key, encodeMetaValue(value));
		}
		headers.set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
		requestInit.body = body;
	}

	const response = await fetch(url, requestInit);
	const rawBody = await response.text();
	let payload: unknown;
	try {
		payload = JSON.parse(rawBody);
	} catch {
		throw new Error(`Meta API returned a non-JSON HTTP ${response.status} response.`);
	}

	const parsedError = z
		.object({
			error: z
				.object({
					code: z.number().optional(),
					error_user_msg: z.string().optional(),
					error_user_title: z.string().optional(),
					error_subcode: z.number().optional(),
					fbtrace_id: z.string().optional(),
					message: z.string().optional(),
					type: z.string().optional(),
				})
				.optional(),
		})
		.passthrough()
		.safeParse(payload);
	const errorPayload = parsedError.success ? parsedError.data : {};
	if (!response.ok || errorPayload.error) {
		throw new Error(safeMetaError(errorPayload, response.status));
	}
	return payload;
}

async function assertAccessiblePage(env: MetaEnv, pageId: string) {
	const pages = graphListSchema.parse(
		await callMetaGraph(env, "GET", "me/accounts", {
			fields: "id,name,tasks",
			limit: 100,
		}),
	).data;
	const page = pages.find((item) => String(item.id || "") === pageId);
	if (!page) throw new Error(`Page ${pageId} is not accessible to the configured token.`);
	const tasks = Array.isArray(page.tasks) ? page.tasks.map(String) : [];
	if (!tasks.includes("ADVERTISE") || !tasks.includes("MANAGE_LEADS")) {
		throw new Error(`Page ${pageId} requires ADVERTISE and MANAGE_LEADS access.`);
	}
	return page;
}

async function getOwnedObject(
	env: MetaEnv,
	objectType: OwnedObjectType,
	objectId: string,
) {
	if (!META_ID_PATTERN.test(objectId)) {
		throw new Error(`${objectType.toLowerCase()}_id must contain only digits.`);
	}
	const fieldsByType: Record<OwnedObjectType, string> = {
		AD: "id,name,account_id,status,effective_status,adset_id,campaign_id,creative",
		ADSET:
			"id,name,account_id,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,destination_type,promoted_object",
		CAMPAIGN:
			"id,name,account_id,status,effective_status,objective,daily_budget,lifetime_budget,bid_strategy",
	};
	const snapshot = objectSchema.parse(
		await callMetaGraph(env, "GET", objectId, {
			fields: fieldsByType[objectType],
		}),
	);
	const { accountNumericId } = getMetaConfig(env);
	if (String(snapshot.account_id).replace(/^act_/, "") !== accountNumericId) {
		throw new Error(
			`${objectType} ${objectId} does not belong to the configured ad account.`,
		);
	}
	return snapshot;
}

function assertExpectedName(snapshot: z.infer<typeof objectSchema>, expectedName: string) {
	if (snapshot.name !== expectedName) {
		throw new Error(
			`Name mismatch. Expected exactly "${snapshot.name}" for object ${snapshot.id}.`,
		);
	}
}

function assertConfirmation(actual: string, expected: string) {
	if (actual !== expected) {
		throw new Error(`Confirmation mismatch. Use exactly: ${expected}`);
	}
}

function getPromotedPageId(snapshot: z.infer<typeof objectSchema>) {
	const promotedObject = snapshot.promoted_object;
	if (!promotedObject || typeof promotedObject !== "object") {
		throw new Error(`Ad set ${snapshot.id} does not have a promoted page.`);
	}
	const pageId = String((promotedObject as Record<string, unknown>).page_id || "");
	if (!META_ID_PATTERN.test(pageId)) {
		throw new Error(`Ad set ${snapshot.id} does not have a valid promoted page_id.`);
	}
	return pageId;
}

function buildWhatsAppLink(phoneNumber: string, prefilledMessage: string) {
	return `https://wa.me/${phoneNumber}?text=${encodeURIComponent(prefilledMessage)}`;
}

function pagingCursors(paging?: MetaPaging) {
	if (!paging?.cursors) return undefined;
	return { after: paging.cursors.after, before: paging.cursors.before };
}

function asToolResult(value: unknown) {
	return {
		content: [{ text: JSON.stringify(value, null, 2), type: "text" as const }],
	};
}

function asToolError(error: unknown) {
	const message = error instanceof Error ? error.message : "Unexpected Meta API error.";
	const redactedMessage = message
		.replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
		.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
		.slice(0, 1_000);
	return {
		content: [{ text: redactedMessage, type: "text" as const }],
		isError: true,
	};
}

function isoDateDaysAgo(daysAgo: number) {
	const date = new Date();
	date.setUTCDate(date.getUTCDate() - daysAgo);
	return date.toISOString().slice(0, 10);
}

function resolveTimeRange(since?: string, until?: string) {
	if ((since && !until) || (!since && until)) {
		throw new Error("Provide both since and until, or omit both for the last 7 days.");
	}
	const resolvedSince = since || isoDateDaysAgo(6);
	const resolvedUntil = until || isoDateDaysAgo(0);
	if (!ISO_DATE_PATTERN.test(resolvedSince) || !ISO_DATE_PATTERN.test(resolvedUntil)) {
		throw new Error("Dates must use YYYY-MM-DD.");
	}
	if (resolvedSince > resolvedUntil) {
		throw new Error("since must be earlier than or equal to until.");
	}
	return { since: resolvedSince, until: resolvedUntil };
}

function setOptionalBudget(
	params: Record<string, string | number | boolean | object>,
	dailyBudget?: number,
	lifetimeBudget?: number,
) {
	if (dailyBudget !== undefined && lifetimeBudget !== undefined) {
		throw new Error("Use daily_budget_minor or lifetime_budget_minor, never both.");
	}
	if (dailyBudget !== undefined) params.daily_budget = dailyBudget;
	if (lifetimeBudget !== undefined) params.lifetime_budget = lifetimeBudget;
}

function auditMutation(operation: string, details: Record<string, unknown>) {
	console.log(
		JSON.stringify({
			event: "meta_ads_mutation",
			operation,
			timestamp: new Date().toISOString(),
			...details,
		}),
	);
}

async function runIdempotentCreate(
	env: MetaEnv,
	operation: string,
	requestId: string,
	create: () => Promise<unknown>,
) {
	const key = `meta-write:${operation}:${requestId}`;
	const cached = await env.OAUTH_KV.get(key, "json");
	if (cached !== null) return { idempotent_replay: true, result: cached };
	const result = await create();
	await env.OAUTH_KV.put(key, JSON.stringify(result), {
		expirationTtl: IDEMPOTENCY_TTL_SECONDS,
	});
	return { idempotent_replay: false, result };
}

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({ name: "Meta Ads Stoicus Secure", version: CONNECTOR_VERSION });

	async init() {
		this.server.registerTool(
			"meta_get_ad_account",
			{
				annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true },
				description:
					"Read-only. Confirm the configured Meta ad account, status, currency, and timezone. Optionally inspect bounded job-title diagnostics or saved/custom audience metadata. Never retrieves audience members or changes targeting or ads.",
				inputSchema: {
					work_position_queries: z.array(z.string().trim().min(2).max(80)).min(1).max(5).optional(),
					work_position_ids: z.array(z.string().regex(META_ID_PATTERN)).min(1).max(20).optional(),
					audience_inventory: z.object({
						kind: z.enum(["saved", "custom"]),
						after: z.string().max(2_000).optional(),
						limit: z.number().int().min(1).max(100).default(100),
					}).strict().optional(),
				},
			},
			async ({ work_position_queries, work_position_ids, audience_inventory }) => {
				try {
					const env = this.env as MetaEnv;
					const { accountId, apiVersion } = getMetaConfig(env);
					const account = await callMetaGraph(env, "GET", accountId, {
						fields: "id,name,account_status,currency,timezone_name",
					});
					const workPositionSearch = work_position_queries
						? await Promise.all(work_position_queries.map(async (query) => {
							try {
								const response = graphListSchema.parse(await callMetaGraph(env, "GET", `${accountId}/targetingsearch`, {
									q: query, countries: ["BR"], limit_type: "work_positions",
									whitelisted_types: ["work_positions"], limit: 20,
									objective: "OUTCOME_ENGAGEMENT", optimization_goal: "CONVERSATIONS",
								}));
								return { query, results: response.data, paging: pagingCursors(response.paging) };
							} catch (error) {
								return { query, diagnostic_error: asToolError(error).content[0].text };
							}
						})) : undefined;
					let workPositionValidation: Record<string, unknown> | undefined;
					if (work_position_ids) {
						try {
							const response = graphListSchema.parse(await callMetaGraph(env, "GET", `${accountId}/targetingvalidation`, {
								targeting_list: work_position_ids.map((id) => ({ type: "work_positions", id })),
							}));
							workPositionValidation = { results: response.data };
						} catch (error) {
							workPositionValidation = { diagnostic_error: asToolError(error).content[0].text };
						}
					}
					let audienceInventory: Record<string, unknown> | undefined;
					if (audience_inventory) {
						try {
							const isSaved = audience_inventory.kind === "saved";
							const params: Record<string, string | number | boolean | object> = {
								fields: isSaved
									? "id,name,description,targeting,approximate_count_lower_bound,approximate_count_upper_bound,operation_status,run_status,time_created,time_updated"
									: "id,name,description,subtype,delivery_status,operation_status,approximate_count_lower_bound,approximate_count_upper_bound,data_source,customer_file_source,rule,time_created,time_updated",
								limit: audience_inventory.limit,
							};
							if (audience_inventory.after) params.after = audience_inventory.after;
							const response = graphListSchema.parse(await callMetaGraph(
								env, "GET", `${accountId}/${isSaved ? "saved_audiences" : "customaudiences"}`, params,
							));
							audienceInventory = {
								kind: audience_inventory.kind, audiences: response.data,
								paging: pagingCursors(response.paging), has_next: Boolean(response.paging?.next),
							};
						} catch (error) {
							audienceInventory = { kind: audience_inventory.kind, diagnostic_error: asToolError(error).content[0].text };
						}
					}
					return asToolResult({
						api_version: apiVersion, connector_version: CONNECTOR_VERSION, account,
						work_position_search: workPositionSearch,
						work_position_validation: workPositionValidation,
						audience_inventory: audienceInventory,
					});
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_get_token_permissions",
			{
				annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true },
				description:
					"Read-only. Check ads_read and ads_management without exposing the Meta token.",
				inputSchema: {},
			},
			async () => {
				try {
					const env = this.env as MetaEnv;
					const { accountId } = getMetaConfig(env);
					const [permissionResponse, tokenSubject] = await Promise.all([
						callMetaGraph(env, "GET", "me/permissions", {}),
						callMetaGraph(env, "GET", "me", { fields: "id,name" }),
					]);
					const payload = graphListSchema.parse(permissionResponse);
					let accessiblePages: Array<Record<string, unknown>> = [];
					let pageAccessError: string | undefined;
					try {
						const pageResponse = graphListSchema.parse(
							await callMetaGraph(env, "GET", "me/accounts", {
								fields: "id,name,tasks",
								limit: 100,
							}),
						);
						accessiblePages = pageResponse.data;
					} catch (error) {
						pageAccessError = error instanceof Error ? error.message : "Unable to list Pages.";
					}
					// Inspect only Pages already returned by the configured token. These
					// read-only diagnostics must never invalidate the permissions result.
					const pageWhatsappDiagnostics = await Promise.all(
						accessiblePages.map(async (page) => {
							const pageId = String(page.id || "");
							try {
								const details = await callMetaGraph(env, "GET", pageId, {
									fields: "id,whatsapp_number,has_whatsapp_number,has_whatsapp_business_number",
								});
								return { page_id: pageId, ...z.record(z.string(), z.unknown()).parse(details) };
							} catch (error) {
								return {
									page_id: pageId,
									diagnostic_error: asToolError(error).content[0].text,
								};
							}
						}),
					);
					let whatsappAssetDiagnostics: Record<string, unknown> = {};
					try {
						const account = z
							.object({ business: z.object({ id: z.string(), name: z.string().optional() }).optional() })
							.passthrough()
							.parse(
								await callMetaGraph(env, "GET", accountId, {
									fields: "business{id,name}",
								}),
							);
						if (account.business) {
							const [ownedResponse, clientResponse] = await Promise.allSettled([
								callMetaGraph(
									env,
									"GET",
									`${account.business.id}/owned_whatsapp_business_accounts`,
									{ fields: "id,name", limit: 100 },
								),
								callMetaGraph(
									env,
									"GET",
									`${account.business.id}/client_whatsapp_business_accounts`,
									{ fields: "id,name", limit: 100 },
								),
							]);
							whatsappAssetDiagnostics = {
								business: account.business,
								owned_whatsapp_business_accounts:
									ownedResponse.status === "fulfilled"
										? graphListSchema.parse(ownedResponse.value).data
										: [],
								owned_whatsapp_business_accounts_error:
									ownedResponse.status === "rejected"
										? ownedResponse.reason instanceof Error
											? ownedResponse.reason.message
											: "Unable to list owned WhatsApp Business Accounts."
										: undefined,
								client_whatsapp_business_accounts:
									clientResponse.status === "fulfilled"
										? graphListSchema.parse(clientResponse.value).data
										: [],
								client_whatsapp_business_accounts_error:
									clientResponse.status === "rejected"
										? clientResponse.reason instanceof Error
											? clientResponse.reason.message
											: "Unable to list shared WhatsApp Business Accounts."
										: undefined,
							};
						} else {
							whatsappAssetDiagnostics = {
								whatsapp_asset_error: "The configured ad account has no Business Portfolio attached.",
							};
						}
					} catch (error) {
						whatsappAssetDiagnostics = {
							whatsapp_asset_error:
								error instanceof Error ? error.message : "Unable to inspect WhatsApp Business assets.",
						};
					}
					const permissions = payload.data.map((item) => ({
						permission: item.permission,
						status: item.status,
					}));
					const granted = new Set(
						permissions
							.filter((item) => item.status === "granted")
							.map((item) => item.permission),
					);
					return asToolResult({
						connector_version: CONNECTOR_VERSION,
						accessible_pages: accessiblePages,
						page_access_error: pageAccessError,
						page_whatsapp_diagnostics: pageWhatsappDiagnostics,
						whatsapp_assets: whatsappAssetDiagnostics,
						permissions,
						ready_for_reads: granted.has("ads_read") || granted.has("ads_management"),
						ready_for_writes: granted.has("ads_management"),
						write_switch_enabled:
							env.META_WRITE_ENABLED?.trim().toLowerCase() === "true",
						token_subject: tokenSubject,
					});
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_list_campaigns",
			{
				annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true },
				description: "Read-only. List campaigns from the configured Meta ad account.",
				inputSchema: {
					after: z.string().max(2_000).optional(),
					effective_status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]).optional(),
					limit: z.number().int().min(1).max(100).default(25),
				},
			},
			async ({ after, effective_status, limit }) => {
				try {
					const env = this.env as MetaEnv;
					const { accountId } = getMetaConfig(env);
					const params: Record<string, string | number | object> = {
						fields:
							"id,name,status,effective_status,objective,daily_budget,lifetime_budget,bid_strategy,start_time,stop_time,created_time,updated_time",
						limit,
					};
					if (after) params.after = after;
					if (effective_status) params.effective_status = [effective_status];
					const response = graphListSchema.parse(
						await callMetaGraph(env, "GET", `${accountId}/campaigns`, params),
					);
					return asToolResult({
						campaigns: response.data,
						paging: pagingCursors(response.paging),
					});
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_list_adsets",
			{
				annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true },
				description:
					"Read-only. List ad sets from the configured account or one owned campaign.",
				inputSchema: {
					after: z.string().max(2_000).optional(),
					campaign_id: z.string().regex(META_ID_PATTERN).optional(),
					limit: z.number().int().min(1).max(100).default(25),
				},
			},
			async ({ after, campaign_id, limit }) => {
				try {
					const env = this.env as MetaEnv;
					const { accountId } = getMetaConfig(env);
					if (campaign_id) await getOwnedObject(env, "CAMPAIGN", campaign_id);
					const params: Record<string, string | number> = {
						fields:
							"id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy,destination_type,targeting,promoted_object,start_time,end_time,created_time,updated_time",
						limit,
					};
					if (after) params.after = after;
					const response = graphListSchema.parse(
						await callMetaGraph(env, "GET", `${campaign_id || accountId}/adsets`, params),
					);
					return asToolResult({
						adsets: response.data,
						paging: pagingCursors(response.paging),
					});
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_list_ads",
			{
				annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true },
				description:
					"Read-only. List ads from the configured account or one owned campaign/ad set.",
				inputSchema: {
					adset_id: z.string().regex(META_ID_PATTERN).optional(),
					after: z.string().max(2_000).optional(),
					campaign_id: z.string().regex(META_ID_PATTERN).optional(),
					limit: z.number().int().min(1).max(100).default(25),
				},
			},
			async ({ adset_id, after, campaign_id, limit }) => {
				try {
					if (adset_id && campaign_id) {
						throw new Error("Use adset_id or campaign_id, never both.");
					}
					const env = this.env as MetaEnv;
					const { accountId } = getMetaConfig(env);
					if (adset_id) await getOwnedObject(env, "ADSET", adset_id);
					if (campaign_id) await getOwnedObject(env, "CAMPAIGN", campaign_id);
					const params: Record<string, string | number> = {
						fields:
							"id,name,adset_id,campaign_id,status,effective_status,creative{id,name,object_story_spec,image_hash,thumbnail_url},created_time,updated_time",
						limit,
					};
					if (after) params.after = after;
					const response = graphListSchema.parse(
						await callMetaGraph(
							env,
							"GET",
							`${adset_id || campaign_id || accountId}/ads`,
							params,
						),
					);
					return asToolResult({
						ads: response.data,
						paging: pagingCursors(response.paging),
					});
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_get_ad_creative_details",
			{
				annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true },
				description:
					"Read-only. Return creative structure for one owned ad after exact-name verification. Useful for safely reproducing a proven account-native format.",
				inputSchema: {
					ad_id: z.string().regex(META_ID_PATTERN),
					expected_ad_name: z.string().min(1).max(500),
				},
			},
			async ({ ad_id, expected_ad_name }) => {
				try {
					const env = this.env as MetaEnv;
					const ad = await getOwnedObject(env, "AD", ad_id);
					assertExpectedName(ad, expected_ad_name);
					const creative = ad.creative;
					if (!creative || typeof creative !== "object") {
						throw new Error(`Ad ${ad_id} does not have a readable creative.`);
					}
					const creativeId = String((creative as Record<string, unknown>).id || "");
					if (!META_ID_PATTERN.test(creativeId)) {
						throw new Error(`Ad ${ad_id} does not have a valid creative ID.`);
					}
					const details = await callMetaGraph(env, "GET", creativeId, {
						fields:
							"id,name,account_id,object_story_spec,effective_object_story_id,source_instagram_media_id,asset_feed_spec,thumbnail_url,video_id",
					});
					return asToolResult({ ad_id, creative: details });
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_list_page_video_assets",
			{
				annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true },
				description:
					"Read-only. List Facebook Page videos and connected Instagram media for the promoted page of one owned ad set.",
				inputSchema: {
					after: z.string().max(2_000).optional(),
					expected_adset_name: z.string().min(1).max(500),
					instagram_after: z.string().max(2_000).optional(),
					limit: z.number().int().min(1).max(100).default(25),
					reference_adset_id: z.string().regex(META_ID_PATTERN),
				},
			},
			async ({ after, expected_adset_name, instagram_after, limit, reference_adset_id }) => {
				try {
					const env = this.env as MetaEnv;
					const adset = await getOwnedObject(env, "ADSET", reference_adset_id);
					assertExpectedName(adset, expected_adset_name);
					const pageId = getPromotedPageId(adset);
					const page = z
						.object({
							id: z.string(),
							instagram_business_account: z
								.object({ id: z.string(), username: z.string().optional() })
								.optional(),
							name: z.string().optional(),
						})
						.passthrough()
						.parse(
							await callMetaGraph(env, "GET", pageId, {
								fields: "id,name,instagram_business_account{id,username}",
							}),
						);
					const pageVideoParams: Record<string, string | number> = {
						fields: "id,title,description,created_time,permalink_url,status",
						limit,
					};
					if (after) pageVideoParams.after = after;
					const pageVideos = graphListSchema.parse(
						await callMetaGraph(env, "GET", `${pageId}/videos`, pageVideoParams),
					);
					let instagramMedia:
						| { media: Array<Record<string, unknown>>; paging?: ReturnType<typeof pagingCursors> }
						| undefined;
					const instagramId = page.instagram_business_account?.id;
					if (instagramId && META_ID_PATTERN.test(instagramId)) {
						const instagramParams: Record<string, string | number> = {
							fields:
								"id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,timestamp",
							limit,
						};
						if (instagram_after) instagramParams.after = instagram_after;
						const response = graphListSchema.parse(
							await callMetaGraph(env, "GET", `${instagramId}/media`, instagramParams),
						);
						instagramMedia = {
							media: response.data,
							paging: pagingCursors(response.paging),
						};
					}
					return asToolResult({
						instagram_account: page.instagram_business_account,
						instagram_media: instagramMedia,
						page: { id: page.id, name: page.name },
						page_videos: {
							paging: pagingCursors(pageVideos.paging),
							videos: pageVideos.data,
						},
					});
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_get_campaign_insights",
			{
				annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true },
				description:
					"Read-only. Return campaign performance for an explicit range or the last 7 days.",
				inputSchema: {
					after: z.string().max(2_000).optional(),
					limit: z.number().int().min(1).max(100).default(50),
					since: z.string().optional(),
					until: z.string().optional(),
				},
			},
			async ({ after, limit, since, until }) => {
				try {
					const env = this.env as MetaEnv;
					const { accountId } = getMetaConfig(env);
					const timeRange = resolveTimeRange(since, until);
					const params: Record<string, string | number | object> = {
						fields:
							"date_start,date_stop,campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpc,cpm,actions,cost_per_action_type",
						level: "campaign",
						limit,
						time_range: timeRange,
					};
					if (after) params.after = after;
					const response = graphListSchema.parse(
						await callMetaGraph(env, "GET", `${accountId}/insights`, params),
					);
					return asToolResult({
						insights: response.data,
						paging: pagingCursors(response.paging),
						time_range: timeRange,
					});
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_set_delivery_status",
			{
				annotations: {
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
					readOnlyHint: false,
				},
				description:
					"WRITE. Pause or activate one owned campaign, ad set, or ad. Exact name, exact confirmation, and read-before-write are required.",
				inputSchema: {
					confirmation_phrase: z.string().max(500),
					expected_name: z.string().min(1).max(500),
					object_id: z.string().regex(META_ID_PATTERN),
					object_type: z.enum(["CAMPAIGN", "ADSET", "AD"]),
					status: z.enum(["ACTIVE", "PAUSED"]),
				},
			},
			async ({ confirmation_phrase, expected_name, object_id, object_type, status }) => {
				try {
					const env = this.env as MetaEnv;
					assertWritesEnabled(env);
					const before = await getOwnedObject(env, object_type, object_id);
					assertExpectedName(before, expected_name);
					assertConfirmation(
						confirmation_phrase,
						`SET ${object_type} ${object_id} ${status}`,
					);
					const result = writeResponseSchema.parse(
						await callMetaGraph(env, "POST", object_id, { status }),
					);
					const after = await getOwnedObject(env, object_type, object_id);
					auditMutation("set_delivery_status", {
						object_id,
						object_type,
						status,
					});
					return asToolResult({ before, result, after });
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_update_budget",
			{
				annotations: {
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
					readOnlyHint: false,
				},
				description:
					"WRITE. Set one campaign/ad-set budget in minor units (centavos for BRL). Exact name, confirmation, and read-before-write are required.",
				inputSchema: {
					budget_minor: z.number().int().min(100).max(10_000_000),
					budget_type: z.enum(["DAILY", "LIFETIME"]),
					confirmation_phrase: z.string().max(500),
					expected_name: z.string().min(1).max(500),
					object_id: z.string().regex(META_ID_PATTERN),
					object_type: z.enum(["CAMPAIGN", "ADSET"]),
				},
			},
			async ({
				budget_minor,
				budget_type,
				confirmation_phrase,
				expected_name,
				object_id,
				object_type,
			}) => {
				try {
					const env = this.env as MetaEnv;
					assertWritesEnabled(env);
					const before = await getOwnedObject(env, object_type, object_id);
					assertExpectedName(before, expected_name);
					assertConfirmation(
						confirmation_phrase,
						`SET BUDGET ${object_type} ${object_id} ${budget_type} ${budget_minor}`,
					);
					const budgetField = budget_type === "DAILY" ? "daily_budget" : "lifetime_budget";
					const result = writeResponseSchema.parse(
						await callMetaGraph(env, "POST", object_id, {
							[budgetField]: budget_minor,
						}),
					);
					const after = await getOwnedObject(env, object_type, object_id);
					auditMutation("update_budget", {
						budget_minor,
						budget_type,
						object_id,
						object_type,
					});
					return asToolResult({ before, result, after });
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_create_campaign_draft",
			{
				annotations: {
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
					readOnlyHint: false,
				},
				description:
					"WRITE/PREVIEW. Validate or create one campaign. Real creation is always PAUSED and requires exact confirmation plus request_id.",
				inputSchema: {
					bid_strategy: z
						.enum([
							"LOWEST_COST_WITHOUT_CAP",
							"LOWEST_COST_WITH_BID_CAP",
							"COST_CAP",
						])
						.optional(),
					confirmation_phrase: z.string().max(500).optional(),
					daily_budget_minor: z.number().int().min(100).max(10_000_000).optional(),
					lifetime_budget_minor: z
						.number()
						.int()
						.min(100)
						.max(100_000_000)
						.optional(),
					name: z.string().min(1).max(500),
					objective: z.enum([
						"OUTCOME_AWARENESS",
						"OUTCOME_ENGAGEMENT",
						"OUTCOME_LEADS",
						"OUTCOME_SALES",
						"OUTCOME_TRAFFIC",
						"OUTCOME_APP_PROMOTION",
					]),
					request_id: z.string().uuid(),
					special_ad_categories: z
						.array(
							z.enum([
								"CREDIT",
								"EMPLOYMENT",
								"HOUSING",
								"ISSUES_ELECTIONS_POLITICS",
							]),
						)
						.max(4)
						.default([]),
					validate_only: z.boolean().default(true),
				},
			},
			async ({
				bid_strategy,
				confirmation_phrase,
				daily_budget_minor,
				lifetime_budget_minor,
				name,
				objective,
				request_id,
				special_ad_categories,
				validate_only,
			}) => {
				try {
					const env = this.env as MetaEnv;
					assertWritesEnabled(env);
					const { accountId } = getMetaConfig(env);
					const params: Record<string, string | number | boolean | object> = {
						buying_type: "AUCTION",
						name,
						objective,
						special_ad_categories,
						status: "PAUSED",
					};
					if (bid_strategy) params.bid_strategy = bid_strategy;
					setOptionalBudget(params, daily_budget_minor, lifetime_budget_minor);
					if (validate_only) {
						params.execution_options = ["validate_only", "include_recommendations"];
						const validation = await callMetaGraph(
							env,
							"POST",
							`${accountId}/campaigns`,
							params,
						);
						return asToolResult({
							mode: "validate_only",
							status_for_create: "PAUSED",
							validation,
						});
					}
					assertConfirmation(confirmation_phrase || "", `CREATE CAMPAIGN ${name}`);
					const created = await runIdempotentCreate(
						env,
						"campaign",
						request_id,
						async () =>
							writeResponseSchema.parse(
								await callMetaGraph(env, "POST", `${accountId}/campaigns`, params),
							),
					);
					auditMutation("create_campaign", { name, request_id, status: "PAUSED" });
					return asToolResult(created);
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_create_adset_draft",
			{
				annotations: {
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
					readOnlyHint: false,
				},
				description:
					"WRITE/PREVIEW. Validate or create one ad set under an owned campaign. Real creation is always PAUSED and requires exact confirmation.",
				inputSchema: {
					bid_strategy: z
						.enum([
							"LOWEST_COST_WITHOUT_CAP",
							"LOWEST_COST_WITH_BID_CAP",
							"COST_CAP",
						])
						.optional(),
					billing_event: z.enum(["IMPRESSIONS", "LINK_CLICKS"]),
					campaign_id: z.string().regex(META_ID_PATTERN),
					confirmation_phrase: z.string().max(700).optional(),
					daily_budget_minor: z.number().int().min(100).max(10_000_000).optional(),
					destination_type: z.enum(["WEBSITE", "WHATSAPP"]).optional(),
					end_time: z.string().max(100).optional(),
					expected_campaign_name: z.string().min(1).max(500),
					lifetime_budget_minor: z
						.number()
						.int()
						.min(100)
						.max(100_000_000)
						.optional(),
					name: z.string().min(1).max(500),
					optimization_goal: z.enum([
						"CONVERSATIONS",
						"IMPRESSIONS",
						"LANDING_PAGE_VIEWS",
						"LEAD_GENERATION",
						"LINK_CLICKS",
						"OFFSITE_CONVERSIONS",
						"REACH",
					]),
					promoted_object: promotedObjectSchema.optional(),
					request_id: z.string().uuid(),
					start_time: z.string().max(100).optional(),
					targeting: targetingSchema,
					validate_only: z.boolean().default(true),
				},
			},
			async ({
				bid_strategy,
				billing_event,
				campaign_id,
				confirmation_phrase,
				daily_budget_minor,
				destination_type,
				end_time,
				expected_campaign_name,
				lifetime_budget_minor,
				name,
				optimization_goal,
				promoted_object,
				request_id,
				start_time,
				targeting,
				validate_only,
			}) => {
				try {
					const env = this.env as MetaEnv;
					assertWritesEnabled(env);
					const { accountId } = getMetaConfig(env);
					const campaign = await getOwnedObject(env, "CAMPAIGN", campaign_id);
					assertExpectedName(campaign, expected_campaign_name);
					const promotedObjectForMeta = promoted_object
						? { ...promoted_object }
						: undefined;
					const compatibilityWhatsappPhone = String(
						promotedObjectForMeta?.whatsapp_phone_number || "",
					);
					if (compatibilityWhatsappPhone) {
						if (!/^\d{10,15}$/.test(compatibilityWhatsappPhone)) {
							throw new Error("promoted_object.whatsapp_phone_number must contain 10 to 15 digits.");
						}
						if (String(campaign.objective || "") !== "OUTCOME_ENGAGEMENT") {
							throw new Error("WhatsApp conversations require an OUTCOME_ENGAGEMENT campaign.");
						}
						// This is a real Graph API field, not a helper-only marker.
						// Preserve the selected phone so Meta does not resolve a different
						// default number on a Page that has multiple linked numbers.
					}
					const resolvedOptimizationGoal = compatibilityWhatsappPhone
						? "CONVERSATIONS"
						: optimization_goal;
					const resolvedDestinationType = compatibilityWhatsappPhone
						? "WHATSAPP"
						: destination_type;
					const params: Record<string, string | number | boolean | object> = {
						billing_event,
						campaign_id,
						name,
						optimization_goal: resolvedOptimizationGoal,
						status: "PAUSED",
						targeting,
					};
					setOptionalBudget(params, daily_budget_minor, lifetime_budget_minor);
					if (bid_strategy) params.bid_strategy = bid_strategy;
					if (resolvedDestinationType) {
						params.destination_type = resolvedDestinationType;
					} else if (
						resolvedOptimizationGoal === "LANDING_PAGE_VIEWS" ||
						resolvedOptimizationGoal === "LINK_CLICKS"
					) {
						params.destination_type = "WEBSITE";
					}
					if (promotedObjectForMeta) params.promoted_object = promotedObjectForMeta;
					if (start_time) params.start_time = start_time;
					if (end_time) params.end_time = end_time;
					if (validate_only) {
						params.execution_options = ["validate_only", "include_recommendations"];
						const validation = await callMetaGraph(
							env,
							"POST",
							`${accountId}/adsets`,
							params,
						);
						return asToolResult({
							mode: "validate_only",
							status_for_create: "PAUSED",
							validation,
						});
					}
					assertConfirmation(
						confirmation_phrase || "",
						`CREATE ADSET ${campaign_id} ${name}`,
					);
					const created = await runIdempotentCreate(
						env,
						"adset",
						request_id,
						async () =>
							writeResponseSchema.parse(
								await callMetaGraph(env, "POST", `${accountId}/adsets`, params),
							),
					);
					auditMutation("create_adset", {
						campaign_id,
						name,
						request_id,
						status: "PAUSED",
					});
					return asToolResult(created);
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_create_ad_draft",
			{
				annotations: {
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
					readOnlyHint: false,
				},
				description:
					"WRITE/PREVIEW. Validate or create one PAUSED link ad under an owned ad set using an inline image creative. Exact confirmation is required for creation.",
				inputSchema: {
					adset_id: z.string().regex(META_ID_PATTERN),
					call_to_action_type: z
						.enum([
							"APPLY_NOW",
							"BOOK_NOW",
							"CONTACT_US",
							"DOWNLOAD",
							"GET_QUOTE",
							"LEARN_MORE",
							"REGISTER_NOW",
							"SHOP_NOW",
							"SIGN_UP",
							"SUBSCRIBE",
						])
						.default("LEARN_MORE"),
					confirmation_phrase: z.string().max(700).optional(),
					description: z.string().max(1_000).optional(),
					expected_adset_name: z.string().min(1).max(500),
					headline: z.string().min(1).max(500),
					image_hash: z.string().max(500).optional(),
					instagram_actor_id: z.string().regex(META_ID_PATTERN).optional(),
					link_url: z.string().url().max(2_000),
					message: z.string().min(1).max(5_000),
					name: z.string().min(1).max(500),
					page_id: z.string().regex(META_ID_PATTERN),
					picture_url: z.string().url().max(2_000).optional(),
					request_id: z.string().uuid(),
					validate_only: z.boolean().default(true),
				},
			},
			async ({
				adset_id,
				call_to_action_type,
				confirmation_phrase,
				description,
				expected_adset_name,
				headline,
				image_hash,
				instagram_actor_id,
				link_url,
				message,
				name,
				page_id,
				picture_url,
				request_id,
				validate_only,
			}) => {
				try {
					if ((image_hash && picture_url) || (!image_hash && !picture_url)) {
						throw new Error("Provide exactly one of image_hash or picture_url.");
					}
					const env = this.env as MetaEnv;
					assertWritesEnabled(env);
					const { accountId } = getMetaConfig(env);
					const adset = await getOwnedObject(env, "ADSET", adset_id);
					assertExpectedName(adset, expected_adset_name);
					const parsedLink = new URL(link_url);
					const isWhatsAppLink = parsedLink.hostname.toLowerCase() === "wa.me";
					if (isWhatsAppLink) {
						if (String(adset.destination_type || "") !== "WHATSAPP") {
							throw new Error(`Ad set ${adset_id} must use destination_type WHATSAPP.`);
						}
						if (getPromotedPageId(adset) !== page_id) {
							throw new Error(`page_id must match the promoted page on ad set ${adset_id}.`);
						}
					}
					const linkData: Record<string, unknown> = {
						call_to_action: {
							type: isWhatsAppLink ? "WHATSAPP_MESSAGE" : call_to_action_type,
							value: isWhatsAppLink
								? { app_destination: "WHATSAPP", link: link_url }
								: { link: link_url },
						},
						link: link_url,
						message,
						name: headline,
					};
					if (description) linkData.description = description;
					if (image_hash) linkData.image_hash = image_hash;
					if (picture_url) linkData.picture = picture_url;
					const objectStorySpec: Record<string, unknown> = {
						link_data: linkData,
						page_id,
					};
					if (instagram_actor_id) objectStorySpec.instagram_actor_id = instagram_actor_id;
					const params: Record<string, string | number | boolean | object> = {
						adset_id,
						creative: { object_story_spec: objectStorySpec },
						name,
						status: "PAUSED",
					};
					if (validate_only) {
						params.execution_options = ["validate_only", "include_recommendations"];
						const validation = await callMetaGraph(env, "POST", `${accountId}/ads`, params);
						return asToolResult({
							mode: "validate_only",
							status_for_create: "PAUSED",
							validation,
						});
					}
					assertConfirmation(
						confirmation_phrase || "",
						`CREATE AD ${adset_id} ${name}`,
					);
					const created = await runIdempotentCreate(
						env,
						"ad",
						request_id,
						async () =>
							writeResponseSchema.parse(
								await callMetaGraph(env, "POST", `${accountId}/ads`, params),
							),
					);
					auditMutation("create_ad", {
						adset_id,
						name,
						request_id,
						status: "PAUSED",
					});
					return asToolResult(created);
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_create_whatsapp_video_ad_draft",
			{
				annotations: {
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
					readOnlyHint: false,
				},
				description:
					"WRITE/PREVIEW. Validate or create one PAUSED click-to-WhatsApp video ad using an existing Meta video ID. Exact confirmation is required for creation.",
				inputSchema: {
					adset_id: z.string().regex(META_ID_PATTERN),
					confirmation_phrase: z.string().max(700).optional(),
					description: z.string().max(1_000).optional(),
					expected_adset_name: z.string().min(1).max(500),
					headline: z.string().min(1).max(500),
					instagram_actor_id: z.string().regex(META_ID_PATTERN).optional(),
					message: z.string().min(1).max(5_000),
					name: z.string().min(1).max(500),
					page_id: z.string().regex(META_ID_PATTERN),
					prefilled_message: z.string().min(1).max(1_000),
					request_id: z.string().uuid(),
					validate_only: z.boolean().default(true),
					video_id: z.string().regex(META_ID_PATTERN),
					whatsapp_phone_number: z.string().regex(/^\d{10,15}$/),
				},
			},
			async ({
				adset_id,
				confirmation_phrase,
				description,
				expected_adset_name,
				headline,
				instagram_actor_id,
				message,
				name,
				page_id,
				prefilled_message,
				request_id,
				validate_only,
				video_id,
				whatsapp_phone_number,
			}) => {
				try {
					const env = this.env as MetaEnv;
					assertWritesEnabled(env);
					const { accountId } = getMetaConfig(env);
					const adset = await getOwnedObject(env, "ADSET", adset_id);
					assertExpectedName(adset, expected_adset_name);
					const promotedPageId = getPromotedPageId(adset);
					if (promotedPageId !== page_id) {
						throw new Error(
							`page_id must match the promoted page ${promotedPageId} on ad set ${adset_id}.`,
						);
					}
					if (String(adset.destination_type || "") !== "WHATSAPP") {
						throw new Error(`Ad set ${adset_id} must use destination_type WHATSAPP.`);
					}
					const whatsappLink = buildWhatsAppLink(
						whatsapp_phone_number,
						prefilled_message,
					);
					const videoData: Record<string, unknown> = {
						call_to_action: {
							type: "WHATSAPP_MESSAGE",
							value: { app_destination: "WHATSAPP", link: whatsappLink },
						},
						message,
						title: headline,
						video_id,
					};
					if (description) videoData.link_description = description;
					const objectStorySpec: Record<string, unknown> = {
						page_id,
						video_data: videoData,
					};
					if (instagram_actor_id) objectStorySpec.instagram_actor_id = instagram_actor_id;
					const params: Record<string, string | number | boolean | object> = {
						adset_id,
						creative: { object_story_spec: objectStorySpec },
						name,
						status: "PAUSED",
					};
					if (validate_only) {
						params.execution_options = ["validate_only", "include_recommendations"];
						const validation = await callMetaGraph(env, "POST", `${accountId}/ads`, params);
						return asToolResult({
							mode: "validate_only",
							status_for_create: "PAUSED",
							validation,
						});
					}
					assertConfirmation(
						confirmation_phrase || "",
						`CREATE WHATSAPP VIDEO AD ${adset_id} ${name}`,
					);
					const created = await runIdempotentCreate(
						env,
						"whatsapp-video-ad",
						request_id,
						async () =>
							writeResponseSchema.parse(
								await callMetaGraph(env, "POST", `${accountId}/ads`, params),
							),
					);
					auditMutation("create_whatsapp_video_ad", {
						adset_id,
						name,
						request_id,
						status: "PAUSED",
						video_id,
					});
					return asToolResult(created);
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_list_lead_forms",
			{
				annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true },
				description: "Read-only. List Instant Forms owned by one accessible Facebook Page.",
				inputSchema: {
					after: z.string().max(2_000).optional(),
					limit: z.number().int().min(1).max(100).default(25),
					page_id: z.string().regex(META_ID_PATTERN),
				},
			},
			async ({ after, limit, page_id }) => {
				try {
					const env = this.env as MetaEnv;
					const page = await assertAccessiblePage(env, page_id);
					const params: Record<string, string | number> = {
						fields:
							"id,name,status,created_time,locale,questions,privacy_policy_url,follow_up_action_url,is_optimized_for_quality",
						limit,
					};
					if (after) params.after = after;
					const response = graphListSchema.parse(
						await callMetaGraph(env, "GET", `${page_id}/leadgen_forms`, params),
					);
					return asToolResult({
						forms: response.data,
						page: { id: page_id, name: page.name },
						paging: pagingCursors(response.paging),
					});
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_create_lead_form",
			{
				annotations: {
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
					readOnlyHint: false,
				},
				description:
					"WRITE. Create one Meta Instant Form on an accessible Page. Exact confirmation and request_id are required. Forms do not spend money but may become selectable immediately.",
				inputSchema: {
					confirmation_phrase: z.string().max(700),
					context_card: z
						.object({
							content: z.array(z.string().min(1).max(500)).min(1).max(20),
							headline: z.string().min(1).max(500),
							style: z.enum(["LIST_STYLE", "PARAGRAPH_STYLE"]).default("PARAGRAPH_STYLE"),
						})
						.optional(),
					follow_up_action_url: z.string().url().max(2_000),
					is_optimized_for_quality: z.boolean().default(true),
					locale: z.string().min(2).max(20).default("pt_BR"),
					name: z.string().min(1).max(500),
					page_id: z.string().regex(META_ID_PATTERN),
					privacy_policy_link_text: z.string().min(1).max(500),
					privacy_policy_url: z.string().url().max(2_000),
					questions: z.array(leadFormQuestionSchema).min(1).max(20),
					request_id: z.string().uuid(),
				},
			},
			async ({
				confirmation_phrase,
				context_card,
				follow_up_action_url,
				is_optimized_for_quality,
				locale,
				name,
				page_id,
				privacy_policy_link_text,
				privacy_policy_url,
				questions,
				request_id,
			}) => {
				try {
					const env = this.env as MetaEnv;
					assertWritesEnabled(env);
					await assertAccessiblePage(env, page_id);
					assertConfirmation(confirmation_phrase, `CREATE LEAD FORM ${page_id} ${name}`);
					for (const question of questions.filter((item) => item.type === "CUSTOM")) {
						if (!question.label || !question.options || !question.key) {
							throw new Error("CUSTOM questions require key, label, and at least two options.");
						}
					}
					const params: Record<string, string | number | boolean | object> = {
						follow_up_action_url,
						is_optimized_for_quality,
						locale,
						name,
						privacy_policy: {
							link_text: privacy_policy_link_text,
							url: privacy_policy_url,
						},
						questions,
					};
					if (context_card) params.context_card = context_card;
					const created = await runIdempotentCreate(env, "lead-form", request_id, async () =>
						writeResponseSchema.parse(
							await callMetaGraph(env, "POST", `${page_id}/leadgen_forms`, params),
						),
					);
					auditMutation("create_lead_form", { name, page_id, request_id });
					return asToolResult(created);
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_create_lead_form_video_ad_draft",
			{
				annotations: {
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
					readOnlyHint: false,
				},
				description:
					"WRITE/PREVIEW. Validate or create one PAUSED video ad connected to an existing Meta Instant Form.",
				inputSchema: {
					adset_id: z.string().regex(META_ID_PATTERN),
					confirmation_phrase: z.string().max(700).optional(),
					expected_adset_name: z.string().min(1).max(500),
					headline: z.string().min(1).max(500),
					instagram_actor_id: z.string().regex(META_ID_PATTERN).optional(),
					lead_gen_form_id: z.string().regex(META_ID_PATTERN),
					message: z.string().min(1).max(5_000),
					name: z.string().min(1).max(500),
					page_id: z.string().regex(META_ID_PATTERN),
					request_id: z.string().uuid(),
					validate_only: z.boolean().default(true),
					video_id: z.string().regex(META_ID_PATTERN),
				},
			},
			async ({
				adset_id,
				confirmation_phrase,
				expected_adset_name,
				headline,
				instagram_actor_id,
				lead_gen_form_id,
				message,
				name,
				page_id,
				request_id,
				validate_only,
				video_id,
			}) => {
				try {
					const env = this.env as MetaEnv;
					assertWritesEnabled(env);
					const { accountId } = getMetaConfig(env);
					const adset = await getOwnedObject(env, "ADSET", adset_id);
					assertExpectedName(adset, expected_adset_name);
					if (getPromotedPageId(adset) !== page_id) {
						throw new Error(`page_id must match the promoted page on ad set ${adset_id}.`);
					}
					const form = z
						.object({ id: z.string(), name: z.string(), status: z.string().optional() })
						.passthrough()
						.parse(
							await callMetaGraph(env, "GET", lead_gen_form_id, { fields: "id,name,status" }),
						);
					const videoData: Record<string, unknown> = {
						call_to_action: {
							type: "LEARN_MORE",
							value: { lead_gen_form_id },
						},
						message,
						title: headline,
						video_id,
					};
					const objectStorySpec: Record<string, unknown> = {
						page_id,
						video_data: videoData,
					};
					if (instagram_actor_id) objectStorySpec.instagram_actor_id = instagram_actor_id;
					const params: Record<string, string | number | boolean | object> = {
						adset_id,
						creative: { object_story_spec: objectStorySpec },
						name,
						status: "PAUSED",
					};
					if (validate_only) {
						params.execution_options = ["validate_only", "include_recommendations"];
						const validation = await callMetaGraph(env, "POST", `${accountId}/ads`, params);
						return asToolResult({ form, mode: "validate_only", status_for_create: "PAUSED", validation });
					}
					assertConfirmation(
						confirmation_phrase || "",
						`CREATE LEAD FORM VIDEO AD ${adset_id} ${name}`,
					);
					const created = await runIdempotentCreate(
						env,
						"lead-form-video-ad",
						request_id,
						async () =>
							writeResponseSchema.parse(
								await callMetaGraph(env, "POST", `${accountId}/ads`, params),
							),
					);
					auditMutation("create_lead_form_video_ad", {
						adset_id,
						form_id: lead_gen_form_id,
						name,
						request_id,
						status: "PAUSED",
						video_id,
					});
					return asToolResult({ created, form });
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_delete_campaign",
			{
				annotations: {
					destructiveHint: true,
					idempotentHint: true,
					openWorldHint: true,
					readOnlyHint: false,
				},
				description:
					"DESTRUCTIVE WRITE. Mark exactly one owned campaign DELETED. Exact current name and phrase DELETE CAMPAIGN <id> <name> are mandatory. Never deletes in bulk.",
				inputSchema: {
					campaign_id: z.string().regex(META_ID_PATTERN),
					confirmation_phrase: z.string().max(1_000),
					expected_campaign_name: z.string().min(1).max(500),
				},
			},
			async ({ campaign_id, confirmation_phrase, expected_campaign_name }) => {
				try {
					const env = this.env as MetaEnv;
					assertWritesEnabled(env);
					const before = await getOwnedObject(env, "CAMPAIGN", campaign_id);
					assertExpectedName(before, expected_campaign_name);
					assertConfirmation(
						confirmation_phrase,
						`DELETE CAMPAIGN ${campaign_id} ${expected_campaign_name}`,
					);
					const result = writeResponseSchema.parse(
						await callMetaGraph(env, "POST", campaign_id, { status: "DELETED" }),
					);
					auditMutation("delete_campaign", {
						campaign_id,
						campaign_name: expected_campaign_name,
					});
					return asToolResult({ before, result, status_requested: "DELETED" });
				} catch (error) {
					return asToolError(error);
				}
			},
		);
	}
}

const oauthProvider = new OAuthProvider({
	apiHandler: MyMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: { fetch: handleAccessRequest as any },
	tokenEndpoint: "/token",
});

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const creativeAssetResponse = getCreativeAssetResponse(request);
		if (creativeAssetResponse) return creativeAssetResponse;
		const url = new URL(request.url);
		if (url.pathname === "/mcp-v2") {
			url.pathname = "/mcp";
			request = new Request(url.toString(), request);
		}
		return oauthProvider.fetch(request, env, ctx);
	},
};
