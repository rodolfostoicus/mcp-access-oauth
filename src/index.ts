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
const META_GATE_MIN_INTERVAL_MS = 250;
// Meta can rate-limit consecutive configuration POSTs to one ad set even when
// globally serialized. Keep validate_only and its real update over 30s apart.
const BREVAR_SAME_OBJECT_POST_GAP_MS = 31_000;
const META_GET_RETRY_DELAY_MS = 1_000;
const META_GET_MAX_INLINE_RETRY_DELAY_MS = 5_000;
const META_RATE_LIMIT_COOLDOWN_MS = 60_000;
const WRITE_LEASE_TTL_MS = 10 * 60 * 1_000;
const STATUS_POST_TIMEOUT_MS = 30_000;
const STATUS_POST_MIN_LEASE_REMAINING_MS = 60_000;
const CONNECTOR_VERSION = "2.3.11";

type MetaEnv = Env & {
	META_ACCESS_TOKEN?: string;
	META_AD_ACCOUNT_ID?: string;
	META_API_GATE?: DurableObjectNamespace;
	META_API_VERSION?: string;
	META_WRITE_LOCK?: DurableObjectNamespace;
	META_WRITE_ENABLED?: string;
};

type WriteLease = {
	acquired_at: string;
	expires_at: string;
	holder: string;
	operation: string;
};

const writeLeaseRequestSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("acquire"),
		holder: z.string().min(1).max(500),
		operation: z.string().min(1).max(1_000),
		ttl_ms: z.number().int().min(60_000).max(30 * 60 * 1_000),
	}).strict(),
	z.object({
		action: z.literal("release"),
		holder: z.string().min(1).max(500),
	}).strict(),
	z.object({
		action: z.literal("release_owned"),
		holder: z.string().min(1).max(500),
	}).strict(),
	z.object({
		action: z.literal("assert_owner"),
		holder: z.string().min(1).max(500),
	}).strict(),
	z.object({
		action: z.literal("creative_journal_get"), holder: z.string().min(1).max(500), request_id: z.string().uuid(), ad_id: z.string().regex(/^\d+$/),
	}).strict(),
	z.object({
		action: z.literal("creative_journal_put"), holder: z.string().min(1).max(500), request_id: z.string().uuid(), ad_id: z.string().regex(/^\d+$/),
		expected_stage: z.enum(["ABSENT", "CREATE_PENDING", "CREATIVE_CREATED", "ATTACH_PENDING"]),
		record: z.record(z.string(), z.unknown()),
	}).strict(),
	z.object({ action: z.literal("status") }).strict(),
]);

const writeLeaseAcquireResponseSchema = z.object({
	active: z.literal(true),
	acquired: z.boolean(),
	expires_at: z.string().datetime({ offset: true }),
}).passthrough();

function jsonResponse(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		headers: { "Content-Type": "application/json;charset=UTF-8", "Cache-Control": "no-store" },
		status,
	});
}

export class MetaWriteLock {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { headers: { Allow: "POST" }, status: 405 });
		}

		let parsed: z.infer<typeof writeLeaseRequestSchema>;
		try {
			parsed = writeLeaseRequestSchema.parse(await request.json());
		} catch {
			return jsonResponse({ code: "INVALID_WRITE_LEASE_REQUEST" }, 400);
		}

		return this.state.blockConcurrencyWhile(async () => {
			const now = Date.now();
			const current = await this.state.storage.get<WriteLease>("lease");
			const currentExpiry = current ? Date.parse(current.expires_at) : 0;
			const active = current && Number.isFinite(currentExpiry) && currentExpiry > now;

			if (parsed.action === "status") {
				return jsonResponse(active
					? { active: true, expires_at: current.expires_at, operation: current.operation }
					: { active: false });
			}

			if (parsed.action === "creative_journal_get" || parsed.action === "creative_journal_put") {
				if (!active) return jsonResponse({ code: "WRITE_LEASE_EXPIRED" }, 409);
				if (current.holder !== parsed.holder) return jsonResponse({ code: "WRITE_LOCKED", expires_at: current.expires_at, operation: current.operation }, 409);
				const key = `brevar-creative:${parsed.request_id}`;
				const record = await this.state.storage.get<Record<string, unknown>>(key);
				const adKey = `brevar-creative-ad:${parsed.ad_id}`;
				const adJournal = await this.state.storage.get<{ request_id: string; stage: string }>(adKey);
				if (adJournal && adJournal.stage !== "COMPLETE" && adJournal.request_id !== parsed.request_id) {
					return jsonResponse({ record: null, blocked_by_request_id: adJournal.request_id });
				}
				if (record && record.ad_id !== parsed.ad_id) return jsonResponse({ code: "CREATIVE_JOURNAL_AD_MISMATCH" }, 409);
				if (parsed.action === "creative_journal_get") return jsonResponse({ record: record ?? null });
				const oldStage = record?.stage ?? "ABSENT";
				const nextStage: Record<string, string> = { ABSENT: "CREATE_PENDING", CREATE_PENDING: "CREATIVE_CREATED", CREATIVE_CREATED: "ATTACH_PENDING", ATTACH_PENDING: "COMPLETE" };
				if (oldStage !== parsed.expected_stage || parsed.record.stage !== nextStage[String(oldStage)] ||
					parsed.record.ad_id !== parsed.ad_id || parsed.record.request_id !== parsed.request_id ||
					(record && parsed.record.fingerprint !== record.fingerprint) || JSON.stringify(parsed.record).length > 100_000) {
					return jsonResponse({ code: "CREATIVE_JOURNAL_CONFLICT" }, 409);
				}
				// Commit journal and per-ad blocker atomically. A new request_id
				// cannot bypass an unresolved operation after its lease expires.
				await this.state.storage.put({ [key]: parsed.record, [adKey]: { request_id: parsed.request_id, stage: String(parsed.record.stage) } });
				return jsonResponse({ saved: true });
			}

			if (parsed.action === "assert_owner") {
				if (!active) return jsonResponse({ code: "WRITE_LEASE_EXPIRED" }, 409);
				if (current.holder !== parsed.holder) {
					return jsonResponse({
						code: "WRITE_LOCKED",
						expires_at: current.expires_at,
						operation: current.operation,
					}, 409);
				}
				return jsonResponse({ active: true, holder_matches: true, expires_at: current.expires_at });
			}

			if (parsed.action === "release" || parsed.action === "release_owned") {
				// Operation owners must never remove a successor's row, even after
				// that successor expires. Keep legacy session release unchanged.
				if (parsed.action === "release_owned" && current && current.holder !== parsed.holder) {
					return jsonResponse({
						code: "WRITE_LOCKED",
						expires_at: current.expires_at,
						operation: current.operation,
					}, 409);
				}
				if (!active) {
					await this.state.storage.delete("lease");
					return jsonResponse({ active: false, released: false });
				}
				if (current.holder !== parsed.holder) {
					return jsonResponse({
						code: "WRITE_LOCKED",
						expires_at: current.expires_at,
						operation: current.operation,
					}, 409);
				}
				await this.state.storage.delete("lease");
				return jsonResponse({ active: false, released: true });
			}

			if (active && current.holder !== parsed.holder) {
				return jsonResponse({
					code: "WRITE_LOCKED",
					expires_at: current.expires_at,
					operation: current.operation,
				}, 409);
			}

			const lease: WriteLease = {
				acquired_at: active ? current.acquired_at : new Date(now).toISOString(),
				expires_at: new Date(now + parsed.ttl_ms).toISOString(),
				holder: parsed.holder,
				operation: parsed.operation,
			};
			await this.state.storage.put("lease", lease);
			return jsonResponse({ active: true, acquired: !active, expires_at: lease.expires_at });
		});
	}
}

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

type MetaGraphCall = {
	method: "GET" | "POST";
	params: Record<string, string | number | boolean | object>;
	path: string;
	write_lease_holder?: string;
};

class MetaGraphError extends Error {
	constructor(
		message: string,
		readonly httpStatus: number,
		readonly code?: number,
		readonly subcode?: number,
		readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = "MetaGraphError";
	}
}

class MetaWriteNotDispatchedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MetaWriteNotDispatchedError";
	}
}

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

// Account-timezone delivery windows; scheduling is opt-in and never inferred.
const adsetScheduleSchema = z.array(z.object({
	days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
	start_minute: z.number().int().min(0).max(1380).multipleOf(60),
	end_minute: z.number().int().min(60).max(1440).multipleOf(60),
	timezone_type: z.literal("ADVERTISER"),
}).strict().refine((window) => window.end_minute > window.start_minute, {
	message: "Each schedule window must end after it starts; split overnight windows.",
})).min(1).max(49).superRefine((windows, ctx) => {
	for (let day = 0; day < 7; day++) {
		const intervals = windows.filter((window) => window.days.includes(day))
			.sort((a, b) => a.start_minute - b.start_minute);
		for (let i = 1; i < intervals.length; i++) {
			if (intervals[i].start_minute < intervals[i - 1].end_minute) {
				ctx.addIssue({ code: "custom", message: "Schedule windows must not overlap." });
			}
		}
	}
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

function getMetaGateStub(env: MetaEnv) {
	const metaApiGate = env.META_API_GATE;
	if (!metaApiGate) {
		throw new Error(
			"META_API_GATE is not configured. Meta calls are blocked so concurrent sessions cannot bypass the account-level gate.",
		);
	}
	const { accountNumericId } = getMetaConfig(env);
	return {
		accountNumericId,
		stub: metaApiGate.get(metaApiGate.idFromName(accountNumericId)),
	};
}

function getWriteLockStub(env: MetaEnv) {
	const writeLock = env.META_WRITE_LOCK;
	if (!writeLock) {
		throw new Error("Meta writes are blocked because META_WRITE_LOCK is not configured.");
	}
	const { accountId } = getMetaConfig(env);
	return { accountId, stub: writeLock.get(writeLock.idFromName(accountId)) };
}

async function callWriteLock(
	env: MetaEnv,
	payload: z.infer<typeof writeLeaseRequestSchema>,
) {
	const { stub } = getWriteLockStub(env);
	const response = await stub.fetch("https://meta-write-lock.internal/lease", {
		body: JSON.stringify(payload),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	let result: Record<string, unknown> = {};
	try {
		result = z.record(z.string(), z.unknown()).parse(await response.json());
	} catch {
		throw new Error(`Write-lock service returned an invalid HTTP ${response.status} response.`);
	}
	if (!response.ok) {
		if (result.code === "WRITE_LEASE_EXPIRED") {
			throw new Error("WRITE_LEASE_EXPIRED: the operation no longer holds an active account lease. No Meta write was dispatched.");
		}
		if (result.code === "WRITE_LOCKED") {
			throw new Error(
				`WRITE_LOCKED: another MCP session currently owns Meta writes for this account until ${String(result.expires_at || "the lease expires")}. Active operation: ${String(result.operation || "not disclosed")}. Read-only tools remain available.`,
			);
		}
		throw new Error(`Write-lock service rejected the request with HTTP ${response.status}.`);
	}
	return result;
}

async function acquireAccountWriteLease(env: MetaEnv, holder: string, operation: string) {
	// A real create can reach the lease before its first Graph read. Verify the
	// request gate first so a missing binding cannot strand an unnecessary lease.
	getMetaGateStub(env);
	const response = await callWriteLock(env, {
		action: "acquire",
		holder,
		operation,
		ttl_ms: WRITE_LEASE_TTL_MS,
	});
	const lease = writeLeaseAcquireResponseSchema.safeParse(response);
	if (!lease.success || Date.parse(lease.data.expires_at) <= Date.now()) {
		throw new Error("Write-lock service did not confirm an active account lease. No Meta write was attempted.");
	}
	return lease.data;
}

async function releaseAccountWriteLease(env: MetaEnv, holder: string) {
	return callWriteLock(env, { action: "release", holder });
}

async function assertAccountOperationLease(env: MetaEnv, holder: string) {
	const response = await callWriteLock(env, { action: "assert_owner", holder });
	const proof = z.object({
		active: z.literal(true),
		holder_matches: z.literal(true),
		expires_at: z.string().datetime({ offset: true }),
	}).safeParse(response);
	if (!proof.success || Date.parse(proof.data.expires_at) <= Date.now()) {
		throw new Error("WRITE_LEASE_UNVERIFIED: active operation ownership was not confirmed. No Meta write was dispatched.");
	}
	if (Date.parse(proof.data.expires_at) - Date.now() <= STATUS_POST_MIN_LEASE_REMAINING_MS) {
		throw new Error("WRITE_LEASE_NEAR_EXPIRY: too little lease time remains for a bounded status POST. No Meta write was dispatched.");
	}
}

// A successful Meta change must not be reported as failed just because its
// already-finished operation could not release its lock. No release is retried.
async function releaseAccountOperationLease(env: MetaEnv, holder: string): Promise<string | undefined> {
	try {
		const response = await callWriteLock(env, { action: "release_owned", holder });
		z.object({ active: z.literal(false), released: z.boolean() }).parse(response);
		return undefined;
	} catch (error) {
		return `The operation completed but its account lease was not confirmed released; respect its expiry before another write. ${error instanceof Error ? error.message : "Unexpected release error."}`;
	}
}

async function getAccountWriteLease(env: MetaEnv) {
	return callWriteLock(env, { action: "status" });
}

function safeMetaError(payload: MetaGraphErrorPayload, status: number) {
	const metaError = payload.error;
	if (!metaError) return `Meta API returned HTTP ${status}.`;
	const category =
		(metaError.code !== undefined && [4, 17, 32, 613].includes(metaError.code)) ||
		metaError.error_subcode === 2446079 ||
		status === 429
			? "RATE_LIMIT"
			: metaError.code === 200 &&
				/ads_(?:management|read)/i.test(metaError.message || "") &&
				/permission/i.test(metaError.message || "")
				? "ACCOUNT_ACCESS_DENIED"
				: undefined;
	return [
		category ? `category=${category}` : undefined,
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

function parseRetryAfterMs(response: Response) {
	const value = response.headers.get("Retry-After")?.trim();
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function isMetaRateLimit(error: unknown): error is MetaGraphError {
	return error instanceof MetaGraphError &&
		(error.httpStatus === 429 ||
			(error.code !== undefined && [4, 17, 32, 613].includes(error.code)) ||
			error.subcode === 2446079);
}

function delay(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function callMetaGraphDirect(
	env: MetaEnv,
	method: "GET" | "POST",
	path: string,
	params: Record<string, string | number | boolean | object>,
	signal?: AbortSignal,
): Promise<unknown> {
	const { accessToken, apiVersion } = getMetaConfig(env);
	const cleanPath = path.replace(/^\/+/, "");
	const url = new URL(`/${apiVersion}/${cleanPath}`, META_GRAPH_ORIGIN);
	const headers = new Headers({
		Accept: "application/json",
		Authorization: `Bearer ${accessToken}`,
	});
	const requestInit: RequestInit = { headers, method, ...(signal ? { signal } : {}) };

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
		if (!response.ok) {
			const message = `Meta API returned a non-JSON HTTP ${response.status} response.`;
			throw new MetaGraphError(
				response.status === 429 ? `category=RATE_LIMIT | ${message}` : message,
				response.status,
				undefined,
				undefined,
				parseRetryAfterMs(response),
			);
		}
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
		throw new MetaGraphError(
			safeMetaError(errorPayload, response.status),
			response.status,
			errorPayload.error?.code,
			errorPayload.error?.error_subcode,
			parseRetryAfterMs(response),
		);
	}
	return payload;
}

const metaGateCallSchema = z.object({
	method: z.enum(["GET", "POST"]),
	params: z.record(z.string(), z.unknown()),
	path: z.string().min(1).max(1_000),
	write_lease_holder: z.string().min(1).max(500).optional(),
}).strict();

const metaGateResponseSchema = z.object({
	error: z.string().optional(),
	ok: z.boolean(),
	payload: z.unknown().optional(),
	retry_after_seconds: z.number().int().nonnegative().optional(),
	write_dispatched: z.boolean().optional(),
}).strict();

async function callMetaGraph(
	env: MetaEnv,
	method: "GET" | "POST",
	path: string,
	params: Record<string, string | number | boolean | object>,
	options?: { write_lease_holder: string },
): Promise<unknown> {
	const { stub } = getMetaGateStub(env);
	const response = await stub.fetch("https://meta-api-gate.internal/call", {
		body: JSON.stringify({ method, params, path, ...options }),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	const envelope = metaGateResponseSchema.parse(await response.json());
	if (!envelope.ok) {
		const message = envelope.error || "Meta API gate rejected the request.";
		if (method === "POST" && envelope.write_dispatched === false) {
			throw new MetaWriteNotDispatchedError(message);
		}
		throw new Error(message);
	}
	return envelope.payload;
}

/**
 * One named instance per ad account serializes individual Meta Graph requests
 * from every MCP session. This prevents simultaneous request bursts; it does not
 * make a multi-request business workflow atomic. POST requests are never retried.
 */
export class MetaApiGate {
	private cooldownUntil = 0;
	private nextStartAt = 0;
	private queue: Promise<void> = Promise.resolve();
	private readonly env: MetaEnv;

	constructor(_state: DurableObjectState, env: Env) {
		this.env = env as MetaEnv;
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation, operation);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	private async paceNextAttempt() {
		const pacingDelay = Math.max(0, this.nextStartAt - Date.now());
		if (pacingDelay > 0) await delay(pacingDelay);
		this.nextStartAt = Date.now() + META_GATE_MIN_INTERVAL_MS;
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return Response.json({ error: "Method not allowed.", ok: false }, { status: 405 });
		}
		let call: MetaGraphCall;
		try {
			const parsed = metaGateCallSchema.parse(await request.json());
			call = {
				method: parsed.method,
				params: parsed.params as MetaGraphCall["params"],
				path: parsed.path,
				write_lease_holder: parsed.write_lease_holder,
			};
		} catch {
			return Response.json({ error: "Invalid Meta API gate request.", ok: false }, { status: 400 });
		}

		return this.enqueue(async () => {
			const now = Date.now();
			if (this.cooldownUntil > now) {
				const retryAfterSeconds = Math.ceil((this.cooldownUntil - now) / 1_000);
				return Response.json({
					error: `category=RATE_LIMIT_COOLDOWN | wait ${retryAfterSeconds}s and retry from one chat`,
					ok: false,
					retry_after_seconds: retryAfterSeconds,
					write_dispatched: call.method === "POST" ? false : undefined,
				}, { status: 429 });
			}

			const attempts = call.method === "GET" ? 2 : 1;
			for (let attempt = 1; attempt <= attempts; attempt++) {
				await this.paceNextAttempt();
				let dispatchStarted = false;
				try {
					// Fence only opted-in operation writes. Verify after queueing and
					// pacing so an expired operation cannot dispatch a late POST.
					// Legacy mutators retain their existing session-lease behavior.
					if (call.write_lease_holder !== undefined) {
						if (call.method !== "POST") throw new Error("Operation lease proof is only valid for POST requests.");
						await assertAccountOperationLease(this.env, call.write_lease_holder);
					}
					const signal = call.write_lease_holder !== undefined
						? AbortSignal.timeout(STATUS_POST_TIMEOUT_MS)
						: undefined;
					dispatchStarted = true;
					const payload = await callMetaGraphDirect(
						this.env,
						call.method,
						call.path,
						call.params,
						signal,
					);
					return Response.json({ ok: true, payload });
				} catch (error) {
					if (isMetaRateLimit(error)) {
						const retryDelay = Math.max(
							error.retryAfterMs ?? META_GET_RETRY_DELAY_MS,
							META_GET_RETRY_DELAY_MS,
						);
						if (
							call.method === "GET" &&
							attempt < attempts &&
							retryDelay <= META_GET_MAX_INLINE_RETRY_DELAY_MS
						) {
							await delay(retryDelay);
							continue;
						}
						this.cooldownUntil = Date.now() + Math.max(retryDelay, META_RATE_LIMIT_COOLDOWN_MS);
					}
					return Response.json({
						error: error instanceof Error ? error.message : "Unexpected Meta API error.",
						ok: false,
						write_dispatched: call.method === "POST" ? dispatchStarted : undefined,
						retry_after_seconds: isMetaRateLimit(error)
							? Math.ceil(Math.max(
								error.retryAfterMs ?? META_GET_RETRY_DELAY_MS,
								META_RATE_LIMIT_COOLDOWN_MS,
							) / 1_000)
							: undefined,
					}, { status: isMetaRateLimit(error) ? 429 : 502 });
				}
			}

			return Response.json({ error: "Meta API request failed.", ok: false }, { status: 502 });
		});
	}
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
	additionalFields = "",
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
			fields: fieldsByType[objectType] + (additionalFields ? `,${additionalFields}` : ""),
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

const ADSET_AGE_AUDIT_FIELDS = "targeting,targeting_optimization_types,start_time,end_time,adset_schedule,pacing_type,bid_strategy,bid_amount";

// Compare JSON objects without relying on Graph's object-key order. Array order
// is intentionally retained: an unexplained difference must stop the operation.
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function adsetAgeDifferences(expected: Record<string, unknown>, actual: Record<string, unknown>) {
	// effective_status is a live delivery/review result, not a setting. Preserve
	// configured status, and return effective_status in the snapshots for review.
	return [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
		.filter((key) => key !== "effective_status" && canonicalJson(expected[key]) !== canonicalJson(actual[key]));
}

const SOUTH_BRAZIL_REGION_KEYS = ["452", "456", "459"] as const;

function buildRestrictedSouthTargeting(targeting: Record<string, unknown>, regionKeys: string[]) {
	const geo = z.record(z.string(), z.unknown()).parse(targeting.geo_locations);
	const unexpectedFields = Object.keys(geo).filter((key) => !["countries", "regions", "location_types"].includes(key));
	if (unexpectedFields.length || (geo.countries !== undefined && geo.regions !== undefined)) {
		throw new Error("Unsupported or mixed geographic coverage. City/radius and mixed country/region audiences require separate review.");
	}
	const hasBrazilCoverage = Array.isArray(geo.countries) && geo.countries.length === 1 && geo.countries[0] === "BR";
	if (geo.countries !== undefined && !hasBrazilCoverage) {
		throw new Error("Only the single country BR may be converted to Southern Brazilian states.");
	}
	const existingRegions = z.array(z.object({ key: z.string() }).passthrough()).optional().parse(geo.regions);
	// Never turn an existing city/radius audience into state-wide coverage.
	// A BR country inclusion covers each requested state; otherwise every state
	// must already be included explicitly in the current regions list.
	if (!hasBrazilCoverage && !regionKeys.every((key) => existingRegions?.some((region) => region.key === key))) {
		throw new Error("Requested states would expand current geography. Only Brazil-wide or already-included state coverage can be restricted by this tool.");
	}
	const automation = z.record(z.string(), z.unknown()).parse(targeting.targeting_automation ?? {});
	const individual = z.record(z.string(), z.unknown()).parse(automation.individual_setting ?? {});
	const writableTargeting = { ...targeting };
	// Graph can still return this legacy value while rejecting it in writes
	// (100/1870197). Effective expansion controls remain part of the audit.
	if (Object.prototype.hasOwnProperty.call(writableTargeting, "targeting_optimization")) {
		if (writableTargeting.targeting_optimization !== "none") {
			throw new Error("Unsupported legacy targeting_optimization value; no geography update attempted.");
		}
		delete writableTargeting.targeting_optimization;
	}
	return {
		...writableTargeting,
		geo_locations: {
			regions: regionKeys.map((key) => ({ key })),
			...(geo.location_types !== undefined ? { location_types: geo.location_types } : {}),
		},
		targeting_automation: {
			...automation,
			individual_setting: { ...individual, geo: 0 },
		},
	};
}

function normalizeGeoAuditSnapshot(snapshot: Record<string, unknown>) {
	const targeting = { ...targetingSchema.parse(snapshot.targeting) };
	// Only the obsolete 'none' value and its omission are equivalent. Do not
	// normalize targeting_optimization_types or any active expansion setting.
	if (targeting.targeting_optimization === "none") delete targeting.targeting_optimization;
	const geo = z.record(z.string(), z.unknown()).parse(targeting.geo_locations);
	if (!Array.isArray(geo.regions)) return { ...snapshot, targeting };
	const regions = geo.regions.map((raw) => {
		// Graph enriches region keys with display-only names and country codes.
		// Reject unexpected fields or a non-BR country instead of hiding a drift.
		const region = z.object({
			key: z.string(), name: z.string().optional(), country: z.literal("BR").optional(),
		}).strict().parse(raw);
		return { key: region.key };
	}).sort((a, b) => a.key.localeCompare(b.key));
	return { ...snapshot, targeting: { ...targeting, geo_locations: { ...geo, regions } } };
}

function adsetGeoDifferences(expected: Record<string, unknown>, actual: Record<string, unknown>) {
	return adsetAgeDifferences(normalizeGeoAuditSnapshot(expected), normalizeGeoAuditSnapshot(actual));
}

// Deliberately separate from geography restriction: this explicit BREVAR profile
// may replace a city/radius audience with all three Southern Brazilian states.
const BREVAR_MEDICAL_POSITION_IDS = [
	"125395097503911", "138787906146791", "1423257317968087", "1597521383816555",
	"359815664202923", "588508654618832", "649354901854686", "761820927245398",
	"896416657056805", "941373515875427",
] as const;
const BREVAR_CAMPAIGN_AUDIT_FIELDS = "start_time,stop_time,pacing_type";

function assertBrevarExpansionDisabled(snapshot: Record<string, unknown>) {
	const rows = z.array(z.record(z.string(), z.unknown())).parse(snapshot.targeting_optimization_types);
	const values: Record<string, unknown> = {};
	for (const row of rows) {
		if (typeof row.key === "string") {
			if (Object.prototype.hasOwnProperty.call(values, row.key)) throw new Error("Duplicate targeting expansion diagnostic.");
			values[row.key] = row.value;
		} else {
			for (const [key, value] of Object.entries(row)) {
				if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error("Duplicate targeting expansion diagnostic.");
				values[key] = value;
			}
		}
	}
	if (values.detailed_targeting !== 0 || values.lookalike !== 0) {
		throw new Error("BREVAR requires explicit detailed_targeting=0 and lookalike=0 diagnostics. This tool does not write read-only expansion diagnostics.");
	}
}

function buildBrevarTargeting(targeting: Record<string, unknown>) {
	const next = { ...targeting };
	const geo = z.record(z.string(), z.unknown()).parse(targeting.geo_locations);
	const presence = z.array(z.enum(["home", "recent", "frequently_in"])).min(1).parse(geo.location_types);
	if (next.targeting_optimization !== undefined && next.targeting_optimization !== "none") {
		throw new Error("Unsupported legacy targeting_optimization; no BREVAR change attempted.");
	}
	// Replace detailed inclusion filters, never combine medical jobs with broad
	// interests or student/education alternatives. Placement and exclusion fields
	// outside this replacement remain unchanged and are included in read-back.
	for (const key of ["targeting_optimization", "age_range", "flexible_spec", "interests", "behaviors", "work_positions",
		"work_employers", "education_majors", "education_schools", "education_statuses", "industries", "life_events"]) {
		delete next[key];
	}
	next.age_min = 25;
	next.age_max = 50;
	next.user_age_unknown = false;
	next.genders = [1, 2];
	next.flexible_spec = [{ work_positions: BREVAR_MEDICAL_POSITION_IDS.map((id) => ({ id })) }];
	next.geo_locations = { regions: SOUTH_BRAZIL_REGION_KEYS.map((key) => ({ key })), location_types: presence };
	if (next.excluded_geo_locations !== undefined) {
		const excluded = { ...z.record(z.string(), z.unknown()).parse(next.excluded_geo_locations) };
		if (Array.isArray(excluded.countries) && excluded.countries.includes("BR")) {
			throw new Error("Brazil is excluded; this conflicting country exclusion needs separate review.");
		}
		if (excluded.regions !== undefined) {
			const regions = z.array(z.object({ key: z.string() }).passthrough()).parse(excluded.regions);
			const remaining = regions.filter((region) => !(SOUTH_BRAZIL_REGION_KEYS as readonly string[]).includes(region.key));
			if (remaining.length) excluded.regions = remaining;
			else delete excluded.regions;
		}
		if (Object.keys(excluded).some((key) => key !== "location_types")) next.excluded_geo_locations = excluded;
		else delete next.excluded_geo_locations;
	}
	const automation = z.record(z.string(), z.unknown()).parse(next.targeting_automation ?? {});
	const individual = z.record(z.string(), z.unknown()).parse(automation.individual_setting ?? {});
	if (individual.age !== undefined && individual.age !== 0) throw new Error("An existing individual age-expansion setting requires separate review; no unverified age subfield is written.");
	next.targeting_automation = { ...automation, advantage_audience: 0, individual_setting: { ...individual, geo: 0 } };
	const relaxation = z.record(z.string(), z.unknown()).parse(next.targeting_relaxation_types ?? {});
	next.targeting_relaxation_types = { ...relaxation, lookalike: 0, custom_audience: 0 };
	return next;
}

function brevarSchedule(timezone: unknown) {
	if (timezone !== "America/Noronha" && timezone !== "America/Sao_Paulo") {
		throw new Error("BREVAR schedule supports verified America/Noronha or America/Sao_Paulo account timezones only.");
	}
	return [{ days: [0, 1, 2, 3, 4, 5, 6], start_minute: timezone === "America/Noronha" ? 420 : 360,
		end_minute: timezone === "America/Noronha" ? 1440 : 1380, timezone_type: "ADVERTISER" as const }];
}

function normalizeBrevarSnapshot(snapshot: Record<string, unknown>) {
	const normalized = normalizeGeoAuditSnapshot(snapshot);
	const targeting = { ...targetingSchema.parse(normalized.targeting) };
	if (targeting.genders === undefined || canonicalJson(targeting.genders) === "[0]"
		|| canonicalJson(targeting.genders) === "[2,1]") targeting.genders = [1, 2];
	if (Array.isArray(targeting.flexible_spec)) {
		targeting.flexible_spec = targeting.flexible_spec.map((raw) => {
			const clause = z.record(z.string(), z.unknown()).parse(raw);
			if (!Array.isArray(clause.work_positions)) return clause;
			const positions = clause.work_positions.map((position) => {
				const parsed = z.object({ id: z.string(), name: z.string().optional() }).strict().parse(position);
				return { id: parsed.id };
			}).sort((a, b) => a.id.localeCompare(b.id));
			return { ...clause, work_positions: positions };
		});
	}
	// Meta may split the same weekly window into separate day rows. Compare the
	// exact per-day intervals, retaining timezone semantics and overlap checks.
	const schedule = snapshot.adset_schedule === undefined ? undefined : adsetScheduleSchema.parse(snapshot.adset_schedule)
		.flatMap((window) => window.days.map((day) => ({ day, start_minute: window.start_minute,
			end_minute: window.end_minute, timezone_type: window.timezone_type })))
		.sort((a, b) => a.day - b.day || a.start_minute - b.start_minute);
	return { ...normalized, targeting, ...(schedule !== undefined ? { adset_schedule: schedule } : {}) };
}

function brevarDifferences(expected: Record<string, unknown>, actual: Record<string, unknown>) {
	return adsetAgeDifferences(normalizeBrevarSnapshot(expected), normalizeBrevarSnapshot(actual));
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

// BREVAR creative replacement deliberately changes one paused ad's creative ID
// only. The durable operation journal survives request/lease expiry; incomplete
// operations are reconciled manually instead of replaying a create or attach.
const BREVAR_CREATIVE_PAGE = "102139681237405";
const BREVAR_CREATIVE_PHONE = "554791822809";
const BREVAR_CREATIVE_COURSE_PATH = "/produtos/72/curso-brevar-fundamentos-t04-blumenau-sc/";
const BREVAR_CREATIVE_FIELDS = "id,name,account_id,object_story_spec,object_story_id,source_instagram_media_id,asset_feed_spec,url_tags,degrees_of_freedom_spec,contextual_multi_ads";
const BREVAR_AD_AUDIT_FIELDS = "tracking_specs,conversion_specs";
const BREVAR_CREATIVE_CAMPAIGN_AUDIT_FIELDS = "spend_cap,start_time,stop_time,special_ad_categories,is_adset_budget_sharing_enabled";

type BrevarCreativeSnapshot = {
	ad: z.infer<typeof objectSchema>;
	adset: z.infer<typeof objectSchema>;
	campaign: z.infer<typeof objectSchema>;
	creative: Record<string, unknown>;
};

async function readBrevarCreativeSnapshot(env: MetaEnv, adId: string): Promise<BrevarCreativeSnapshot> {
	const ad = await getOwnedObject(env, "AD", adId, BREVAR_AD_AUDIT_FIELDS);
	if (ad.id !== adId) throw new Error("Ad identity mismatch.");
	const adsetId = z.string().regex(META_ID_PATTERN).parse(ad.adset_id);
	const campaignId = z.string().regex(META_ID_PATTERN).parse(ad.campaign_id);
	const adset = await getOwnedObject(env, "ADSET", adsetId, ADSET_AGE_AUDIT_FIELDS);
	const campaign = await getOwnedObject(env, "CAMPAIGN", campaignId, BREVAR_CREATIVE_CAMPAIGN_AUDIT_FIELDS);
	if (adset.id !== adsetId || campaign.id !== campaignId || adset.campaign_id !== campaignId) throw new Error("Ad hierarchy mismatch.");
	const creativeId = z.object({ id: z.string().regex(META_ID_PATTERN) }).parse(ad.creative).id;
	const creative = z.record(z.string(), z.unknown()).parse(await callMetaGraph(env, "GET", creativeId, { fields: BREVAR_CREATIVE_FIELDS }));
	if (creative.id !== creativeId || String(creative.account_id).replace(/^act_/, "") !== getMetaConfig(env).accountNumericId) throw new Error("Creative identity or account mismatch.");
	return { ad, adset, campaign, creative };
}

function brevarHierarchyDifferences(expected: BrevarCreativeSnapshot, actual: BrevarCreativeSnapshot, creativeId?: string) {
	const expectedAd = creativeId ? { ...expected.ad, creative: { id: creativeId } } : expected.ad;
	// Graph's creative expansion may include a display name. Only that relation's
	// ID is configurable; actual creative contents are checked independently.
	const normalizedAd = (value: Record<string, unknown>) => ({ ...value, creative: { id: z.object({ id: z.string() }).parse(value.creative).id } });
	return [
		...adsetAgeDifferences(normalizedAd(expectedAd), normalizedAd(actual.ad)).map((key) => `ad.${key}`),
		...adsetAgeDifferences(expected.adset, actual.adset).map((key) => `adset.${key}`),
		...adsetAgeDifferences(expected.campaign, actual.campaign).map((key) => `campaign.${key}`),
	];
}

function assertBrevarCreativeSnapshotUnchanged(before: BrevarCreativeSnapshot, after: BrevarCreativeSnapshot) {
	const differences = brevarHierarchyDifferences(before, after);
	if (canonicalJson(before.creative) !== canonicalJson(after.creative)) differences.push("creative");
	if (differences.length) throw new Error(`BREVAR structure changed (${differences.join(", ")}); no subsequent mutation dispatched.`);
}

function buildBrevarCreativeProposal(before: BrevarCreativeSnapshot, input: {
	description: string; headline: string; image_hash: string; link_url: string; message: string;
}) {
	if (before.ad.status !== "PAUSED") throw new Error("Creative replacement requires the existing ad to be configured PAUSED; this operation never pauses or activates ads.");
	if (!/\bBREVAR\b/i.test(`${before.ad.name} ${before.campaign.name}`)) throw new Error("Creative replacement is limited to explicitly named BREVAR ads or campaigns.");
	if (before.creative.source_instagram_media_id || before.creative.object_story_id || before.creative.asset_feed_spec) {
		throw new Error("Existing-post/Instagram-boost and dynamic creatives require their native workflow; this operation does not bypass those restrictions.");
	}
	const story = z.record(z.string(), z.unknown()).parse(before.creative.object_story_spec);
	if (story.page_id !== BREVAR_CREATIVE_PAGE || story.video_data || story.photo_data || story.template_data || story.text_data) throw new Error("Only existing Stoicus Page link-image creatives can be replaced.");
	const previousLink = z.record(z.string(), z.unknown()).parse(story.link_data);
	if (previousLink.child_attachments || previousLink.video_id) throw new Error("Carousel and video link creatives require a separate reviewed operation.");
	const url = new URL(input.link_url);
	if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) throw new Error("Approved destination requires a plain HTTPS URL without credentials, port or fragment.");
	const whatsApp = before.adset.destination_type === "WHATSAPP" && before.adset.optimization_goal === "CONVERSATIONS";
	const onPost = before.adset.destination_type === "ON_POST" && before.adset.optimization_goal === "POST_ENGAGEMENT";
	if (!whatsApp && !onPost) throw new Error("Only CONVERSATIONS/WHATSAPP and POST_ENGAGEMENT/ON_POST BREVAR ad sets are supported.");
	if (getPromotedPageId(before.adset) !== BREVAR_CREATIVE_PAGE) throw new Error("Parent ad set must promote the approved Stoicus Page.");
	if (whatsApp) {
		if (url.hostname !== "wa.me" || url.pathname !== `/${BREVAR_CREATIVE_PHONE}` || [...url.searchParams.keys()].some((key) => key !== "text")) throw new Error("WhatsApp link must use the approved BREVAR phone and optional text only.");
		const promoted = z.record(z.string(), z.unknown()).parse(before.adset.promoted_object);
		if (promoted.whatsapp_phone_number !== undefined && String(promoted.whatsapp_phone_number).replace(/\D/g, "") !== BREVAR_CREATIVE_PHONE) throw new Error("Parent WhatsApp phone differs from the approved destination.");
	} else if (!["www.stoicus.com.br", "stoicus.com.br"].includes(url.hostname) || url.pathname !== BREVAR_CREATIVE_COURSE_PATH || [...url.searchParams.keys()].some((key) => !/^utm_(source|medium|campaign|term|content)$/.test(key))) {
		throw new Error("Regional/on-post destination must be the approved BREVAR course URL with optional UTM parameters only.");
	}
	const linkData: Record<string, unknown> = {
		...previousLink, image_hash: input.image_hash, message: input.message, name: input.headline, description: input.description,
		link: input.link_url, call_to_action: { type: whatsApp ? "WHATSAPP_MESSAGE" : "LEARN_MORE", value: whatsApp ? { app_destination: "WHATSAPP", link: input.link_url } : { link: input.link_url } },
	};
	delete linkData.picture; // generated rendition URL; image_hash is authoritative
	delete linkData.page_welcome_message; // replaced by the approved wa.me prefill
	delete linkData.caption; // stale display text is not copied into revised ads
	const proposal: Record<string, string | number | boolean | object> = {
		name: `${before.ad.name} | BREVAR corrigido`,
		object_story_spec: { ...story, page_id: BREVAR_CREATIVE_PAGE, link_data: linkData },
	};
	for (const key of ["url_tags", "degrees_of_freedom_spec", "contextual_multi_ads"]) {
		if (before.creative[key] !== undefined) proposal[key] = z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).parse(before.creative[key]);
	}
	return proposal;
}

function assertBrevarCreativeReadback(proposed: Record<string, unknown>, actual: Record<string, unknown>, id: string, accountNumericId: string) {
	if (actual.id !== id || String(actual.account_id).replace(/^act_/, "") !== accountNumericId) throw new Error("Replacement creative identity/account read-back mismatch.");
	if (actual.source_instagram_media_id || actual.object_story_id || actual.asset_feed_spec) throw new Error("Unexpected existing-post or dynamic format after creative replacement.");
	const normalized = { ...actual };
	const story = z.record(z.string(), z.unknown()).parse(actual.object_story_spec);
	const link = { ...z.record(z.string(), z.unknown()).parse(story.link_data) };
	if (link.image_hash) delete link.picture; // Graph may enrich the image rendition
	const normalizedStory = { ...story, link_data: link };
	normalized.object_story_spec = normalizedStory;
	for (const key of ["name", "object_story_spec", "url_tags", "degrees_of_freedom_spec", "contextual_multi_ads"]) {
		if (canonicalJson(proposed[key]) !== canonicalJson(normalized[key])) throw new Error(`Creative read-back mismatch: ${key}.`);
	}
}

async function brevarCreativeFingerprint(value: unknown) {
	const bytes = new TextEncoder().encode(canonicalJson(value));
	return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

// Administrative diagnostics return only the requested subject/account. Raw
// Graph error messages may contain unrelated asset IDs or names, so retain only
// machine-readable error codes and never echo messages, URLs, or cursors.
function businessDiagnosticError(error: unknown) {
	const message = error instanceof Error ? error.message : "";
	const code = message.match(/(?:^|[| ])code=(\d+)/)?.[1];
	const subcode = message.match(/(?:^|[| ])subcode=(\d+)/)?.[1];
	return `Administrative read failed${code ? ` (code=${code}${subcode ? `, subcode=${subcode}` : ""})` : ""}.`;
}

async function scanBusinessEdge(
	env: MetaEnv,
	businessId: string,
	edge: "system_users" | "owned_ad_accounts" | "client_ad_accounts",
	matchId: string | null,
	requireUniqueMatch = false,
) {
	const accountEdge = edge !== "system_users";
	const pageSchema = z.object({
		data: z.array(z.object({ id: z.string().regex(accountEdge ? /^act_\d+$/ : META_ID_PATTERN) }).passthrough()).max(25),
		paging: z.object({
			next: z.string().optional(),
			cursors: z.object({ after: z.string().min(1).max(2_000).optional() }).optional(),
		}).optional(),
	});
	const systemUserSchema = z.object({ id: z.string().regex(META_ID_PATTERN), name: z.string(), role: z.string() });
	const accountSchema = z.object({
		id: z.string().regex(/^act_\d+$/),
		account_id: z.union([z.string().regex(META_ID_PATTERN), z.number().int().safe().nonnegative()]).transform(String),
		name: z.string(),
		business: z.object({ id: z.string().regex(META_ID_PATTERN) }).optional(),
		user_tasks: z.array(z.string()).optional(),
	});
	let match: Record<string, unknown> | null = null;
	let matchCount = 0;
	let scanComplete = false;
	let recordsScanned = 0;
	let pagesRead = 0;
	let diagnosticError: string | undefined;
	let unsafeSystemUserIdOmitted = false;
	let after: string | undefined;
	const seenCursors = new Set<string>();
	try {
		for (let page = 0; page < 3; page++) {
			const params: Record<string, string | number | boolean> = {
				fields: accountEdge ? "id,account_id,name,business,user_tasks" : "id,system_user_id,name,role",
				limit: 25,
			};
			if (edge === "owned_ad_accounts") params.include_shared_ad_accounts = false;
			if (after) params.after = after;
			const response = pageSchema.safeParse(await callMetaGraph(env, "GET", `${businessId}/${edge}`, params));
			if (!response.success) throw new Error("Invalid administrative edge response.");
			pagesRead += 1;
			recordsScanned += response.data.data.length;
			const rows = response.data.data.map((item) => {
				if (accountEdge || item.system_user_id === undefined) return { row: item, systemUserId: undefined };
				const systemId = z.union([z.string().regex(META_ID_PATTERN), z.number().int().safe().nonnegative()]).transform(String).safeParse(item.system_user_id);
				if (!systemId.success) unsafeSystemUserIdOmitted = true;
				return { row: item, systemUserId: systemId.success ? systemId.data : undefined };
			});
			const matchedRows = matchId
				? rows.filter((item) => item.row.id === matchId || item.systemUserId === matchId)
				: [];
			matchCount += matchedRows.length;
			const matched = matchedRows[0];
			const row = matched?.row;
			if (row && !match) {
				if (accountEdge) {
					const account = accountSchema.parse(row);
					if (`act_${account.account_id}` !== matchId) throw new Error("Account identity mismatch.");
					// A business object can describe another portfolio on client edges.
					// Return only equality evidence; never reveal its other ID or name.
					match = {
						id: account.id, account_id: account.account_id, name: account.name,
						business_matches_requested: account.business ? account.business.id === businessId : null,
						user_tasks: account.user_tasks,
					};
				} else {
					match = { ...systemUserSchema.parse(row), system_user_id: matched?.systemUserId };
				}
			}
			scanComplete = !response.data.paging?.next;
			if ((match && !requireUniqueMatch) || scanComplete) break;
			const nextAfter = response.data.paging?.cursors?.after;
			if (!nextAfter || seenCursors.has(nextAfter)) {
				diagnosticError = "Pagination did not provide a new cursor; result is incomplete.";
				break;
			}
			seenCursors.add(nextAfter);
			after = nextAfter;
		}
	} catch (error) {
		diagnosticError = businessDiagnosticError(error);
	}
	return {
		match_found: match !== null, match, match_ambiguous: matchCount > 1,
		scan_complete: scanComplete,
		records_scanned: recordsScanned, pages_read: pagesRead, diagnostic_error: diagnosticError,
		identity_warning: unsafeSystemUserIdOmitted ? "Invalid or unsafe numeric system_user_id values were omitted; identity matching may be incomplete." : undefined,
	};
}

async function inspectBusinessAccess(env: MetaEnv, businessId: string, tokenSubject: unknown) {
	const subject = z.object({ id: z.string().regex(META_ID_PATTERN), name: z.string().optional() }).safeParse(tokenSubject);
	const { accountId } = getMetaConfig(env);
	// Each edge is independently bounded and read once per page. A failed system
	// user lookup must not prevent ownership evidence from being inspected.
	const systemUsers = await scanBusinessEdge(env, businessId, "system_users", subject.success ? subject.data.id : null);
	const isRateLimited = (error?: string) => /code=(?:4|17|32|613)\b/.test(error || "");
	const ownedAccounts = isRateLimited(systemUsers.diagnostic_error)
		? { skipped: true, reason: "Stopped after a rate-limit response." }
		: await scanBusinessEdge(env, businessId, "owned_ad_accounts", accountId);
	const clientAccounts = "skipped" in ownedAccounts || isRateLimited(ownedAccounts.diagnostic_error)
		? { skipped: true, reason: "Stopped after a rate-limit response." }
		: ownedAccounts.match_found
			? { skipped: true, reason: "Configured account was found in owned_ad_accounts." }
			: await scanBusinessEdge(env, businessId, "client_ad_accounts", accountId);
	return {
		business_id: businessId,
		token_subject: subject.success ? subject.data : null,
		system_users: systemUsers,
		owned_ad_accounts: ownedAccounts,
		client_ad_accounts: clientAccounts,
		assigned_ad_accounts: { skipped: true, reason: "Assignment reads are outside this bounded diagnostic." },
		access_explanation: "System-user role and account user_tasks are observed metadata only. They do not establish administrative authorization or permission to mutate the account. No write was attempted.",
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
			"meta_get_write_lease",
			{
				annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: true },
				description:
					"Read-only. Report whether another MCP session currently owns the exclusive write lease for the configured Meta ad account. Does not reveal session identifiers.",
				inputSchema: {},
			},
			async () => {
				try {
					const env = this.env as MetaEnv;
					const { accountId } = getWriteLockStub(env);
					const lease = await getAccountWriteLease(env);
					return asToolResult({ account_id: accountId, ...lease });
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_release_write_lease",
			{
				annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: false },
				description:
					"CONTROL WRITE. Release the configured Meta ad account's exclusive write lease only when it belongs to this MCP session. Exact confirmation is required. Does not change any Meta object.",
				inputSchema: { confirmation_phrase: z.string().max(500) },
			},
			async ({ confirmation_phrase }) => {
				try {
					const env = this.env as MetaEnv;
					assertWritesEnabled(env);
					const { accountId } = getWriteLockStub(env);
					assertConfirmation(confirmation_phrase, `RELEASE WRITE LEASE ${accountId}`);
					const result = await releaseAccountWriteLease(env, this.ctx.id.toString());
					return asToolResult({ account_id: accountId, ...result });
				} catch (error) {
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_get_ad_account",
			{
				annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true },
				description:
					"Read-only. Confirm the configured Meta ad account, status, currency, and timezone. Optionally inspect bounded job-title diagnostics, Brazilian city identifiers, aggregate reach estimates, or saved/custom audience metadata. Never retrieves audience members or changes targeting or ads.",
				inputSchema: {
					work_position_queries: z.array(z.string().trim().min(2).max(80)).min(1).max(5).optional(),
					work_position_ids: z.array(z.string().regex(META_ID_PATTERN)).min(1).max(20).optional(),
					geo_location_queries: z.array(z.string().trim().min(2).max(80)).min(1).max(5).optional(),
					reach_estimate_targeting: targetingSchema.optional(),
					audience_inventory: z.object({
						kind: z.enum(["saved", "custom"]),
						after: z.string().max(2_000).optional(),
						limit: z.number().int().min(1).max(100).default(100),
					}).strict().optional(),
				},
			},
			async ({ work_position_queries, work_position_ids, geo_location_queries, reach_estimate_targeting, audience_inventory }) => {
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
					const geoLocationSearch = geo_location_queries
						? await Promise.all(geo_location_queries.map(async (query) => {
							try {
								const response = z.object({ data: z.array(z.object({
									key: z.string(), name: z.string(), type: z.string().optional(),
									country_code: z.string().optional(), country_name: z.string().optional(),
									region: z.string().optional(),
									region_id: z.union([z.string(), z.number().int().nonnegative()]).transform(String).optional(),
								})).max(20) }).parse(await callMetaGraph(env, "GET", "search", {
									type: "adgeolocation", location_types: ["city"], country_code: "BR", q: query, limit: 20,
								}));
								// Whitelisted metadata only; never forward raw paging URLs or tokens.
								return { query, results: response.data };
							} catch (error) {
								return { query, diagnostic_error: asToolError(error).content[0].text };
							}
						})) : undefined;
					let reachEstimate: Record<string, unknown> | undefined;
					if (reach_estimate_targeting) {
						try {
							const estimateSchema = z.object({
								users_lower_bound: z.number().nonnegative().optional(),
								users_upper_bound: z.number().nonnegative().optional(),
								estimate_ready: z.boolean().optional(),
							});
							const response = z.object({
								data: z.union([estimateSchema, z.array(estimateSchema).max(20)]),
							}).parse(await callMetaGraph(env, "GET", `${accountId}/reachestimate`, {
								targeting_spec: reach_estimate_targeting,
							}));
							reachEstimate = { results: Array.isArray(response.data) ? response.data : [response.data] };
						} catch (error) {
							reachEstimate = { diagnostic_error: asToolError(error).content[0].text };
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
						geo_location_search: geoLocationSearch,
						reach_estimate: reachEstimate,
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
					"Read-only. Check Meta scopes and effective access to the configured ad account without exposing the token. The default is a minimal sequential check; bounded account inventory and asset diagnostics are independent opt-ins.",
				inputSchema: {
					business_access_diagnostic_id: z.string().regex(META_ID_PATTERN).max(30).optional().describe(
						"Opt-in read-only diagnostic for one explicit Business ID. Returns only the token subject and configured ad account; skips Page/WhatsApp and general account inventory fanout.",
					),
					include_account_inventory: z.boolean().default(false).describe(
						"Optionally scan up to 75 accessible ad accounts. Only configured-account metadata is returned; scan_complete means pagination was exhausted.",
					),
					include_asset_diagnostics: z.boolean().default(false).describe(
						"Optionally inspect accessible Pages and WhatsApp Business assets. Disabled by default to avoid request bursts.",
					),
				},
			},
			async ({
				business_access_diagnostic_id,
				include_account_inventory,
				include_asset_diagnostics,
			}) => {
				try {
					const env = this.env as MetaEnv;
					const { accountId, accountNumericId } = getMetaConfig(env);
					// Keep the default readiness check deliberately small and sequential.
					// Three concurrent chats previously multiplied the old fan-out into a
					// burst against the same Meta token and ad-account quota.
					const permissionResponse = await callMetaGraph(env, "GET", "me/permissions", {});
					const tokenSubject = await callMetaGraph(env, "GET", "me", { fields: "id,name" });
					const payload = graphListSchema.parse(permissionResponse);
					const accountAccessSchema = z.object({
						id: z.string().regex(/^act_\d+$/),
						account_id: z
							.union([z.string().regex(META_ID_PATTERN), z.number().int().nonnegative()])
							.transform(String),
						name: z.string(),
						account_status: z.number().int(),
					});
					let configuredAccount: z.infer<typeof accountAccessSchema> | null = null;
					let accountAccessError: string | null = null;
					try {
						const account = accountAccessSchema.parse(
							await callMetaGraph(env, "GET", accountId, {
								fields: "id,account_id,name,account_status",
							}),
						);
						if (account.id !== accountId || account.account_id !== accountNumericId) {
							throw new Error("Account access response does not match the configured ad account.");
						}
						configuredAccount = account;
					} catch (error) {
						accountAccessError = asToolError(error).content[0].text;
					}
					const configuredAccountAccessible = configuredAccount !== null;
					let accountInventory: Record<string, unknown> | undefined;
					if (include_account_inventory && !business_access_diagnostic_id) {
						const inventoryAccountSchema = accountAccessSchema.omit({ account_id: true });
						const inventoryPageSchema = z.object({
							data: z.array(inventoryAccountSchema).max(25),
							paging: z.object({
								next: z.string().optional(),
								cursors: z.object({
									after: z.string().min(1).max(2_000).optional(),
								}).optional(),
							}).optional(),
						});
						let inventoryConfiguredAccount: z.infer<typeof inventoryAccountSchema> | null = null;
						let scanComplete = false;
						let accountsScanned = 0;
						let inventoryError: string | undefined;
						let after: string | undefined;
						const seenCursors = new Set<string>();
						try {
							for (let page = 0; page < 3; page++) {
								const params: Record<string, string | number> = {
									fields: "id,name,account_status",
									limit: 25,
								};
								if (after) params.after = after;
								const parsed = inventoryPageSchema.safeParse(
									await callMetaGraph(env, "GET", "me/adaccounts", params),
								);
								if (!parsed.success) throw new Error("Invalid ad account inventory response.");
								const response = parsed.data;
								accountsScanned += response.data.length;
								inventoryConfiguredAccount =
									response.data.find((item) => item.id === accountId) ?? null;
								scanComplete = !response.paging?.next;
								if (inventoryConfiguredAccount || scanComplete) break;
								const nextAfter = response.paging?.cursors?.after;
								if (!nextAfter || seenCursors.has(nextAfter)) break;
								seenCursors.add(nextAfter);
								after = nextAfter;
							}
						} catch (error) {
							inventoryError = asToolError(error).content[0].text
								.replace(/https?:\/\/[^\s]+/gi, "[redacted URL]")
								.replace(/(?:after|before|cursor)=[^&\s]+/gi, "[redacted cursor]");
						}
						accountInventory = {
							configured_account_found: inventoryConfiguredAccount !== null,
							scan_complete: scanComplete,
							accounts_scanned: accountsScanned,
							configured_account: inventoryConfiguredAccount,
							diagnostic_error: inventoryError,
						};
					}
					if (business_access_diagnostic_id) accountInventory = { skipped: true, reason: "Business access diagnostic replaces general account inventory." };
					const businessAccessDiagnostic = business_access_diagnostic_id
						? /code=(?:4|17|32|613)\b/.test(accountAccessError || "")
							? { skipped: true, reason: "Stopped after the account read returned a rate-limit response." }
							: await inspectBusinessAccess(env, business_access_diagnostic_id, tokenSubject)
						: undefined;
					let accessiblePages: Array<Record<string, unknown>> = [];
					let pageAccessError: string | undefined;
					if (include_asset_diagnostics && !business_access_diagnostic_id) {
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
					}
					// Inspect only Pages already returned by the configured token. These
					// opt-in diagnostics are sequential and never invalidate readiness.
					const pageWhatsappDiagnostics: Array<Record<string, unknown>> = [];
					for (const page of accessiblePages) {
						const pageId = String(page.id || "");
						try {
							const details = await callMetaGraph(env, "GET", pageId, {
								fields: "id,whatsapp_number,has_whatsapp_number,has_whatsapp_business_number",
							});
							pageWhatsappDiagnostics.push({
								page_id: pageId,
								...z.record(z.string(), z.unknown()).parse(details),
							});
						} catch (error) {
							pageWhatsappDiagnostics.push({
								page_id: pageId,
								diagnostic_error: asToolError(error).content[0].text,
							});
						}
					}
					let whatsappAssetDiagnostics: Record<string, unknown> = {};
					if (business_access_diagnostic_id) {
						whatsappAssetDiagnostics = {
							skipped: true,
							reason: "Page and WhatsApp diagnostics are skipped in business access diagnostic mode.",
						};
					} else if (include_asset_diagnostics) {
						if (!configuredAccountAccessible) {
							whatsappAssetDiagnostics = {
								whatsapp_asset_error:
									"Skipped Business and WhatsApp asset diagnostics because configured ad account access was not confirmed.",
							};
						} else {
							try {
								const accountBusiness = z.object({
									id: z.string().regex(/^act_\d+$/),
									business: z.object({ id: z.string(), name: z.string().optional() }).optional(),
								}).passthrough().parse(
									await callMetaGraph(env, "GET", accountId, {
										fields: "id,business{id,name}",
									}),
								);
								if (accountBusiness.id !== accountId) {
									throw new Error("Business diagnostic response does not match the configured ad account.");
								}
								const business = accountBusiness.business;
								if (!business) {
									whatsappAssetDiagnostics = {
										whatsapp_asset_error:
											"The configured ad account has no Business Portfolio attached.",
									};
								} else {
									const businessId = business.id;
									const assets: Record<string, unknown> = {};
									try {
										assets.owned_whatsapp_business_accounts = graphListSchema.parse(
											await callMetaGraph(
												env,
												"GET",
												`${businessId}/owned_whatsapp_business_accounts`,
												{ fields: "id,name", limit: 100 },
											),
										).data;
									} catch (error) {
										assets.owned_whatsapp_business_accounts_error =
											asToolError(error).content[0].text;
									}
									try {
										assets.client_whatsapp_business_accounts = graphListSchema.parse(
											await callMetaGraph(
												env,
												"GET",
												`${businessId}/client_whatsapp_business_accounts`,
												{ fields: "id,name", limit: 100 },
											),
										).data;
									} catch (error) {
										assets.client_whatsapp_business_accounts_error =
											asToolError(error).content[0].text;
									}
									whatsappAssetDiagnostics = { business, ...assets };
								}
							} catch (error) {
								whatsappAssetDiagnostics = {
									whatsapp_asset_error: asToolError(error).content[0].text,
								};
							}
						}
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
					const scopeReadyForReads = granted.has("ads_read") || granted.has("ads_management");
					const scopeReadyForWrites = granted.has("ads_management");
					const writeSwitchEnabled = env.META_WRITE_ENABLED?.trim().toLowerCase() === "true";
					return asToolResult({
						configured_ad_account_id: accountId,
						account_accessible: configuredAccountAccessible,
						account_access_error: accountAccessError,
						account: configuredAccount,
						account_inventory: accountInventory,
						business_access_diagnostic: businessAccessDiagnostic,
						page_diagnostics_skipped: business_access_diagnostic_id ? true : undefined,
						asset_diagnostics_included:
							include_asset_diagnostics && !business_access_diagnostic_id,
						configured_account: configuredAccount ?? undefined,
						configured_account_accessible: configuredAccountAccessible,
						connector_version: CONNECTOR_VERSION,
						accessible_pages: accessiblePages,
						page_access_error: include_asset_diagnostics ? pageAccessError : undefined,
						page_whatsapp_diagnostics: pageWhatsappDiagnostics,
						whatsapp_assets: whatsappAssetDiagnostics,
						permissions,
						ready_for_reads: scopeReadyForReads && configuredAccountAccessible,
						ready_for_writes:
							scopeReadyForWrites && configuredAccountAccessible && writeSwitchEnabled,
						scope_ready_for_reads: scopeReadyForReads,
						scope_ready_for_writes: scopeReadyForWrites,
						write_access_verified: false,
						readiness_explanation:
							"Readiness reports token scopes, confirmed read access to the configured account, and the write switch. It does not verify permission to mutate ads; no write was attempted.",
						write_switch_enabled: writeSwitchEnabled,
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
							"id,name,status,effective_status,objective,daily_budget,lifetime_budget,bid_strategy,pacing_type,start_time,stop_time,created_time,updated_time",
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
					include_targeting_diagnostics: z.boolean().default(false),
					limit: z.number().int().min(1).max(100).default(25),
				},
			},
			async ({ after, campaign_id, include_targeting_diagnostics, limit }) => {
				try {
					const env = this.env as MetaEnv;
					const { accountId } = getMetaConfig(env);
					if (campaign_id) await getOwnedObject(env, "CAMPAIGN", campaign_id);
					const params: Record<string, string | number> = {
						fields:
							"id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy,destination_type,targeting,promoted_object,start_time,end_time,adset_schedule,pacing_type,created_time,updated_time",
						limit,
					};
					if (include_targeting_diagnostics) params.fields += ",targeting_optimization_types";
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
					"Read-only. List ads, creative details, and Meta delivery/review diagnostics from the configured account or one owned campaign/ad set. Omitted diagnostic fields do not confirm absence of issues.",
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
							"id,name,adset_id,campaign_id,status,effective_status,issues_info,ad_review_feedback,failed_delivery_checks,creative{id,name,object_story_spec,image_hash,thumbnail_url},created_time,updated_time",
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
				const env = this.env as MetaEnv;
				let operationHolder: string | undefined;
				let leaseAcquired = false;
				let postAttempted = false;
				try {
					assertWritesEnabled(env);
					assertConfirmation(
						confirmation_phrase,
						`SET ${object_type} ${object_id} ${status}`,
					);
					// Transport sessions can change between calls in one chat. Give
					// this invocation an unshared owner; never reuse a user/token ID.
					operationHolder = `operation:${crypto.randomUUID()}`;
					await acquireAccountWriteLease(
						env,
						operationHolder,
						`SET ${object_type} ${object_id} ${status}`,
					);
					leaseAcquired = true;
					const before = await getOwnedObject(env, object_type, object_id);
					if (before.id !== object_id) throw new Error("Object ID mismatch before status update.");
					assertExpectedName(before, expected_name);
					if (before.status !== "ACTIVE" && before.status !== "PAUSED") {
						throw new Error("Status update requires an object currently configured ACTIVE or PAUSED.");
					}
					if (before.status === status) {
						const warning = await releaseAccountOperationLease(env, operationHolder);
						return asToolResult({
							before,
							after: before,
							no_op: true,
							status_requested: status,
							write_lease_release_warning: warning,
						});
					}
					// Retain the lease after an uncertain POST path, including an
					// unavailable gate response. Only structured proof of no dispatch
					// permits early release. Never retry the mutation here.
					postAttempted = true;
					const result = writeResponseSchema.parse(
						await callMetaGraph(env, "POST", object_id, { status }, {
							write_lease_holder: operationHolder,
						}),
					);
					if (
						(result.success !== true && result.id !== object_id) ||
						result.success === false ||
						(result.id !== undefined && result.id !== object_id)
					) throw new Error("Meta did not confirm the requested status mutation.");
					const after = await getOwnedObject(env, object_type, object_id);
					if (after.id !== object_id || after.status !== status) {
						throw new Error("Status read-back did not confirm the requested object and configured status.");
					}
					assertExpectedName(after, expected_name);
					const preservedFields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
						.filter((key) => key !== "status" && key !== "effective_status" &&
							canonicalJson(before[key]) !== canonicalJson(after[key]));
					if (preservedFields.length) {
						throw new Error(`Status read-back changed other fields: ${preservedFields.join(", ")}.`);
					}
					auditMutation("set_delivery_status", {
						object_id,
						object_type,
						status,
					});
					const warning = await releaseAccountOperationLease(env, operationHolder);
					return asToolResult({ before, result, after, write_lease_release_warning: warning });
				} catch (error) {
					if (postAttempted && !(error instanceof MetaWriteNotDispatchedError)) {
						return asToolError(new Error(
							`WRITE_OUTCOME_UNCERTAIN: reconcile the object's current status before another write; this operation did not release its lease. ${error instanceof Error ? error.message : "Unexpected status error."}`,
						));
					}
					if (leaseAcquired && operationHolder) {
						const warning = await releaseAccountOperationLease(env, operationHolder);
						if (warning) return asToolError(new Error(
							`${error instanceof Error ? error.message : "Status preflight failed."} No Meta write was attempted. ${warning}`,
						));
					}
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_update_adset_age",
			{
				annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: false },
				description:
					"WRITE/PREVIEW. Update only age_min/age_max and optionally the name of one owned ad set. Defaults to validate_only. Requires exact current name and exact confirmation for a real write. Preserves the complete existing targeting, expansion settings, budget, schedule, destination, optimization, and configured status. Validates with Meta, checks for concurrent changes, and verifies the saved result. Never activates or creates objects.",
				inputSchema: {
					adset_id: z.string().regex(META_ID_PATTERN),
					age_min: z.number().int().min(18).max(65),
					age_max: z.number().int().min(18).max(65),
					confirmation_phrase: z.string().max(1_000).optional(),
					expected_name: z.string().min(1).max(500),
					name: z.string().trim().min(1).max(500).optional(),
					validate_only: z.boolean().default(true),
				},
			},
			async ({ adset_id, age_min, age_max, confirmation_phrase, expected_name, name, validate_only }) => {
				let writeAttempted = false;
				try {
					const env = this.env as MetaEnv;
					assertWritesEnabled(env);
					if (age_min > age_max) throw new Error("age_min must not exceed age_max.");
					const before = await getOwnedObject(env, "ADSET", adset_id, ADSET_AGE_AUDIT_FIELDS);
					assertExpectedName(before, expected_name);
					if (before.id !== adset_id) throw new Error("Ad-set ID did not match the requested object.");
					if (before.status !== "ACTIVE" && before.status !== "PAUSED") {
						throw new Error("Only ACTIVE or PAUSED ad sets may have their age updated.");
					}
					const targeting = targetingSchema.parse(before.targeting);
					if (!Number.isInteger(targeting.age_min) || !Number.isInteger(targeting.age_max)) {
						throw new Error("Cannot update ages without a complete current age_min/age_max snapshot.");
					}
					const nextTargeting = { ...targeting, age_min, age_max };
					const params: Record<string, string | number | boolean | object> = { targeting: nextTargeting };
					if (name !== undefined) params.name = name;
					const expected = { ...before, targeting: nextTargeting, name: name ?? before.name };
					const requiredConfirmation = `UPDATE ADSET AGE ${adset_id} ${age_min} ${age_max}${name !== undefined ? ` NAME ${name}` : ""}`;
					if (!validate_only) assertConfirmation(confirmation_phrase || "", requiredConfirmation);
					if (adsetAgeDifferences(expected, before).length === 0) {
						return asToolResult({ mode: "no_change", before, after: before, verified: true, required_confirmation: requiredConfirmation });
					}
					const validation = writeResponseSchema.parse(await callMetaGraph(env, "POST", adset_id, {
						...params, execution_options: ["validate_only"],
					}));
					if (validation.success !== true) throw new Error("Meta did not confirm successful age-update validation; no real write attempted.");
					const rechecked = await getOwnedObject(env, "ADSET", adset_id, ADSET_AGE_AUDIT_FIELDS);
					const concurrentChanges = adsetAgeDifferences(before, rechecked);
					if (concurrentChanges.length > 0) {
						throw new Error(`Ad set changed during validation (${concurrentChanges.join(", ")}); no real write attempted. Read current settings and validate again.`);
					}
					if (validate_only) {
						return asToolResult({ mode: "validate_only", before, proposed: expected, validation, verified_unchanged: true, required_confirmation: requiredConfirmation });
					}
					await acquireAccountWriteLease(
						env,
						this.ctx.id.toString(),
						requiredConfirmation,
					);
					writeAttempted = true;
					const result = writeResponseSchema.parse(await callMetaGraph(env, "POST", adset_id, params));
					const after = await getOwnedObject(env, "ADSET", adset_id, ADSET_AGE_AUDIT_FIELDS);
					const mismatches = adsetAgeDifferences(expected, after);
					const verified = result.success === true && mismatches.length === 0;
					auditMutation("update_adset_age", {
						adset_id, age_min, age_max, previous_age_min: targeting.age_min,
						previous_age_max: targeting.age_max, renamed: name !== undefined,
						verified, mismatches,
					});
					const response = asToolResult({ mode: "updated", before, result, after, verified, mismatches,
						...(!verified ? { warning: "Write attempted but saved settings did not pass verification. Inspect the returned snapshots before any further mutation; no automatic retry or rollback was performed." } : {}),
					});
					return verified ? response : { ...response, isError: true };
				} catch (error) {
					if (writeAttempted) {
						auditMutation("update_adset_age_unverified", { adset_id, age_min, age_max });
						return asToolError(new Error(`Real update was attempted; its final state is unverified. Read the ad set before retrying. ${error instanceof Error ? error.message : "Unknown error."}`));
					}
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_update_adset_geo",
			{
				annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: false },
				description:
					"WRITE/PREVIEW. Restrict one owned ad set to selected Southern Brazil states: Parana 452, Rio Grande do Sul 456, Santa Catarina 459. The current geography must cover Brazil or already include every requested state; city/radius audiences are never expanded. Replaces only geographic inclusions and sets individual_setting.geo=0. Preserves exclusions, location presence types, age, professions, other automation settings, budget, schedule, destination, optimization, name and configured status. Defaults to Meta validate_only; exact current name and confirmation are required for a real write. Uses an operation lease, concurrent-change checks and complete read-back verification. Never creates or activates objects.",
				inputSchema: {
					adset_id: z.string().regex(META_ID_PATTERN),
					confirmation_phrase: z.string().max(1_000).optional(),
					expected_name: z.string().min(1).max(500),
					region_keys: z.array(z.enum(SOUTH_BRAZIL_REGION_KEYS)).min(1).max(3)
						.refine((keys) => new Set(keys).size === keys.length, "Region keys must be unique."),
					validate_only: z.boolean().default(true),
				},
			},
			async ({ adset_id, confirmation_phrase, expected_name, region_keys, validate_only }) => {
				const env = this.env as MetaEnv;
				const regionKeys = [...region_keys].sort();
				const requiredConfirmation = `UPDATE ADSET GEO ${adset_id} REGIONS ${regionKeys.join(",")} GEO_EXPANSION 0`;
				let operationHolder: string | undefined;
				let leaseAcquired = false;
				let writeAttempted = false;
				try {
					assertWritesEnabled(env);
					if (!validate_only) assertConfirmation(confirmation_phrase || "", requiredConfirmation);
					operationHolder = `operation:${crypto.randomUUID()}`;
					await acquireAccountWriteLease(env, operationHolder, requiredConfirmation);
					leaseAcquired = true;
					const before = await getOwnedObject(env, "ADSET", adset_id, ADSET_AGE_AUDIT_FIELDS);
					if (before.id !== adset_id) throw new Error("Ad-set ID mismatch before geography update.");
					assertExpectedName(before, expected_name);
					if (before.status !== "ACTIVE" && before.status !== "PAUSED") {
						throw new Error("Geography update requires an ad set currently configured ACTIVE or PAUSED.");
					}
					const targeting = targetingSchema.parse(before.targeting);
					const nextTargeting = buildRestrictedSouthTargeting(targeting, regionKeys);
					const expected = { ...before, targeting: nextTargeting };
					const params = { targeting: nextTargeting };
					if (adsetGeoDifferences(expected, before).length === 0) {
						const warning = await releaseAccountOperationLease(env, operationHolder);
						return asToolResult({ mode: "no_change", before, after: before, verified: true,
							required_confirmation: requiredConfirmation, write_lease_release_warning: warning });
					}
					const validation = writeResponseSchema.parse(await callMetaGraph(env, "POST", adset_id, {
						...params, execution_options: ["validate_only"],
					}, { write_lease_holder: operationHolder }));
					if (validation.success !== true) throw new Error("Meta did not confirm successful geography validation; no real write attempted.");
					const rechecked = await getOwnedObject(env, "ADSET", adset_id, ADSET_AGE_AUDIT_FIELDS);
					const concurrentChanges = adsetGeoDifferences(before, rechecked);
					if (concurrentChanges.length) {
						throw new Error(`Ad set changed during geography validation (${concurrentChanges.join(", ")}); no real write attempted.`);
					}
					if (validate_only) {
						const warning = await releaseAccountOperationLease(env, operationHolder);
						return asToolResult({ mode: "validate_only", before, proposed: expected, validation,
							verified_unchanged: true, required_confirmation: requiredConfirmation, write_lease_release_warning: warning });
					}
					writeAttempted = true;
					const result = writeResponseSchema.parse(await callMetaGraph(env, "POST", adset_id, params, {
						write_lease_holder: operationHolder,
					}));
					if (result.success !== true || (result.id !== undefined && result.id !== adset_id)) {
						throw new Error("Meta did not confirm the requested geography mutation.");
					}
					const after = await getOwnedObject(env, "ADSET", adset_id, ADSET_AGE_AUDIT_FIELDS);
					const mismatches = adsetGeoDifferences(expected, after);
					if (mismatches.length) throw new Error(`Geography read-back changed or failed to preserve fields: ${mismatches.join(", ")}.`);
					auditMutation("update_adset_geo", { adset_id, region_keys: regionKeys, geo_expansion: 0, verified: true });
					const warning = await releaseAccountOperationLease(env, operationHolder);
					return asToolResult({ mode: "updated", before, result, after, verified: true, mismatches,
						write_lease_release_warning: warning });
				} catch (error) {
					if (writeAttempted && !(error instanceof MetaWriteNotDispatchedError)) {
						auditMutation("update_adset_geo_unverified", { adset_id, region_keys: regionKeys });
						return asToolError(new Error(
							`WRITE_OUTCOME_UNCERTAIN: real geography update was attempted; reconcile the complete ad-set snapshot before another write. Its operation lease was retained; no retry or rollback occurred. ${error instanceof Error ? error.message : "Unexpected geography error."}`,
						));
					}
					if (leaseAcquired && operationHolder) {
						const warning = await releaseAccountOperationLease(env, operationHolder);
						if (warning) return asToolError(new Error(
							`${error instanceof Error ? error.message : "Geography preflight failed."} No real Meta write was dispatched. ${warning}`,
						));
					}
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_configure_brevar_adset",
			{
				annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: false },
				description:
					"WRITE/PREVIEW. Apply the explicitly authorized BREVAR profile to one owned, unexpired BREVAR ad set: medical work-position profile PHYSICIANS_10, ages 25-50 with unknown ages disabled, both sexes, all Parana/Rio Grande do Sul/Santa Catarina, audience/geo and lookalike relaxation disabled, daily 06:00-23:00 America/Sao_Paulo (07:00-24:00 America/Noronha). Unlike geo restriction, this replaces city/radius coverage and removes exclusions of the three included states. Requires current detailed/lookalike diagnostics explicitly zero; does not write read-only diagnostics. Preserves other targeting settings, budgets at both levels, objective, optimization, destination, dates and configured status. Requires an existing lifetime budget, never converts or transfers budgets. With ABO it sets and verifies ad-set day_parting. With CBO it never writes child pacing; verified reports saved fields while delivery_schedule_verified separately requires parent campaign day_parting before activation. Meta validate_only is the default; real changes require exact current ad-set/campaign names and confirmation. Uses one operation lease, validation, concurrent-change checks and complete read-back. Never activates, creates, changes the campaign, or bypasses Instagram boosted-post restrictions.",
				inputSchema: {
					adset_id: z.string().regex(META_ID_PATTERN),
					expected_name: z.string().min(1).max(500),
					expected_campaign_name: z.string().min(1).max(500),
					name: z.string().trim().min(1).max(500).optional(),
					confirmation_phrase: z.string().max(1_000).optional(),
					validate_only: z.boolean().default(true),
				},
			},
			async ({ adset_id, expected_name, expected_campaign_name, name, confirmation_phrase, validate_only }) => {
				const env = this.env as MetaEnv;
				const requiredConfirmation = `CONFIGURE BREVAR ADSET ${adset_id} SOUTH_BR PHYSICIANS_10 AGE 25 50 HOURS 06-23 AMERICA_SAO_PAULO${name !== undefined ? ` NAME ${name}` : ""}`;
				let operationHolder: string | undefined;
				let leaseAcquired = false;
				let writeAttempted = false;
				try {
					assertWritesEnabled(env);
					if (!validate_only) assertConfirmation(confirmation_phrase || "", requiredConfirmation);
					operationHolder = `operation:${crypto.randomUUID()}`;
					await acquireAccountWriteLease(env, operationHolder, requiredConfirmation);
					leaseAcquired = true;
					const { accountId, accountNumericId } = getMetaConfig(env);
					const readTimezone = async () => {
						const account = z.object({ id: z.string(), account_id: z.union([z.string(), z.number()]), timezone_name: z.string() })
							.parse(await callMetaGraph(env, "GET", accountId, { fields: "id,account_id,timezone_name" }));
						if (account.id !== accountId || String(account.account_id) !== accountNumericId) throw new Error("Account timezone belongs to a different account.");
						return account.timezone_name;
					};
					const timezone = await readTimezone();
					const schedule = brevarSchedule(timezone);
					const before = await getOwnedObject(env, "ADSET", adset_id, ADSET_AGE_AUDIT_FIELDS);
					if (before.id !== adset_id) throw new Error("Ad-set ID mismatch before BREVAR configuration.");
					assertExpectedName(before, expected_name);
					if (before.status !== "ACTIVE" && before.status !== "PAUSED") throw new Error("BREVAR configuration requires an ACTIVE or PAUSED ad set.");
					const campaignId = z.string().regex(META_ID_PATTERN).parse(before.campaign_id);
					const campaign = await getOwnedObject(env, "CAMPAIGN", campaignId, BREVAR_CAMPAIGN_AUDIT_FIELDS);
					if (campaign.id !== campaignId) throw new Error("Parent campaign ID mismatch.");
					assertExpectedName(campaign, expected_campaign_name);
					if (!/\bBREVAR\b/i.test(campaign.name)) throw new Error("The owned parent campaign must identify BREVAR; other courses and unclassified boosts are not supported.");
					if (campaign.status !== "ACTIVE" && campaign.status !== "PAUSED") throw new Error("BREVAR configuration requires an ACTIVE or PAUSED parent campaign.");
					const start = typeof before.start_time === "string" ? Date.parse(before.start_time) : NaN;
					const end = typeof before.end_time === "string" ? Date.parse(before.end_time) : NaN;
					if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end <= Date.now()) {
						throw new Error("BREVAR configuration requires complete ordered dates and an unexpired end_time; no dates are extended by this tool.");
					}
					if (campaign.stop_time !== undefined && (!Number.isFinite(Date.parse(String(campaign.stop_time))) || Date.parse(String(campaign.stop_time)) <= Date.now())) {
						throw new Error("BREVAR parent campaign has an invalid or expired stop_time; no dates are extended.");
					}
					const budget = (value: unknown) => {
						if (value === undefined) return 0;
						if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error("Incomplete or invalid budget snapshot.");
						return Number(value);
					};
					const campaignLifetime = budget(campaign.lifetime_budget);
					const adsetLifetime = budget(before.lifetime_budget);
					if (budget(campaign.daily_budget) || budget(before.daily_budget) || (!campaignLifetime && !adsetLifetime) || (campaignLifetime && adsetLifetime)) {
						throw new Error("BREVAR daily schedule requires exactly one existing lifetime budget source and no daily budget. No budget conversion or transfer is supported.");
					}
					assertBrevarExpansionDisabled(before);
					const targeting = buildBrevarTargeting(targetingSchema.parse(before.targeting));
					const currentPacing = z.array(z.string()).optional().parse(before.pacing_type) ?? [];
					if (!campaignLifetime && currentPacing.includes("no_pacing")) throw new Error("Accelerated/no_pacing delivery needs separate review before adding day_parting.");
					const pacing = [...new Set([...currentPacing, "day_parting"])];
					const parentPacing = z.array(z.string()).optional().parse(campaign.pacing_type) ?? [];
					const deliveryScheduleVerified = !campaignLifetime || parentPacing.includes("day_parting");
					// With CBO, pacing belongs to the parent campaign. Do not write a
					// shadow ad-set field or pretend its omission proves day_parting.
					const params: Record<string, string | number | boolean | object> = { targeting, adset_schedule: schedule,
						...(!campaignLifetime ? { pacing_type: pacing } : {}) };
					if (name !== undefined) params.name = name;
					const expected = { ...before, ...params };
					if (brevarDifferences(expected, before).length === 0) {
						const warning = await releaseAccountOperationLease(env, operationHolder);
						return asToolResult({ mode: "no_change", before, after: before, campaign_before: campaign, campaign_after: campaign,
							timezone_name: timezone, verified: true, delivery_schedule_verified: deliveryScheduleVerified,
							schedule_note: deliveryScheduleVerified ? "Delivery schedule control is present at the budget-owning level." : "Child fields and windows are verified, but parent campaign day_parting is not confirmed. Configure and audit parent pacing before activation.",
							required_confirmation: requiredConfirmation, write_lease_release_warning: warning });
					}
					const validation = writeResponseSchema.parse(await callMetaGraph(env, "POST", adset_id, {
						...params, execution_options: ["validate_only"],
					}, { write_lease_holder: operationHolder }));
					if (validation.success !== true) throw new Error("Meta did not confirm successful BREVAR configuration validation; no real write attempted.");
					if (!validate_only) {
						// Wait outside the account gateway so unrelated read-only traffic
						// can continue. The operation lease still excludes connector writes.
						// Every concurrent-change read is deliberately AFTER this wait.
						await delay(BREVAR_SAME_OBJECT_POST_GAP_MS);
						await assertAccountOperationLease(env, operationHolder);
					}
					const rechecked = await getOwnedObject(env, "ADSET", adset_id, ADSET_AGE_AUDIT_FIELDS);
					const campaignRechecked = await getOwnedObject(env, "CAMPAIGN", campaignId, BREVAR_CAMPAIGN_AUDIT_FIELDS);
					const concurrent = brevarDifferences(before, rechecked);
					const campaignConcurrent = adsetAgeDifferences(campaign, campaignRechecked);
					if (concurrent.length || campaignConcurrent.length || await readTimezone() !== timezone) {
						throw new Error(`BREVAR settings changed during validation (adset: ${concurrent.join(", ")}; campaign: ${campaignConcurrent.join(", ")}; account timezone also rechecked). No real write attempted.`);
					}
					if (end <= Date.now()) throw new Error("BREVAR end_time elapsed during validation; no real write attempted.");
					if (validate_only) {
						const warning = await releaseAccountOperationLease(env, operationHolder);
						return asToolResult({ mode: "validate_only", before, proposed: expected, campaign_before: campaign, campaign_after: campaignRechecked,
							timezone_name: timezone, validation, verified_unchanged: true, delivery_schedule_verified: false,
							proposed_delivery_schedule_verified: deliveryScheduleVerified, required_confirmation: requiredConfirmation, write_lease_release_warning: warning });
					}
					writeAttempted = true;
					const result = writeResponseSchema.parse(await callMetaGraph(env, "POST", adset_id, params, { write_lease_holder: operationHolder }));
					if (result.success !== true || (result.id !== undefined && result.id !== adset_id)) throw new Error("Meta did not confirm the requested BREVAR configuration mutation.");
					const after = await getOwnedObject(env, "ADSET", adset_id, ADSET_AGE_AUDIT_FIELDS);
					const campaignAfter = await getOwnedObject(env, "CAMPAIGN", campaignId, BREVAR_CAMPAIGN_AUDIT_FIELDS);
					assertBrevarExpansionDisabled(after);
					const mismatches = brevarDifferences(expected, after);
					const campaignMismatches = adsetAgeDifferences(campaign, campaignAfter);
					if (mismatches.length || campaignMismatches.length || await readTimezone() !== timezone) {
						throw new Error(`BREVAR read-back failed (adset: ${mismatches.join(", ")}; campaign: ${campaignMismatches.join(", ")}; account timezone also rechecked).`);
					}
					auditMutation("configure_brevar_adset", { adset_id, campaign_id: campaignId, profile: "PHYSICIANS_10", age_min: 25, age_max: 50,
						regions: SOUTH_BRAZIL_REGION_KEYS, schedule_timezone: timezone, renamed: name !== undefined, verified: true });
					const warning = await releaseAccountOperationLease(env, operationHolder);
					return asToolResult({ mode: "updated", before, result, after, campaign_before: campaign, campaign_after: campaignAfter,
						timezone_name: timezone, verified: true, mismatches, delivery_schedule_verified: deliveryScheduleVerified,
						schedule_note: deliveryScheduleVerified ? "Delivery schedule control is present at the budget-owning level." : "Child fields and windows are verified, but parent campaign day_parting is not confirmed. Configure and audit parent pacing before activation.",
						write_lease_release_warning: warning });
				} catch (error) {
					if (writeAttempted && !(error instanceof MetaWriteNotDispatchedError)) {
						auditMutation("configure_brevar_adset_unverified", { adset_id });
						return asToolError(new Error(`WRITE_OUTCOME_UNCERTAIN: BREVAR configuration was attempted; reconcile the ad set and campaign before another write. Its operation lease was retained; no retry or rollback occurred. ${error instanceof Error ? error.message : "Unexpected configuration error."}`));
					}
					if (leaseAcquired && operationHolder) {
						const warning = await releaseAccountOperationLease(env, operationHolder);
						if (warning) return asToolError(new Error(`${error instanceof Error ? error.message : "BREVAR preflight failed."} No real Meta write was dispatched. ${warning}`));
					}
					return asToolError(error);
				}
			},
		);

		this.server.registerTool(
			"meta_configure_brevar_campaign_pacing",
			{
				annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: false },
				description: "WRITE/PREVIEW. Set only pacing_type=['day_parting'] on one owned, unexpired BREVAR lifetime-budget campaign. Normally every owned child, including paused children, must already have the exact daily 06:00-23:00 Brasilia schedule and no child budget. The explicit allow_unscheduled_children preparation option permits only absent child schedules while the parent remains PAUSED; present divergent schedules still fail. It requires its own confirmation suffix and reports pending child IDs with delivery_schedule_verified=false until all calendars match. Requires exact campaign name and expected existing lifetime cap; never changes budget amounts, child schedules, names, statuses, targeting or dates. Defaults to Meta validate_only. A real update waits 31s after validation, rechecks its lease and the complete parent/children/timezone snapshots, then verifies all saved fields. No automatic retry, activation or object creation. Uncertain real outcomes retain the operation lease.",
				inputSchema: {
					campaign_id: z.string().regex(META_ID_PATTERN), expected_name: z.string().min(1).max(500),
					expected_lifetime_budget_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
					allow_unscheduled_children: z.boolean().default(false),
					validate_only: z.boolean().default(true), confirmation_phrase: z.string().max(1_000).optional(),
				},
			},
			async ({ campaign_id, expected_name, expected_lifetime_budget_minor, allow_unscheduled_children, validate_only, confirmation_phrase }) => {
				const env = this.env as MetaEnv;
				const requiredConfirmation = `CONFIGURE BREVAR CAMPAIGN PACING ${campaign_id} DAY_PARTING LIFETIME ${expected_lifetime_budget_minor}${allow_unscheduled_children ? " ALLOW_UNSCHEDULED_CHILDREN_WHILE_PAUSED" : ""}`;
				let holder: string | undefined;
				let acquired = false;
				let writeAttempted = false;
				try {
					assertWritesEnabled(env);
					if (!validate_only) assertConfirmation(confirmation_phrase || "", requiredConfirmation);
					holder = `operation:${crypto.randomUUID()}`;
					await acquireAccountWriteLease(env, holder, requiredConfirmation);
					acquired = true;
					const { accountId, accountNumericId } = getMetaConfig(env);
					const read = async () => {
						const account = z.object({ id: z.string(), account_id: z.union([z.string(), z.number()]), timezone_name: z.string() })
							.parse(await callMetaGraph(env, "GET", accountId, { fields: "id,account_id,timezone_name" }));
						if (account.id !== accountId || String(account.account_id) !== accountNumericId) throw new Error("Campaign pacing account identity mismatch.");
						brevarSchedule(account.timezone_name);
						const campaign = await getOwnedObject(env, "CAMPAIGN", campaign_id, BREVAR_CAMPAIGN_AUDIT_FIELDS);
						if (campaign.id !== campaign_id) throw new Error("Campaign pacing ID mismatch.");
						const children = graphListSchema.parse(await callMetaGraph(env, "GET", `${campaign_id}/adsets`, {
							fields: `id,name,account_id,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,destination_type,promoted_object,${ADSET_AGE_AUDIT_FIELDS}`, limit: 100,
						}));
						if (children.paging?.next || children.data.length === 100) throw new Error("Campaign child snapshot may be incomplete; no pacing change attempted.");
						if (!children.data.length) throw new Error("Campaign pacing requires at least one fully audited child ad set.");
						const adsets = children.data.map((raw) => {
							const child = objectSchema.parse(raw);
							if (!META_ID_PATTERN.test(child.id) || String(child.account_id).replace(/^act_/, "") !== accountNumericId || child.campaign_id !== campaign_id) throw new Error("Campaign child identity or ownership mismatch.");
							return child;
						}).sort((a, b) => a.id.localeCompare(b.id));
						if (new Set(adsets.map((child) => child.id)).size !== adsets.length) throw new Error("Duplicate campaign child snapshot.");
						return { campaign, adsets, timezone_name: account.timezone_name };
					};
					const before = await read();
					assertExpectedName(before.campaign, expected_name);
					if (!/\bBREVAR\b/i.test(before.campaign.name)) throw new Error("Only an explicitly identified BREVAR campaign is supported.");
					if (!["ACTIVE", "PAUSED"].includes(String(before.campaign.status))) throw new Error("Campaign pacing requires an ACTIVE or PAUSED campaign.");
					if (allow_unscheduled_children && before.campaign.status !== "PAUSED") throw new Error("Preparing missing child schedules requires the parent campaign to remain PAUSED.");
					const noBudget = (value: unknown) => value === undefined || value === "0" || value === 0;
					if (String(before.campaign.lifetime_budget) !== String(expected_lifetime_budget_minor) || !noBudget(before.campaign.daily_budget)) throw new Error("Campaign lifetime cap differs from the expected existing budget, or uses daily budgeting.");
					const stop = typeof before.campaign.stop_time === "string" ? Date.parse(before.campaign.stop_time) : NaN;
					if (!Number.isFinite(stop) || stop <= Date.now()) throw new Error("Campaign pacing requires an unexpired stop_time; no date is extended.");
					const currentPacing = z.array(z.string()).optional().parse(before.campaign.pacing_type) ?? [];
					if (currentPacing.some((value) => !["standard", "day_parting"].includes(value))) throw new Error("Existing campaign pacing needs separate review before day_parting.");
					const scheduled = brevarSchedule(before.timezone_name);
					const pendingAdsetIds: string[] = [];
					for (const child of before.adsets) {
						if (!["ACTIVE", "PAUSED"].includes(String(child.status)) || !noBudget(child.daily_budget) || !noBudget(child.lifetime_budget)) throw new Error(`Child ${child.id} must be active/paused and use only the parent lifetime budget.`);
						const childEnd = typeof child.end_time === "string" ? Date.parse(child.end_time) : NaN;
						if (!Number.isFinite(childEnd) || childEnd <= Date.now()) throw new Error(`Child ${child.id} has no valid future end_time.`);
						if (allow_unscheduled_children && child.adset_schedule === undefined) {
							pendingAdsetIds.push(child.id);
						} else if (brevarDifferences({ ...child, adset_schedule: scheduled }, child).length) {
							throw new Error(`Child ${child.id} does not have the exact 06:00-23:00 Brasilia schedule. Only absent schedules may be prepared while the parent remains PAUSED; present divergent calendars must be corrected first.`);
						}
					}
					const differences = (expected: typeof before, actual: typeof before) => {
						const diff = adsetAgeDifferences(expected.campaign, actual.campaign).map((key) => `campaign.${key}`);
						if (expected.timezone_name !== actual.timezone_name) diff.push("account.timezone_name");
						if (canonicalJson(expected.adsets.map((child) => child.id)) !== canonicalJson(actual.adsets.map((child) => child.id))) diff.push("adsets.ids");
						for (const child of expected.adsets) {
							const found = actual.adsets.find((candidate) => candidate.id === child.id);
							if (found) diff.push(...brevarDifferences(child, found).map((key) => `adset.${child.id}.${key}`));
						}
						return diff;
					};
					const params = { pacing_type: ["day_parting"] };
					const expected = { ...before, campaign: { ...before.campaign, ...params } };
					if (!differences(expected, before).length) {
						const warning = await releaseAccountOperationLease(env, holder);
						return asToolResult({ mode: "no_change", before, after: before, verified: true, delivery_schedule_verified: pendingAdsetIds.length === 0,
							pending_adset_ids: pendingAdsetIds, preparation_only: allow_unscheduled_children && pendingAdsetIds.length > 0,
							required_confirmation: requiredConfirmation, write_lease_release_warning: warning });
					}
					const validation = writeResponseSchema.parse(await callMetaGraph(env, "POST", campaign_id, { ...params, execution_options: ["validate_only"] }, { write_lease_holder: holder }));
					if (validation.success !== true) throw new Error("Meta did not validate parent campaign day_parting; no real write attempted.");
					if (!validate_only) { await delay(BREVAR_SAME_OBJECT_POST_GAP_MS); await assertAccountOperationLease(env, holder); }
					const rechecked = await read();
					if (allow_unscheduled_children && rechecked.campaign.status !== "PAUSED") throw new Error("Parent campaign stopped being PAUSED during preparation; no real write attempted.");
					const concurrent = differences(before, rechecked);
					if (concurrent.length) throw new Error(`Campaign or children changed during pacing validation: ${concurrent.join(", ")}. No real write attempted.`);
					if (stop <= Date.now() || before.adsets.some((child) => Date.parse(String(child.end_time)) <= Date.now())) throw new Error("Campaign or child end_time elapsed during validation; no real write attempted.");
					if (validate_only) {
						const warning = await releaseAccountOperationLease(env, holder);
						return asToolResult({ mode: "validate_only", before, proposed: expected, validation, verified_unchanged: true,
							delivery_schedule_verified: currentPacing.includes("day_parting") && pendingAdsetIds.length === 0,
							pending_adset_ids: pendingAdsetIds, preparation_only: allow_unscheduled_children && pendingAdsetIds.length > 0,
							required_confirmation: requiredConfirmation, write_lease_release_warning: warning });
					}
					writeAttempted = true;
					const result = writeResponseSchema.parse(await callMetaGraph(env, "POST", campaign_id, params, { write_lease_holder: holder }));
					if (result.success !== true || (result.id !== undefined && result.id !== campaign_id)) throw new Error("Meta did not confirm the parent pacing mutation.");
					const after = await read();
					if (allow_unscheduled_children && after.campaign.status !== "PAUSED") throw new Error("Parent campaign is not PAUSED after preparation read-back.");
					const mismatches = differences(expected, after);
					if (mismatches.length) throw new Error(`Parent pacing read-back failed: ${mismatches.join(", ")}.`);
					auditMutation("configure_brevar_campaign_pacing", { campaign_id, lifetime_budget_minor: expected_lifetime_budget_minor, child_count: before.adsets.length,
						allow_unscheduled_children, pending_adset_ids: pendingAdsetIds, verified: true, delivery_schedule_verified: pendingAdsetIds.length === 0 });
					const warning = await releaseAccountOperationLease(env, holder);
					return asToolResult({ mode: "updated", before, result, after, verified: true, delivery_schedule_verified: pendingAdsetIds.length === 0,
						pending_adset_ids: pendingAdsetIds, preparation_only: allow_unscheduled_children && pendingAdsetIds.length > 0,
						mismatches, write_lease_release_warning: warning });
				} catch (error) {
					if (writeAttempted && !(error instanceof MetaWriteNotDispatchedError)) return asToolError(new Error(`WRITE_OUTCOME_UNCERTAIN: parent pacing was attempted; reconcile the campaign and all children before another write. Its operation lease was retained, without retry or rollback. ${error instanceof Error ? error.message : "Unexpected pacing error."}`));
					if (acquired && holder) {
						const warning = await releaseAccountOperationLease(env, holder);
						if (warning) return asToolError(new Error(`${error instanceof Error ? error.message : "Pacing preflight failed."} No real Meta write was dispatched. ${warning}`));
					}
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
					await acquireAccountWriteLease(
						env,
						this.ctx.id.toString(),
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
					if (daily_budget_minor === undefined && lifetime_budget_minor === undefined) {
						params.is_adset_budget_sharing_enabled = false;
					}
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
					await acquireAccountWriteLease(
						env,
						this.ctx.id.toString(),
						`CREATE CAMPAIGN ${name}`,
					);
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
					adset_schedule: adsetScheduleSchema.optional(),
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
					destination_type: z.enum(["ON_POST", "WEBSITE", "WHATSAPP"]).optional(),
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
						"POST_ENGAGEMENT",
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
				adset_schedule,
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
					const promotedObjectForMeta = promoted_object
						? { ...promoted_object }
						: undefined;
					const compatibilityWhatsappPhone = String(
						promotedObjectForMeta?.whatsapp_phone_number || "",
					);
					if (compatibilityWhatsappPhone && !/^\d{10,15}$/.test(compatibilityWhatsappPhone)) {
						throw new Error("promoted_object.whatsapp_phone_number must contain 10 to 15 digits.");
					}
					if (compatibilityWhatsappPhone && destination_type !== undefined && destination_type !== "WHATSAPP") {
						throw new Error(`destination_type ${destination_type} conflicts with promoted_object.whatsapp_phone_number.`);
					}
					if (destination_type === "WHATSAPP") {
						if (!compatibilityWhatsappPhone) {
							throw new Error("Explicit WHATSAPP destination requires promoted_object.whatsapp_phone_number.");
						}
						if (optimization_goal !== "CONVERSATIONS" && optimization_goal !== "LINK_CLICKS") {
							throw new Error("Explicit WHATSAPP destination requires optimization_goal CONVERSATIONS or LINK_CLICKS.");
						}
					}
					if (destination_type === "ON_POST" && optimization_goal !== "POST_ENGAGEMENT" && optimization_goal !== "REACH") {
						throw new Error("Explicit ON_POST destination requires optimization_goal POST_ENGAGEMENT or REACH.");
					}
					const { accountId } = getMetaConfig(env);
					const campaign = await getOwnedObject(env, "CAMPAIGN", campaign_id);
					assertExpectedName(campaign, expected_campaign_name);
					if (adset_schedule) {
						// CBO pacing belongs on the campaign; do not silently mix levels.
						if (Number(campaign.daily_budget || 0) > 0 || Number(campaign.lifetime_budget || 0) > 0) {
							throw new Error("Scheduled creation currently requires an ad-set lifetime budget and no campaign budget.");
						}
						if (!lifetime_budget_minor || daily_budget_minor !== undefined) {
							throw new Error("adset_schedule requires lifetime_budget_minor and no daily budget.");
						}
						const explicitZone = /(Z|[+-]\d{2}:?\d{2})$/;
						if (!start_time || !end_time || !explicitZone.test(start_time) || !explicitZone.test(end_time)
							|| !Number.isFinite(Date.parse(start_time)) || !Number.isFinite(Date.parse(end_time))
							|| Date.parse(end_time) <= Date.parse(start_time)) {
							throw new Error("Scheduled creation requires ordered start_time/end_time with explicit timezone offsets.");
						}
					}
					if (compatibilityWhatsappPhone) {
						if (String(campaign.objective || "") !== "OUTCOME_ENGAGEMENT") {
							throw new Error("WhatsApp ad sets require an OUTCOME_ENGAGEMENT campaign.");
						}
						// This is a real Graph API field, not a helper-only marker.
						// Preserve the selected phone so Meta does not resolve a different
						// default number on a Page that has multiple linked numbers.
					}
					// Legacy callers omit destination_type and historically resolve to
					// conversations. An explicit WhatsApp destination preserves the
					// requested supported goal instead of silently replacing it.
					const resolvedOptimizationGoal = compatibilityWhatsappPhone && destination_type === undefined
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
					if (adset_schedule) {
						params.adset_schedule = adset_schedule;
						params.pacing_type = ["day_parting"];
					}
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
							resolved_destination_type: params.destination_type ?? null,
							resolved_optimization_goal: params.optimization_goal,
							status_for_create: "PAUSED",
							validation,
						});
					}
					assertConfirmation(
						confirmation_phrase || "",
						`CREATE ADSET ${campaign_id} ${name}`,
					);
					await acquireAccountWriteLease(
						env,
						this.ctx.id.toString(),
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
			"meta_upload_creative_asset",
			{
				annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: false },
				description:
					"WRITE/LOCAL PREVIEW. Upload one deliberately public raster asset already present in this Worker's immutable creative manifest to the configured ad account's image library. Accepts only a manifest path, never caller bytes or external URLs. validate_only defaults to a local preview with MIME, size and SHA-256; it does not contact or validate with Meta. Real upload requires exact confirmation, enabled writes, confirmed account identity and an operation lease. Verifies the returned hash and account identity by read-back, and reports Meta's image name (bytes uploads may receive a generated name). Never creates ads, activates delivery or changes budgets. A possibly dispatched upload is never retried automatically.",
				inputSchema: {
					asset_path: z.string().max(300).regex(/^\/creative-assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpg|jpeg|png)$/),
					confirmation_phrase: z.string().max(500).optional(),
					validate_only: z.boolean().default(true),
				},
			},
			async ({ asset_path, confirmation_phrase, validate_only }) => {
				const env = this.env as MetaEnv;
				let operationHolder: string | undefined;
				let leaseAcquired = false;
				let writeAttempted = false;
				try {
					assertWritesEnabled(env);
					const { accountId, accountNumericId } = getMetaConfig(env);
					const requiredConfirmation = `UPLOAD CREATIVE ASSET ${accountId} ${asset_path}`;
					if (!validate_only) assertConfirmation(confirmation_phrase || "", requiredConfirmation);
					// This serves bytes directly from CREATIVE_ASSETS. No URL fetch or
					// filesystem lookup occurs, and the handler verifies raster signatures.
					const asset = getCreativeAssetResponse(new Request(`https://creative-assets.internal${asset_path}`));
					if (!asset || !asset.ok) throw new Error("Creative asset path is absent from the public manifest or its raster bytes are invalid.");
					const mimeType = asset.headers.get("Content-Type");
					if (mimeType !== "image/jpeg" && mimeType !== "image/png") throw new Error("Creative asset must be a public JPEG or PNG.");
					const buffer = await asset.arrayBuffer();
					if (!buffer.byteLength || buffer.byteLength > 10 * 1024 * 1024) throw new Error("Creative asset must contain 1 through 10 MiB of raster bytes.");
					const bytes = new Uint8Array(buffer);
					const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)), (byte) => byte.toString(16).padStart(2, "0")).join("");
					const imageName = asset_path.slice("/creative-assets/".length);
					const proposed = { account_id: accountId, asset_path, image_name: imageName, mime_type: mimeType, size_bytes: bytes.byteLength, sha256 };
					if (validate_only) return asToolResult({
						mode: "local_preview", meta_validation_performed: false, meta_write_performed: false,
						proposed, required_confirmation: requiredConfirmation,
					});
					operationHolder = `operation:${crypto.randomUUID()}`;
					await acquireAccountWriteLease(env, operationHolder, requiredConfirmation);
					leaseAcquired = true;
					const account = z.object({ id: z.string(), account_id: z.union([z.string(), z.number()]) }).parse(
						await callMetaGraph(env, "GET", accountId, { fields: "id,account_id" }),
					);
					if (account.id !== accountId || String(account.account_id) !== accountNumericId) throw new Error("Configured account identity was not confirmed; no image upload was attempted.");
					const chunks: string[] = [];
					for (let offset = 0; offset < bytes.length; offset += 8192) {
						chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
					}
					writeAttempted = true;
					const uploaded = z.object({ images: z.record(z.string(), z.object({ hash: z.string().regex(/^[a-fA-F0-9]{32}$/), name: z.string().min(1).optional() })) }).parse(
						await callMetaGraph(env, "POST", `${accountId}/adimages`, { bytes: btoa(chunks.join("")) }, { write_lease_holder: operationHolder }),
					);
					const images = Object.values(uploaded.images);
					if (images.length !== 1) throw new Error("Meta upload response did not identify exactly one image hash.");
					const imageHash = images[0].hash;
					const imageList = z.object({ data: z.array(z.object({ hash: z.string(), name: z.string().min(1), account_id: z.union([z.string(), z.number()]) })) }).parse(
						await callMetaGraph(env, "GET", `${accountId}/adimages`, { fields: "hash,name,account_id", hashes: [imageHash], limit: 2 }),
					);
					if (imageList.data.length !== 1 || imageList.data[0].hash !== imageHash
						|| String(imageList.data[0].account_id).replace(/^act_/, "") !== accountNumericId
						|| (images[0].name !== undefined && imageList.data[0].name !== images[0].name)) {
						throw new Error("Account-bound image read-back did not confirm the uploaded hash, account and returned Meta name.");
					}
					auditMutation("upload_creative_asset", { account_id: accountId, asset_path, sha256, image_hash: imageHash, verified: true });
					const warning = await releaseAccountOperationLease(env, operationHolder);
					return asToolResult({ mode: "uploaded", ...proposed, image_hash: imageHash,
						meta_image_name: imageList.data[0].name,
						name_verification: images[0].name === undefined ? "read_from_account_library" : "matches_upload_response",
						verified: true, write_lease_release_warning: warning });
				} catch (error) {
					if (writeAttempted && !(error instanceof MetaWriteNotDispatchedError)) {
						auditMutation("upload_creative_asset_unverified", { asset_path });
						return asToolError(new Error(`WRITE_OUTCOME_UNCERTAIN: image upload may have been dispatched; reconcile the account image library before another upload. Its operation lease was retained; no retry occurred. ${error instanceof Error ? error.message : "Unexpected image upload error."}`));
					}
					if (leaseAcquired && operationHolder) {
						const warning = await releaseAccountOperationLease(env, operationHolder);
						if (warning) return asToolError(new Error(`${error instanceof Error ? error.message : "Creative asset preflight failed."} No image upload was dispatched. ${warning}`));
					}
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
					await acquireAccountWriteLease(
						env,
						this.ctx.id.toString(),
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
			"meta_update_brevar_ad_creative",
			{
				annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false },
				description: "WRITE/PREVIEW. Correct a PAUSED existing BREVAR link-image ad while preserving its ad ID, ad set, campaign, names, configured status, audience, schedule and budgets. Validates account-owned image and approved Stoicus Page/WhatsApp or BREVAR course URL. Defaults to a no-create Meta validate_only preview. A real operation requires exact name, request_id and confirmation; it creates one replacement creative and attaches it to the same ad without activating anything. Uses a durable lease-protected journal: uncertain partial operations are never automatically repeated. Native Instagram boosts and existing-post/dynamic/video formats are not supported or bypassed.",
				inputSchema: {
					ad_id: z.string().regex(META_ID_PATTERN), expected_name: z.string().min(1).max(500),
					message: z.string().min(1).max(5_000), headline: z.string().min(1).max(500), description: z.string().max(1_000).default(""),
					image_hash: z.string().regex(/^[a-fA-F0-9]{32}$/), link_url: z.string().url().max(2_000),
					request_id: z.string().uuid(), validate_only: z.boolean().default(true), confirmation_phrase: z.string().max(1_000).optional(),
				},
			},
			async ({ ad_id, expected_name, message, headline, description, image_hash, link_url, request_id, validate_only, confirmation_phrase }) => {
				const env = this.env as MetaEnv;
				let holder: string | undefined;
				let acquired = false;
				let realWriteAttempted = false;
				let creativeId: string | undefined;
				let journalStage = "ABSENT";
				try {
					assertWritesEnabled(env);
					const { accountId, accountNumericId } = getMetaConfig(env);
					const input = { ad_id, expected_name, message, headline, description, image_hash, link_url };
					const fingerprint = await brevarCreativeFingerprint({ accountId, ...input });
					const requiredConfirmation = `REPLACE BREVAR CREATIVE ${ad_id} REQUEST ${request_id} SHA256 ${fingerprint}`;
					if (!validate_only) assertConfirmation(confirmation_phrase || "", requiredConfirmation);
					holder = `operation:${crypto.randomUUID()}`;
					await acquireAccountWriteLease(env, holder, `REPLACE BREVAR CREATIVE ${ad_id} REQUEST ${request_id}`);
					acquired = true;
					const journalResult = await callWriteLock(env, { action: "creative_journal_get", holder, request_id, ad_id });
					if (journalResult.blocked_by_request_id) throw new Error(`CREATIVE_RECONCILIATION_REQUIRED: ad ${ad_id} has unresolved request ${String(journalResult.blocked_by_request_id)}; a different request_id cannot bypass it.`);
					if (!Object.prototype.hasOwnProperty.call(journalResult, "record")) throw new Error("Creative journal read was not confirmed; no mutation dispatched.");
					if (journalResult.record !== null) {
						const prior = z.object({ fingerprint: z.string(), stage: z.string(), before: z.object({ ad: objectSchema, adset: objectSchema, campaign: objectSchema, creative: z.record(z.string(), z.unknown()) }), proposed: z.record(z.string(), z.unknown()), creative_id: z.string().regex(META_ID_PATTERN).optional() }).passthrough().parse(journalResult.record);
						if (prior.fingerprint !== fingerprint) throw new Error("request_id is already bound to different creative inputs; no mutation dispatched.");
						if (prior.stage !== "COMPLETE" || !prior.creative_id) throw new Error(`CREATIVE_RECONCILIATION_REQUIRED: request ${request_id} remains ${prior.stage}${prior.creative_id ? ` (creative ${prior.creative_id})` : ""}. Read and reconcile before any new request; automatic recreation or reattachment is prohibited.`);
						const after = await readBrevarCreativeSnapshot(env, ad_id);
						const differences = brevarHierarchyDifferences(prior.before, after, prior.creative_id);
						if (differences.length) throw new Error(`Completed creative operation no longer matches current settings: ${differences.join(", ")}. No replay mutation attempted.`);
						assertBrevarCreativeReadback(prior.proposed, after.creative, prior.creative_id, accountNumericId);
						const warning = await releaseAccountOperationLease(env, holder);
						return asToolResult({ mode: "idempotent_replay", request_id, ad_id, creative_id: prior.creative_id, after, verified: true, no_write_performed: true, write_lease_release_warning: warning });
					}
					const before = await readBrevarCreativeSnapshot(env, ad_id);
					assertExpectedName(before.ad, expected_name);
					const proposed = buildBrevarCreativeProposal(before, input);
					const images = graphListSchema.parse(await callMetaGraph(env, "GET", `${accountId}/adimages`, { hashes: [image_hash], fields: "hash", limit: 2 }));
					if (images.data.length !== 1 || images.data[0].hash !== image_hash) throw new Error("Replacement image hash was not uniquely confirmed in the configured ad account.");
					// This existing creation endpoint supports inline creatives and is
					// used only with validate_only. No ad or creative is created here.
					const validation = writeResponseSchema.parse(await callMetaGraph(env, "POST", `${accountId}/ads`, {
						adset_id: String(before.ad.adset_id), name: String(before.ad.name), status: "PAUSED", creative: proposed,
						execution_options: ["validate_only"],
					}, { write_lease_holder: holder }));
					if (validation.success !== true) throw new Error("Meta did not confirm the inline creative preview; no real write attempted.");
					const rechecked = await readBrevarCreativeSnapshot(env, ad_id);
					assertBrevarCreativeSnapshotUnchanged(before, rechecked);
					if (validate_only) {
						const warning = await releaseAccountOperationLease(env, holder);
						return asToolResult({ mode: "validate_only", before, proposed, validation, request_id, required_confirmation: requiredConfirmation, verified_unchanged: true, write_lease_release_warning: warning });
					}
					let journal: Record<string, unknown> = { fingerprint, stage: "CREATE_PENDING", before, proposed, ad_id, request_id };
					const saveJournal = async (expected_stage: "ABSENT" | "CREATE_PENDING" | "CREATIVE_CREATED" | "ATTACH_PENDING") => {
						const saved = await callWriteLock(env, { action: "creative_journal_put", holder: holder!, request_id, ad_id, expected_stage, record: journal });
						if (saved.saved !== true) throw new Error("Creative journal transition was not confirmed; no next mutation dispatched.");
						journalStage = String(journal.stage);
					};
					await saveJournal("ABSENT"); // durable create intent precedes dispatch
					realWriteAttempted = true;
					const created = z.object({ id: z.string().regex(META_ID_PATTERN) }).passthrough().parse(await callMetaGraph(env, "POST", `${accountId}/adcreatives`, proposed, { write_lease_holder: holder }));
					creativeId = created.id;
					journal = { ...journal, stage: "CREATIVE_CREATED", creative_id: creativeId };
					await saveJournal("CREATE_PENDING");
					const newCreative = z.record(z.string(), z.unknown()).parse(await callMetaGraph(env, "GET", creativeId, { fields: BREVAR_CREATIVE_FIELDS }));
					assertBrevarCreativeReadback(proposed, newCreative, creativeId, accountNumericId);
					assertBrevarCreativeSnapshotUnchanged(before, await readBrevarCreativeSnapshot(env, ad_id));
					const attachParams = { creative: { creative_id: creativeId } };
					const attachValidation = writeResponseSchema.parse(await callMetaGraph(env, "POST", ad_id, { ...attachParams, execution_options: ["validate_only"] }, { write_lease_holder: holder }));
					if (attachValidation.success !== true) throw new Error("Meta did not confirm validation of creative attachment; existing ad was not changed.");
					// Attachment validation and attachment mutate the same ad endpoint.
					// Respect the same per-object limit, then recheck lease and hierarchy.
					await delay(BREVAR_SAME_OBJECT_POST_GAP_MS);
					await assertAccountOperationLease(env, holder);
					assertBrevarCreativeSnapshotUnchanged(before, await readBrevarCreativeSnapshot(env, ad_id));
					journal = { ...journal, stage: "ATTACH_PENDING" };
					await saveJournal("CREATIVE_CREATED"); // durable attach intent precedes dispatch
					const result = writeResponseSchema.parse(await callMetaGraph(env, "POST", ad_id, attachParams, { write_lease_holder: holder }));
					if (result.success !== true || (result.id !== undefined && result.id !== ad_id)) throw new Error("Meta did not confirm attachment to the existing ad ID.");
					const after = await readBrevarCreativeSnapshot(env, ad_id);
					const differences = brevarHierarchyDifferences(before, after, creativeId);
					if (differences.length) throw new Error(`Creative replacement failed to preserve configuration: ${differences.join(", ")}.`);
					assertBrevarCreativeReadback(proposed, after.creative, creativeId, accountNumericId);
					journal = { ...journal, stage: "COMPLETE", verified_at: new Date().toISOString() };
					await saveJournal("ATTACH_PENDING");
					auditMutation("update_brevar_ad_creative", { ad_id, request_id, creative_id: creativeId, verified: true, status: "PAUSED" });
					const warning = await releaseAccountOperationLease(env, holder);
					return asToolResult({ mode: "updated", request_id, ad_id, creative_id: creativeId, before, proposed, after, verified: true, result, write_lease_release_warning: warning });
				} catch (error) {
					if (realWriteAttempted) {
						auditMutation("update_brevar_ad_creative_unverified", { ad_id, request_id, creative_id: creativeId, journal_stage: journalStage });
						return asToolError(new Error(`CREATIVE_RECONCILIATION_REQUIRED: request ${request_id}, stage ${journalStage}${creativeId ? `, creative ${creativeId}` : ""}. ${error instanceof MetaWriteNotDispatchedError && journalStage === "CREATE_PENDING" ? "The API gate confirmed no creative-create POST was dispatched, but durable create intent still requires reconciliation." : "A real creative write was attempted and may have succeeded."} Its operation journal was retained and its lease was not released. Do not create a replacement request or repeat attachment before reconciling. ${error instanceof Error ? error.message : "Unexpected creative failure."}`));
					}
					if (acquired && holder) {
						const warning = await releaseAccountOperationLease(env, holder);
						if (warning) return asToolError(new Error(`${error instanceof Error ? error.message : "Creative preflight failed."} ${warning}`));
					}
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
					await acquireAccountWriteLease(
						env,
						this.ctx.id.toString(),
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
					await acquireAccountWriteLease(
						env,
						this.ctx.id.toString(),
						`CREATE LEAD FORM ${page_id} ${name}`,
					);
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
					await acquireAccountWriteLease(
						env,
						this.ctx.id.toString(),
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
					await acquireAccountWriteLease(
						env,
						this.ctx.id.toString(),
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
