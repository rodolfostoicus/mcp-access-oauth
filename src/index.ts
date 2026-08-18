import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { handleAccessRequest } from "./access-handler";
import type { Props } from "./workers-oauth-utils";

const DEFAULT_META_API_VERSION = "v26.0";
const META_GRAPH_ORIGIN = "https://graph.facebook.com";
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type MetaEnv = Env & {
	META_ACCESS_TOKEN?: string;
	META_AD_ACCOUNT_ID?: string;
	META_API_VERSION?: string;
};

type MetaGraphError = {
	error?: {
		code?: number;
		error_subcode?: number;
		fbtrace_id?: string;
		message?: string;
		type?: string;
	};
};

type MetaPaging = {
	cursors?: {
		after?: string;
		before?: string;
	};
};

type MetaListResponse<T> = MetaGraphError & {
	data?: T[];
	paging?: MetaPaging;
};

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

	return { accessToken, accountId, apiVersion };
}

function safeMetaError(payload: MetaGraphError, status: number) {
	const metaError = payload.error;
	if (!metaError) {
		return `Meta API returned HTTP ${status}.`;
	}

	const details = [
		metaError.message,
		metaError.type ? `type=${metaError.type}` : undefined,
		metaError.code !== undefined ? `code=${metaError.code}` : undefined,
		metaError.error_subcode !== undefined
			? `subcode=${metaError.error_subcode}`
			: undefined,
	].filter(Boolean);

	return details.join(" | ").slice(0, 800);
}

async function callMetaGraph<T>(
	env: MetaEnv,
	path: string,
	params: Record<string, string>,
): Promise<T> {
	const { accessToken, apiVersion } = getMetaConfig(env);
	const cleanPath = path.replace(/^\/+/, "");
	const url = new URL(`/${apiVersion}/${cleanPath}`, META_GRAPH_ORIGIN);

	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}

	const response = await fetch(url, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		method: "GET",
	});

	const rawBody = await response.text();
	let payload: (T & MetaGraphError) | undefined;

	try {
		payload = JSON.parse(rawBody) as T & MetaGraphError;
	} catch {
		throw new Error(`Meta API returned a non-JSON HTTP ${response.status} response.`);
	}

	if (!response.ok || payload.error) {
		throw new Error(safeMetaError(payload, response.status));
	}

	return payload;
}

function pagingCursors(paging?: MetaPaging) {
	if (!paging?.cursors) return undefined;

	return {
		after: paging.cursors.after,
		before: paging.cursors.before,
	};
}

function asToolResult(value: unknown) {
	return {
		content: [
			{
				text: JSON.stringify(value, null, 2),
				type: "text" as const,
			},
		],
	};
}

function asToolError(error: unknown) {
	const message = error instanceof Error ? error.message : "Unexpected Meta API error.";
	const redactedMessage = message
		.replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
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

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Meta Ads Stoicus Secure",
		version: "1.0.0",
	});

	async init() {
		this.server.tool(
			"meta_get_ad_account",
			"Read-only. Confirm the configured Meta ad account, status, currency, and timezone. Never creates or changes ads.",
			{},
			async () => {
				try {
					const env = this.env as MetaEnv;
					const { accountId, apiVersion } = getMetaConfig(env);
					const account = await callMetaGraph<Record<string, unknown>>(env, accountId, {
						fields: "id,name,account_status,currency,timezone_name",
					});

					return asToolResult({ api_version: apiVersion, account });
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.tool(
			"meta_list_campaigns",
			"Read-only. List campaigns from the single Meta ad account configured in the Worker. Never creates, edits, pauses, or deletes campaigns.",
			{
				after: z
					.string()
					.max(2_000)
					.optional()
					.describe("Optional cursor returned by a previous call."),
				effective_status: z
					.enum(["ACTIVE", "PAUSED", "ARCHIVED"])
					.optional()
					.describe("Optional effective campaign status filter."),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.default(25)
					.describe("Number of campaigns to return, from 1 to 100."),
			},
			async ({ after, effective_status, limit }) => {
				try {
					const env = this.env as MetaEnv;
					const { accountId } = getMetaConfig(env);
					const params: Record<string, string> = {
						fields:
							"id,name,status,effective_status,objective,start_time,stop_time,created_time,updated_time",
						limit: String(limit),
					};

					if (after) params.after = after;
					if (effective_status) {
						params.effective_status = JSON.stringify([effective_status]);
					}

					const response = await callMetaGraph<MetaListResponse<Record<string, unknown>>>(
						env,
						`${accountId}/campaigns`,
						params,
					);

					return asToolResult({
						campaigns: response.data || [],
						paging: pagingCursors(response.paging),
					});
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.tool(
			"meta_get_campaign_insights",
			"Read-only. Return campaign-level Meta Ads performance for an explicit date range, or the last 7 calendar days by default. Never changes delivery or budget.",
			{
				after: z
					.string()
					.max(2_000)
					.optional()
					.describe("Optional cursor returned by a previous call."),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.default(50)
					.describe("Number of campaign rows to return, from 1 to 100."),
				since: z
					.string()
					.optional()
					.describe("Start date in YYYY-MM-DD. Use together with until."),
				until: z
					.string()
					.optional()
					.describe("End date in YYYY-MM-DD. Use together with since."),
			},
			async ({ after, limit, since, until }) => {
				try {
					const env = this.env as MetaEnv;
					const { accountId } = getMetaConfig(env);
					const timeRange = resolveTimeRange(since, until);
					const params: Record<string, string> = {
						fields:
							"date_start,date_stop,campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpc,actions,cost_per_action_type",
						level: "campaign",
						limit: String(limit),
						time_range: JSON.stringify(timeRange),
					};

					if (after) params.after = after;

					const response = await callMetaGraph<MetaListResponse<Record<string, unknown>>>(
						env,
						`${accountId}/insights`,
						params,
					);

					return asToolResult({
						insights: response.data || [],
						paging: pagingCursors(response.paging),
						time_range: timeRange,
					});
				} catch (error) {
					return asToolError(error);
				}
			},
		);
	}
}

export default new OAuthProvider({
	apiHandler: MyMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: { fetch: handleAccessRequest as any },
	tokenEndpoint: "/token",
});
