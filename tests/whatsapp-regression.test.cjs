"use strict";

// Offline integration tests: execute the real TypeScript tool handlers while
// replacing every network request and KV operation with in-memory fixtures.
// No production credentials, Cloudflare calls, or Meta writes are possible.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { webcrypto } = require("node:crypto");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { z } = require("zod");

const sourcePath = path.resolve(__dirname, "../src/index.ts");
// Reproduce the exact v2.2.1 pre-fix behavior without changing the worktree:
// STOICUS_TEST_PREVIOUS_SOURCE=1 node --test --test-name-pattern='selected WhatsApp phone' tests/whatsapp-regression.test.cjs
const sourceText = process.env.STOICUS_TEST_PREVIOUS_SOURCE === "1"
  ? execFileSync("git", ["show", "2d00b3316676f06166905b05261a23c65dd35504:src/index.ts"], {
    cwd: path.resolve(__dirname, ".."), encoding: "utf8",
  })
  : fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(sourceText, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;

const ACCOUNT = "900001";
const CAMPAIGN = "900002";
const ADSET = "900003";
const PAGE = "900004";
const BUSINESS = "900006";
const PHONE = "5511990000000";
const CAMPAIGN_NAME = "BREVAR isolated test campaign";
const ADSET_NAME = "BREVAR isolated test ad set";
const REQUEST_ID = "12345678-1234-4234-9234-123456789012";

const campaignFixture = {
  id: CAMPAIGN,
  account_id: ACCOUNT,
  name: CAMPAIGN_NAME,
  status: "PAUSED",
  effective_status: "PAUSED",
  objective: "OUTCOME_ENGAGEMENT",
};

const adsetFixture = {
  id: ADSET,
  account_id: ACCOUNT,
  name: ADSET_NAME,
  status: "PAUSED",
  effective_status: "PAUSED",
  campaign_id: CAMPAIGN,
  destination_type: "WHATSAPP",
  promoted_object: { page_id: PAGE, whatsapp_phone_number: PHONE },
};

function decodeParams(params) {
  return Object.fromEntries(Array.from(params.entries(), ([key, value]) => {
    if (value.startsWith("{") || value.startsWith("[")) {
      try { return [key, JSON.parse(value)]; } catch { /* keep string */ }
    }
    return [key, value];
  }));
}

async function harness(options = {}) {
  const registered = new Map();
  const calls = options.sharedRuntime?.calls ?? [];
  const fetchSignals = options.sharedRuntime?.fetchSignals ?? [];
  const kvWrites = [];
  const kvReads = [];
  const lockCalls = options.sharedRuntime?.lockCalls ?? [];
  const auditEvents = [];
  class MockServer {
    constructor(metadata) { this.metadata = metadata; }
    registerTool(name, schema, callback) {
      registered.set(name, { schema, callback });
    }
  }
  class MockAgent {
    static serve() { return {}; }
  }
  class MockOAuthProvider {
    constructor() {}
    fetch() { throw new Error("OAuth endpoint must not run during tests."); }
  }

  async function mockFetch(urlValue, init) {
    const url = new URL(urlValue);
    assert.equal(url.origin, "https://graph.facebook.com");
    const graphPath = url.pathname.replace(/^\/v\d+\.\d+\//, "");
    const params = decodeParams(init.method === "POST"
      ? new URLSearchParams(String(init.body)) : url.searchParams);
    // Do not retain headers or the fake Authorization value in test logs.
    const call = { method: init.method, path: graphPath, params };
    calls.push(call);
    fetchSignals.push(init.signal);
    const override = options.respond && await options.respond(call);
    if (override !== undefined) {
      const hasRawBody = Object.hasOwn(override, "rawBody");
      return new Response(hasRawBody ? override.rawBody : JSON.stringify(override.body ?? override), {
        status: override.httpStatus ?? 200,
        headers: {
          "Content-Type": hasRawBody ? "text/plain" : "application/json",
          ...override.headers,
        },
      });
    }
    let body;
    if (init.method === "POST") {
      body = { success: true };
    } else if (graphPath === CAMPAIGN) {
      body = options.campaign ?? campaignFixture;
    } else if (graphPath === ADSET) {
      body = options.adset ?? adsetFixture;
    } else if (graphPath === "me/permissions") {
      body = { data: [
        { permission: "ads_read", status: "granted" },
        { permission: "ads_management", status: "granted" },
      ] };
    } else if (graphPath === "me") {
      body = { id: "900005", name: "Offline test subject" };
    } else if (graphPath === "me/accounts") {
      body = { data: [{ id: PAGE, name: "Offline Stoicus page", tasks: ["ADVERTISE", "MANAGE_LEADS"] }] };
    } else if (graphPath === `act_${ACCOUNT}`) {
      body = { id: `act_${ACCOUNT}`, account_id: ACCOUNT, name: "Offline account", account_status: 1 };
    } else if (graphPath === PAGE) {
      body = { id: PAGE, whatsapp_number: PHONE, has_whatsapp_number: true, has_whatsapp_business_number: true };
    } else {
      throw new Error(`Missing offline fixture: ${init.method} ${graphPath}`);
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const exportsObject = {};
  const moduleObject = { exports: exportsObject };
  const context = {
    module: moduleObject,
    exports: exportsObject,
    require(name) {
      if (name === "@cloudflare/workers-oauth-provider") return { __esModule: true, default: MockOAuthProvider };
      if (name === "@modelcontextprotocol/sdk/server/mcp.js") return { McpServer: MockServer };
      if (name === "agents/mcp") return { McpAgent: MockAgent };
      if (name === "zod") return { z };
      if (name === "./access-handler") return { handleAccessRequest() { throw new Error("Authentication must not run."); } };
      if (name === "./creative-assets") return { getCreativeAssetResponse(request) { return options.creativeAssetResponse?.(request) ?? null; } };
      throw new Error(`Unexpected module in offline test: ${name}`);
    },
    fetch: mockFetch,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    AbortSignal,
    TextEncoder,
    btoa,
    Error,
    crypto: webcrypto,
    Date: options.clock?.Date ?? Date,
    setTimeout: options.clock?.setTimeout ?? setTimeout,
    console: { log(value) { auditEvents.push(value); } },
  };
  vm.runInNewContext(compiled, context, { filename: sourcePath });
  const agent = new moduleObject.exports.MyMCP();
  agent.ctx = {
    id: { toString() { return options.sessionId ?? "offline-session-1"; } },
  };
  agent.env = {
    META_ACCESS_TOKEN: "OFFLINE_TEST_ONLY_NOT_A_CREDENTIAL",
    META_AD_ACCOUNT_ID: ACCOUNT,
    META_API_VERSION: "v26.0",
    META_WRITE_ENABLED: "true",
    OAUTH_KV: {
      async get(...args) { kvReads.push(args); return null; },
      async put(...args) { kvWrites.push(args); },
    },
    META_WRITE_LOCK: {
      idFromName(name) { return `lock:${name}`; },
      get(id) {
        return {
          async fetch(url, init) {
            const call = { id, url: String(url), payload: JSON.parse(String(init.body)) };
            lockCalls.push(call);
            const override = options.writeLockRespond && await options.writeLockRespond(call);
            const response = override ?? (call.payload.action === "status"
              ? { body: { active: false } }
              : { body: { active: ["acquire", "assert_owner"].includes(call.payload.action), acquired: call.payload.action === "acquire", holder_matches: call.payload.action === "assert_owner", released: ["release", "release_owned"].includes(call.payload.action), expires_at: "2099-01-01T00:00:00.000Z" } });
            return new Response(JSON.stringify(response.body ?? response), {
              status: response.httpStatus ?? 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        };
      },
    },
    ...options.env,
  };
  if (options.sharedRuntime) {
    const runtime = options.sharedRuntime;
    runtime.lock ??= new moduleObject.exports.MetaWriteLock(runtime.state);
    agent.env.META_WRITE_LOCK = {
      idFromName(name) { return `lock:${name}`; },
      get(id) {
        assert.equal(id, `lock:act_${ACCOUNT}`);
        return {
          async fetch(url, init) {
            const call = { id, url: String(url), payload: JSON.parse(String(init.body)) };
            lockCalls.push(call);
            const override = options.writeLockRespond && await options.writeLockRespond(call);
            if (override !== undefined) {
              return Response.json(override.body ?? override, { status: override.httpStatus ?? 200 });
            }
            return runtime.lock.fetch(new Request(url, init));
          },
        };
      },
    };
  }
  if (options.useGate) {
    const gate = options.sharedRuntime
      ? (options.sharedRuntime.gate ??= new moduleObject.exports.MetaApiGate({}, agent.env))
      : new moduleObject.exports.MetaApiGate({}, agent.env);
    agent.env.META_API_GATE = {
      idFromName(name) { return name; },
      get(id) {
        assert.equal(id, ACCOUNT);
        return {
          fetch(url, init) { return gate.fetch(new Request(url, init)); },
        };
      },
    };
  } else if (!options.omitGate) {
    // Most handler tests need the production binding to exist but do not need
    // real pacing delays. This in-memory stub preserves the gate envelope while
    // forwarding exactly one request to the existing Graph fixture.
    agent.env.META_API_GATE = {
      idFromName(name) { return name; },
      get(id) {
        assert.equal(id, ACCOUNT);
        return {
          async fetch(_url, init) {
            const call = JSON.parse(String(init.body));
            const graphUrl = new URL(`/v26.0/${call.path}`, "https://graph.facebook.com");
            const graphInit = { method: call.method, headers: new Headers() };
            if (call.method === "GET") {
              for (const [key, value] of Object.entries(call.params)) {
                graphUrl.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
              }
            } else {
              const body = new URLSearchParams();
              for (const [key, value] of Object.entries(call.params)) {
                body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
              }
              graphInit.body = body;
            }
            const response = await mockFetch(graphUrl, graphInit);
            const rawBody = await response.text();
            let payload;
            try {
              payload = JSON.parse(rawBody);
            } catch {
              return Response.json({
                ok: false,
                error: `Meta API returned a non-JSON HTTP ${response.status} response.`,
              }, { status: response.ok ? 502 : response.status });
            }
            if (!response.ok || payload.error) {
              const metaError = payload.error || {};
              return Response.json({
                ok: false,
                error: [
                  metaError.message,
                  metaError.type && `type=${metaError.type}`,
                  metaError.code !== undefined && `code=${metaError.code}`,
                  metaError.error_subcode !== undefined && `subcode=${metaError.error_subcode}`,
                ]
                  .filter(Boolean).join(" | ") || `Meta API returned HTTP ${response.status}.`,
              }, { status: response.status });
            }
            return Response.json({ ok: true, payload });
          },
        };
      },
    };
  }
  await agent.init();
  return {
    calls, fetchSignals, kvWrites, kvReads, lockCalls, auditEvents, metadata: agent.server.metadata,
    MetaApiGate: moduleObject.exports.MetaApiGate,
    MetaWriteLock: moduleObject.exports.MetaWriteLock,
    async invoke(name, input = {}) {
      const tool = registered.get(name);
      assert.ok(tool, `Tool must be registered: ${name}`);
      // Match MCP input validation and defaults before invoking its real handler.
      const parsed = z.object(tool.schema.inputSchema).parse(input);
      return tool.callback(parsed);
    },
  };
}

function adsetInput(overrides = {}) {
  return {
    billing_event: "IMPRESSIONS",
    campaign_id: CAMPAIGN,
    expected_campaign_name: CAMPAIGN_NAME,
    name: ADSET_NAME,
    optimization_goal: "LINK_CLICKS", // existing, legacy-compatible tool input
    // Legacy callers did not have destination_type in their tool catalog.
    promoted_object: { page_id: PAGE, whatsapp_phone_number: PHONE },
    targeting: { age_min: 26, age_max: 55, geo_locations: { countries: ["BR"] } },
    request_id: REQUEST_ID,
    validate_only: true,
    ...overrides,
  };
}

function adInput(overrides = {}) {
  return {
    adset_id: ADSET,
    expected_adset_name: ADSET_NAME,
    name: "Offline ad",
    page_id: PAGE,
    headline: "BREVAR para médicos",
    message: "Treinamento de via aérea para médicos e médicas.",
    image_hash: "offline-image-hash",
    link_url: `https://wa.me/${PHONE}?text=Tenho%20interesse`,
    call_to_action_type: "CONTACT_US",
    request_id: REQUEST_ID,
    validate_only: true,
    ...overrides,
  };
}

function toolPayload(result) {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

function postCalls(h) { return h.calls.filter(call => call.method === "POST"); }

function ageFixture(overrides = {}) {
  return {
    ...adsetFixture, status: "ACTIVE", effective_status: "ACTIVE",
    lifetime_budget: "40000", optimization_goal: "POST_ENGAGEMENT",
    billing_event: "IMPRESSIONS", destination_type: "ON_POST",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP", bid_amount: "0",
    start_time: "2026-09-07T08:00:00-0200", end_time: "2026-09-13T23:00:00-0200",
    adset_schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], start_minute: 480, end_minute: 1380, timezone_type: "ADVERTISER" }],
    pacing_type: ["day_parting"], targeting_optimization_types: [{ detailed_targeting: 0 }],
    targeting: {
      age_min: 26, age_max: 54,
      flexible_spec: [{ work_positions: [{ id: "123", name: "Physician" }, { id: "456", name: "Surgeon" }] }],
      geo_locations: { cities: [{ key: "100", radius: 10, distance_unit: "kilometer" }], location_types: ["home", "recent"] },
      excluded_geo_locations: { regions: [{ key: "200" }] },
      targeting_automation: { advantage_audience: 0 },
      publisher_platforms: ["facebook", "instagram"],
    },
    ...overrides,
  };
}

function ageInput(overrides = {}) {
  return { adset_id: ADSET, expected_name: ADSET_NAME, age_min: 25, age_max: 50, ...overrides };
}

test("age update defaults to a Meta validation with unchanged read-back, complete targeting, and no real write", async () => {
  const initial = ageFixture();
  const h = await harness({ adset: initial });
  const result = toolPayload(await h.invoke("meta_update_adset_age", ageInput()));
  assert.equal(result.mode, "validate_only");
  assert.equal(result.verified_unchanged, true);
  assert.equal(result.required_confirmation, `UPDATE ADSET AGE ${ADSET} 25 50`);
  assert.deepEqual(h.calls.map(c => c.method), ["GET", "POST", "GET"]);
  const post = postCalls(h)[0];
  assert.equal(post.path, ADSET);
  assert.deepEqual(Object.keys(post.params).sort(), ["execution_options", "targeting"]);
  assert.deepEqual(post.params.execution_options, ["validate_only"]);
  assert.deepEqual(post.params.targeting, { ...initial.targeting, age_min: 25, age_max: 50 });
  assert.deepEqual(result.before, initial);
  assert.deepEqual(result.proposed, { ...initial, targeting: post.params.targeting });
  assert.equal(h.kvWrites.length, 0);
  assert.equal(h.lockCalls.length, 0);
  assert.equal(h.auditEvents.length, 0);
});

for (const rename of [false, true]) test(`age update verifies an existing active ad set and preserves delivery configuration (rename=${rename})`, async () => {
  let state = ageFixture();
  const initial = structuredClone(state);
  const requestedName = `${ADSET_NAME} | 25-50`;
  const h = await harness({ respond(call) {
    if (call.method === "GET" && call.path === ADSET) return state;
    if (call.method === "POST" && call.path === ADSET && !call.params.execution_options) {
      assert.deepEqual(Object.keys(call.params).sort(), rename ? ["name", "targeting"] : ["targeting"]);
      state = { ...state, targeting: call.params.targeting, ...(rename ? { name: call.params.name } : {}) };
      return { success: true };
    }
  } });
  const result = toolPayload(await h.invoke("meta_update_adset_age", ageInput({
    validate_only: false,
    confirmation_phrase: `UPDATE ADSET AGE ${ADSET} 25 50${rename ? ` NAME ${requestedName}` : ""}`,
    ...(rename ? { name: requestedName } : {}),
  })));
  assert.equal(result.verified, true);
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.after, { ...initial, targeting: { ...initial.targeting, age_min: 25, age_max: 50 }, ...(rename ? { name: requestedName } : {}) });
  assert.deepEqual(h.calls.map(c => c.method), ["GET", "POST", "GET", "POST", "GET"]);
  assert.equal(h.auditEvents.length, 1);
  assert.equal(JSON.parse(h.auditEvents[0]).operation, "update_adset_age");
  assert.equal(h.lockCalls.length, 1);
  assert.deepEqual(h.lockCalls[0].payload, {
    action: "acquire",
    holder: "offline-session-1",
    operation: `UPDATE ADSET AGE ${ADSET} 25 50${rename ? ` NAME ${requestedName}` : ""}`,
    ttl_ms: 600000,
  });
  assert.equal(h.kvWrites.length, 0);
});

test("a competing MCP session is blocked before the real age mutation", async () => {
  const h = await harness({ adset: ageFixture(), writeLockRespond(call) {
    if (call.payload.action === "acquire") {
      return {
        httpStatus: 409,
        body: {
          code: "WRITE_LOCKED",
          expires_at: "2099-01-01T00:00:00.000Z",
          operation: "CREATE CAMPAIGN from another chat",
        },
      };
    }
  } });
  const result = await h.invoke("meta_update_adset_age", ageInput({
    validate_only: false,
    confirmation_phrase: `UPDATE ADSET AGE ${ADSET} 25 50`,
  }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /WRITE_LOCKED/);
  assert.equal(h.lockCalls.length, 1);
  assert.deepEqual(postCalls(h).map(call => call.params.execution_options), [["validate_only"]]);
  assert.equal(h.auditEvents.length, 0);
});

for (const [label, response] of [
  ["empty success body", {}],
  ["inactive lease", { active: false, acquired: false, expires_at: "2099-01-01T00:00:00.000Z" }],
  ["expired active lease", { active: true, acquired: true, expires_at: "2000-01-01T00:00:00.000Z" }],
]) test(`delivery mutation rejects a write-lock ${label} before the Meta POST`, async () => {
  const h = await harness({
    writeLockRespond(call) {
      if (call.payload.action === "acquire") return { body: response };
    },
  });
  const result = await h.invoke("meta_set_delivery_status", {
    confirmation_phrase: `SET CAMPAIGN ${CAMPAIGN} ACTIVE`,
    expected_name: CAMPAIGN_NAME,
    object_id: CAMPAIGN,
    object_type: "CAMPAIGN",
    status: "ACTIVE",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /did not confirm an active account lease/i);
  assert.equal(h.lockCalls.length, 1);
  assert.equal(postCalls(h).length, 0);
  assert.equal(h.auditEvents.length, 0);
});

test("temporary account-assignment recovery is no longer callable", async () => {
  const h = await harness();
  await assert.rejects(
    h.invoke("meta_recovery_assign_self_to_configured_account"),
    /Tool must be registered/,
  );
  assert.equal(h.calls.length, 0);
  assert.equal(h.lockCalls.length, 0);
});

test("write-lease tools report status and only release the current session lease", async () => {
  const h = await harness();
  const status = toolPayload(await h.invoke("meta_get_write_lease"));
  assert.equal(status.account_id, `act_${ACCOUNT}`);
  assert.equal(status.active, false);
  const released = toolPayload(await h.invoke("meta_release_write_lease", {
    confirmation_phrase: `RELEASE WRITE LEASE act_${ACCOUNT}`,
  }));
  assert.equal(released.released, true);
  assert.deepEqual(h.lockCalls.map(call => call.payload.action), ["status", "release"]);
  assert.equal(h.calls.length, 0);
});

test("account write lease is exclusive, renewable by its holder, and explicitly releasable", async () => {
  const h = await harness();
  const values = new Map();
  const state = {
    async blockConcurrencyWhile(callback) { return callback(); },
    storage: {
      async get(key) { return values.get(key); },
      async put(key, value) { values.set(key, value); },
      async delete(key) { return values.delete(key); },
    },
  };
  const lock = new h.MetaWriteLock(state);
  const invoke = (payload) => lock.fetch(new Request("https://lock.example/lease", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }));
  const first = await invoke({ action: "acquire", holder: "chat-a", operation: "write A", ttl_ms: 600000 });
  assert.equal(first.status, 200);
  const competing = await invoke({ action: "acquire", holder: "chat-b", operation: "write B", ttl_ms: 600000 });
  assert.equal(competing.status, 409);
  assert.equal((await competing.json()).code, "WRITE_LOCKED");
  const renewed = await invoke({ action: "acquire", holder: "chat-a", operation: "write A2", ttl_ms: 600000 });
  assert.equal(renewed.status, 200);
  assert.equal((await renewed.json()).acquired, false);
  const wrongRelease = await invoke({ action: "release", holder: "chat-b" });
  assert.equal(wrongRelease.status, 409);
  const released = await invoke({ action: "release", holder: "chat-a" });
  assert.equal(released.status, 200);
  assert.equal((await released.json()).released, true);
});

for (const [label, initial, input] of [
  ["wrong account", ageFixture({ account_id: "999999" }), ageInput()],
  ["wrong object ID", ageFixture({ id: "999999" }), ageInput()],
  ["stale name", ageFixture({ name: "Different name" }), ageInput()],
  ["archived object", ageFixture({ status: "ARCHIVED" }), ageInput()],
  ["missing targeting", ageFixture({ targeting: undefined }), ageInput()],
  ["missing age maximum", ageFixture({ targeting: { age_min: 26 } }), ageInput()],
  ["missing confirmation", ageFixture(), ageInput({ validate_only: false })],
  ["wrong confirmation", ageFixture(), ageInput({ validate_only: false, confirmation_phrase: `UPDATE ADSET AGE ${ADSET} 24 55` })],
  ["rename absent from confirmation", ageFixture(), ageInput({ validate_only: false, name: "New name", confirmation_phrase: `UPDATE ADSET AGE ${ADSET} 25 50` })],
  ["reversed ages", ageFixture(), ageInput({ age_min: 51, age_max: 50 })],
]) test(`age update rejects ${label} without any POST`, async () => {
  const h = await harness({ adset: initial });
  const result = await h.invoke("meta_update_adset_age", input);
  assert.equal(result.isError, true);
  assert.equal(postCalls(h).length, 0);
});

test("age update honors META_WRITE_ENABLED before reads or preview requests", async () => {
  const h = await harness({ env: { META_WRITE_ENABLED: "false" }, adset: ageFixture() });
  const result = await h.invoke("meta_update_adset_age", ageInput());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /META_WRITE_ENABLED/);
  assert.equal(h.calls.length, 0);
});

for (const input of [ageInput({ age_min: 17 }), ageInput({ age_max: 66 }), ageInput({ age_min: 25.5 }), ageInput({ adset_id: "../campaigns" })]) {
  test(`age update schema rejects invalid input ${JSON.stringify(input)}`, async () => {
    const h = await harness();
    await assert.rejects(h.invoke("meta_update_adset_age", input));
    assert.equal(h.calls.length, 0);
  });
}

test("age update rejects a concurrent targeting change after validation without real write", async () => {
  let reads = 0;
  const h = await harness({ respond(call) {
    if (call.method === "GET" && call.path === ADSET) {
      const state = ageFixture();
      if (++reads > 1) state.targeting.flexible_spec = [{ work_positions: [{ id: "789" }] }];
      return state;
    }
  } });
  const result = await h.invoke("meta_update_adset_age", ageInput({ validate_only: false, confirmation_phrase: `UPDATE ADSET AGE ${ADSET} 25 50` }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /changed during validation \(targeting\)/);
  assert.equal(postCalls(h).length, 1);
  assert.deepEqual(postCalls(h)[0].params.execution_options, ["validate_only"]);
});

for (const invalidValidation of [
  { success: false },
  { error: { message: "Unsupported targeting", code: 100 } },
]) test(`age update stops at a failed Meta validation: ${JSON.stringify(invalidValidation)}`, async () => {
  const h = await harness({ adset: ageFixture(), respond(call) {
    if (call.method === "POST") return invalidValidation;
  } });
  const result = await h.invoke("meta_update_adset_age", ageInput({ validate_only: false, confirmation_phrase: `UPDATE ADSET AGE ${ADSET} 25 50` }));
  assert.equal(result.isError, true);
  assert.equal(postCalls(h).length, 1);
  assert.deepEqual(postCalls(h)[0].params.execution_options, ["validate_only"]);
});

for (const drift of ["targeting", "targeting_optimization_types", "lifetime_budget", "status", "adset_schedule"]) {
  test(`age update reports post-write ${drift} drift without a retry or rollback`, async () => {
    let state = ageFixture();
    const h = await harness({ respond(call) {
      if (call.method === "GET" && call.path === ADSET) return state;
      if (call.method === "POST" && !call.params.execution_options) {
        state = { ...state, targeting: call.params.targeting };
        if (drift === "targeting") state.targeting.flexible_spec = [];
        if (drift === "targeting_optimization_types") state.targeting_optimization_types = [{ detailed_targeting: 1 }];
        if (drift === "lifetime_budget") state.lifetime_budget = "50000";
        if (drift === "status") state.status = "PAUSED";
        if (drift === "adset_schedule") state.adset_schedule = [];
        return { success: true };
      }
    } });
    const result = await h.invoke("meta_update_adset_age", ageInput({ validate_only: false, confirmation_phrase: `UPDATE ADSET AGE ${ADSET} 25 50` }));
    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.verified, false);
    assert.deepEqual(payload.mismatches, [drift]);
    assert.equal(postCalls(h).length, 2);
    assert.equal(JSON.parse(h.auditEvents[0]).verified, false);
  });
}

test("age update exposes an unverified outcome when post-write read-back fails, and never retries", async () => {
  let realWrite = false;
  const h = await harness({ adset: ageFixture(), respond(call) {
    if (call.method === "POST" && !call.params.execution_options) realWrite = true;
    if (call.method === "GET" && realWrite) return { error: { message: "Read failed", code: 2 } };
  } });
  const result = await h.invoke("meta_update_adset_age", ageInput({ validate_only: false, confirmation_phrase: `UPDATE ADSET AGE ${ADSET} 25 50` }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Real update was attempted; its final state is unverified/);
  assert.equal(postCalls(h).length, 2);
  assert.equal(JSON.parse(h.auditEvents[0]).operation, "update_adset_age_unverified");
});

test("age update safely treats an already matching range and name as a no-op", async () => {
  const h = await harness({ adset: ageFixture() });
  const result = toolPayload(await h.invoke("meta_update_adset_age", ageInput({ age_min: 26, age_max: 54 })));
  assert.equal(result.mode, "no_change");
  assert.equal(result.verified, true);
  assert.equal(postCalls(h).length, 0);
});

test("selected WhatsApp phone survives the actual validate-only Graph payload", async () => {
  const h = await harness();
  const input = adsetInput();
  const result = toolPayload(await h.invoke("meta_create_adset_draft", input));
  const posts = postCalls(h);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, `act_${ACCOUNT}/adsets`);
  assert.deepEqual(posts[0].params.promoted_object, { page_id: PAGE, whatsapp_phone_number: PHONE });
  assert.equal(posts[0].params.destination_type, "WHATSAPP");
  assert.equal(posts[0].params.optimization_goal, "CONVERSATIONS");
  assert.equal(posts[0].params.status, "PAUSED");
  assert.deepEqual(posts[0].params.targeting, input.targeting);
  assert.deepEqual(posts[0].params.execution_options, ["validate_only", "include_recommendations"]);
  assert.equal(result.mode, "validate_only");
  assert.equal(result.resolved_destination_type, posts[0].params.destination_type);
  assert.equal(result.resolved_optimization_goal, posts[0].params.optimization_goal);
  assert.equal(result.status_for_create, "PAUSED");
  assert.equal(input.promoted_object.whatsapp_phone_number, PHONE);
  assert.equal(h.kvWrites.length, 0);
  assert.equal(h.kvReads.length, 0);
  assert.equal(h.auditEvents.length, 0);
});

test("malformed WhatsApp phone is rejected before any Graph POST", async () => {
  const h = await harness();
  const result = await h.invoke("meta_create_adset_draft", adsetInput({
    promoted_object: { page_id: PAGE, whatsapp_phone_number: "invalid-phone" },
  }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /10 to 15 digits/);
  assert.equal(postCalls(h).length, 0);
  assert.equal(h.kvWrites.length, 0);
});

for (const [label, overrides, errorPattern] of [
  ["conflicting website destination", { destination_type: "WEBSITE" }, /conflicts/],
  ["missing selected phone", {
    destination_type: "WHATSAPP", promoted_object: { page_id: PAGE },
  }, /requires promoted_object.whatsapp_phone_number/],
  ...["IMPRESSIONS", "LANDING_PAGE_VIEWS", "LEAD_GENERATION", "OFFSITE_CONVERSIONS", "POST_ENGAGEMENT", "REACH"]
    .map(goal => [`unsupported ${goal} goal`, {
      destination_type: "WHATSAPP", optimization_goal: goal,
    }, /requires optimization_goal CONVERSATIONS or LINK_CLICKS/]),
]) test(`explicit WhatsApp rejects ${label} before any Graph request`, async () => {
  const h = await harness();
  const result = await h.invoke("meta_create_adset_draft", adsetInput(overrides));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, errorPattern);
  assert.equal(h.calls.length, 0);
  assert.equal(h.kvWrites.length, 0);
  assert.equal(h.auditEvents.length, 0);
});

test("legacy IMPRESSIONS input without destination still resolves to WhatsApp conversations", async () => {
  const h = await harness();
  const result = toolPayload(await h.invoke("meta_create_adset_draft", adsetInput({
    optimization_goal: "IMPRESSIONS",
  })));
  const { params } = postCalls(h)[0];
  assert.equal(params.destination_type, "WHATSAPP");
  assert.equal(params.optimization_goal, "CONVERSATIONS");
  assert.equal(result.resolved_destination_type, params.destination_type);
  assert.equal(result.resolved_optimization_goal, params.optimization_goal);
});

test("missing campaign input is rejected by the actual MCP schema", async () => {
  const h = await harness();
  const input = adsetInput();
  delete input.campaign_id;
  await assert.rejects(h.invoke("meta_create_adset_draft", input));
  assert.equal(h.calls.length, 0);
});

for (const [label, fixture, errorPattern] of [
  ["missing campaign object", {}, /./],
  ["wrong campaign name", { ...campaignFixture, name: "Another campaign" }, /Name mismatch/],
  ["wrong account ownership", { ...campaignFixture, account_id: "999999" }, /does not belong/],
  ["wrong campaign objective", { ...campaignFixture, objective: "OUTCOME_TRAFFIC" }, /OUTCOME_ENGAGEMENT/],
]) {
  test(`${label} cannot create a WhatsApp ad set`, async () => {
    const h = await harness({ campaign: fixture });
    const result = await h.invoke("meta_create_adset_draft", adsetInput());
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, errorPattern);
    assert.equal(postCalls(h).length, 0);
    assert.equal(h.kvWrites.length, 0);
  });
}

test("website ad-set payload remains website and preserves its promoted object", async () => {
  const h = await harness({ campaign: { ...campaignFixture, objective: "OUTCOME_TRAFFIC" } });
  const result = toolPayload(await h.invoke("meta_create_adset_draft", adsetInput({
    promoted_object: { page_id: PAGE }, destination_type: undefined,
  })));
  const { params } = postCalls(h)[0];
  assert.equal(params.destination_type, "WEBSITE");
  assert.equal(params.optimization_goal, "LINK_CLICKS");
  assert.deepEqual(params.promoted_object, { page_id: PAGE });
  assert.equal(params.status, "PAUSED");
  assert.equal(result.resolved_destination_type, params.destination_type);
  assert.equal(result.resolved_optimization_goal, params.optimization_goal);
  assert.equal(h.kvWrites.length, 0);
});

test("lead-generation path is unchanged and does not acquire WhatsApp routing", async () => {
  const h = await harness({ campaign: { ...campaignFixture, objective: "OUTCOME_LEADS" } });
  const result = toolPayload(await h.invoke("meta_create_adset_draft", adsetInput({
    promoted_object: { page_id: PAGE }, destination_type: undefined,
    optimization_goal: "LEAD_GENERATION",
  })));
  const { params } = postCalls(h)[0];
  assert.equal(params.optimization_goal, "LEAD_GENERATION");
  assert.equal(Object.hasOwn(params, "destination_type"), false);
  assert.deepEqual(params.promoted_object, { page_id: PAGE });
  assert.equal(params.status, "PAUSED");
  assert.equal(result.resolved_destination_type, null);
  assert.equal(result.resolved_optimization_goal, params.optimization_goal);
  assert.equal(h.kvWrites.length, 0);
});

test("native wa.me creative retains WhatsApp CTA and validate-only paused status", async () => {
  const h = await harness();
  const input = adInput();
  toolPayload(await h.invoke("meta_create_ad_draft", input));
  const { params } = postCalls(h)[0];
  const story = params.creative.object_story_spec;
  assert.equal(story.page_id, PAGE);
  assert.deepEqual(story.link_data.call_to_action, {
    type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP", link: input.link_url },
  });
  assert.equal(story.link_data.link, input.link_url);
  assert.equal(story.link_data.image_hash, input.image_hash);
  assert.equal(params.status, "PAUSED");
  assert.deepEqual(params.execution_options, ["validate_only", "include_recommendations"]);
  assert.equal(h.kvWrites.length, 0);
});

test("website creative retains requested CTA, link, and image without WhatsApp fields", async () => {
  const h = await harness({ adset: { ...adsetFixture, destination_type: "WEBSITE" } });
  const input = adInput({ link_url: "https://example.com/course", call_to_action_type: "LEARN_MORE" });
  toolPayload(await h.invoke("meta_create_ad_draft", input));
  const { params } = postCalls(h)[0];
  const story = params.creative.object_story_spec;
  assert.deepEqual(story.link_data.call_to_action, { type: "LEARN_MORE", value: { link: input.link_url } });
  assert.equal(story.link_data.link, input.link_url);
  assert.equal(story.link_data.message, input.message);
  assert.equal(story.link_data.image_hash, input.image_hash);
  assert.equal(params.status, "PAUSED");
  assert.equal(h.kvWrites.length, 0);
});

test("native WhatsApp creative cannot silently use a different Page or destination", async () => {
  for (const adset of [
    { ...adsetFixture, destination_type: "WEBSITE" },
    { ...adsetFixture, promoted_object: { page_id: "999999" } },
  ]) {
    const h = await harness({ adset });
    const result = await h.invoke("meta_create_ad_draft", adInput());
    assert.equal(result.isError, true);
    assert.equal(postCalls(h).length, 0);
  }
});

test("permission readiness uses only three sequential reads and verifies the configured account", async () => {
  const h = await harness();
  const result = toolPayload(await h.invoke("meta_get_token_permissions"));
  assert.equal(result.connector_version, "2.3.11");
  assert.equal(h.metadata.version, "2.3.11");
  assert.equal(result.asset_diagnostics_included, false);
  assert.equal(result.configured_account_accessible, true);
  assert.equal(result.configured_account.id, `act_${ACCOUNT}`);
  assert.equal(result.account_accessible, true);
  assert.equal(result.account.id, `act_${ACCOUNT}`);
  assert.equal(result.scope_ready_for_reads, true);
  assert.equal(result.scope_ready_for_writes, true);
  assert.equal(result.ready_for_reads, true);
  assert.equal(result.ready_for_writes, true);
  assert.equal(result.write_switch_enabled, true);
  assert.equal(result.write_access_verified, false);
  assert.deepEqual(result.accessible_pages, []);
  assert.deepEqual(result.page_whatsapp_diagnostics, []);
  assert.deepEqual(result.whatsapp_assets, {});
  assert.equal(Object.hasOwn(result, "account_inventory"), false);
  assert.deepEqual(h.calls.map(call => call.path), ["me/permissions", "me", `act_${ACCOUNT}`]);
  assert.equal(postCalls(h).length, 0);
  assert.equal(h.kvWrites.length, 0);
});

test("Page WhatsApp diagnostics are opt-in, read-only, and report connector version", async () => {
  const h = await harness();
  const result = toolPayload(await h.invoke("meta_get_token_permissions", {
    include_asset_diagnostics: true,
  }));
  assert.equal(result.connector_version, "2.3.11");
  assert.equal(h.metadata.version, "2.3.11");
  assert.equal(result.asset_diagnostics_included, true);
  assert.equal(result.configured_account_accessible, true);
  assert.equal(result.scope_ready_for_reads, true);
  assert.equal(result.scope_ready_for_writes, true);
  assert.equal(result.ready_for_reads, true);
  assert.equal(result.ready_for_writes, true);
  assert.equal(result.write_switch_enabled, true);
  assert.ok(Array.isArray(result.page_whatsapp_diagnostics));
  const page = result.page_whatsapp_diagnostics.find(item => item.page_id === PAGE);
  assert.ok(page, "diagnostics should explicitly identify the inspected Page");
  assert.equal(page.whatsapp_number, PHONE);
  assert.equal(page.has_whatsapp_number, true);
  assert.equal(page.has_whatsapp_business_number, true);
  assert.deepEqual(h.calls.map(call => call.path), [
    "me/permissions", "me", `act_${ACCOUNT}`, "me/accounts", PAGE, `act_${ACCOUNT}`,
  ]);
  assert.equal(postCalls(h).length, 0);
  assert.equal(h.kvWrites.length, 0);
});

test("Page and WABA diagnostic failures preserve baseline permissions and identity", async () => {
  const businessId = "900006";
  const h = await harness({
    respond(call) {
      if (call.path === `act_${ACCOUNT}`) {
        return {
          id: `act_${ACCOUNT}`, account_id: ACCOUNT, name: "Offline account", account_status: 1,
          business: { id: businessId, name: "Offline business" },
        };
      }
      if (call.path === PAGE || call.path.startsWith(`${businessId}/`)) {
        return { httpStatus: 400, body: { error: { code: 100, message: "Offline unsupported diagnostic field" } } };
      }
    },
  });
  const result = toolPayload(await h.invoke("meta_get_token_permissions", {
    include_asset_diagnostics: true,
  }));
  assert.equal(result.configured_account_accessible, true);
  assert.equal(result.ready_for_reads, true);
  assert.equal(result.ready_for_writes, true);
  assert.equal(result.token_subject.id, "900005");
  assert.equal(result.accessible_pages[0].id, PAGE);
  assert.equal(result.permissions.length, 2);
  const page = result.page_whatsapp_diagnostics.find(item => item.page_id === PAGE);
  assert.ok(page);
  assert.match(page.diagnostic_error, /Offline unsupported diagnostic field/);
  assert.match(result.whatsapp_assets.owned_whatsapp_business_accounts_error, /Offline unsupported diagnostic field/);
  assert.match(result.whatsapp_assets.client_whatsapp_business_accounts_error, /Offline unsupported diagnostic field/);
  assert.equal(postCalls(h).length, 0);
  assert.equal(h.kvWrites.length, 0);
});

test("asset diagnostics and account inventory compose independently in one read-only request", async () => {
  const h = await harness({
    respond(call) {
      if (call.path === "me/adaccounts") {
        return { data: [{ id: `act_${ACCOUNT}`, name: "Offline account", account_status: 1 }] };
      }
    },
  });
  const result = toolPayload(await h.invoke("meta_get_token_permissions", {
    include_asset_diagnostics: true,
    include_account_inventory: true,
  }));
  assert.equal(result.asset_diagnostics_included, true);
  assert.equal(result.account_inventory.configured_account_found, true);
  assert.equal(result.configured_account_accessible, true);
  assert.equal(result.account_accessible, true);
  assert.equal(result.ready_for_reads, true);
  assert.equal(result.page_whatsapp_diagnostics[0].page_id, PAGE);
  assert.deepEqual(h.calls.map(call => call.path), [
    "me/permissions", "me", `act_${ACCOUNT}`, "me/adaccounts", "me/accounts", PAGE,
    `act_${ACCOUNT}`,
  ]);
  assertReadOnlyDiagnostic(h);
});

function assertReadOnlyDiagnostic(h) {
  assert.ok(h.calls.every(call => call.method === "GET"));
  assert.equal(h.kvReads.length, 0);
  assert.equal(h.kvWrites.length, 0);
  assert.equal(h.auditEvents.length, 0);
}

test("code 200 account denial keeps granted scope diagnostics but makes real readiness false", async () => {
  const h = await harness({
    useGate: true,
    respond(call) {
      if (call.path === `act_${ACCOUNT}`) {
        return {
          httpStatus: 400,
          body: {
            error: {
              code: 200,
              message: "Ad account owner has NOT grant ads_management or ads_read permission",
              type: "OAuthException",
            },
          },
        };
      }
    },
  });
  const result = toolPayload(await h.invoke("meta_get_token_permissions"));
  assert.equal(result.scope_ready_for_reads, true);
  assert.equal(result.scope_ready_for_writes, true);
  assert.equal(result.configured_account_accessible, false);
  assert.equal(result.account_accessible, false);
  assert.equal(result.ready_for_reads, false);
  assert.equal(result.ready_for_writes, false);
  assert.equal(result.write_switch_enabled, true);
  assert.equal(result.configured_account, undefined);
  assert.equal(result.account, null);
  assert.match(result.account_access_error, /category=ACCOUNT_ACCESS_DENIED/);
  assert.match(result.account_access_error, /code=200/);
  assert.deepEqual(h.calls.map(call => call.path), ["me/permissions", "me", `act_${ACCOUNT}`]);
  assert.equal(postCalls(h).length, 0);
  assert.equal(h.kvWrites.length, 0);
});

test("Meta calls fail closed before network access when the account gate binding is absent", async () => {
  const h = await harness({ omitGate: true });
  const result = await h.invoke("meta_get_ad_account");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /META_API_GATE is not configured/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.kvReads.length, 0);
  assert.equal(h.kvWrites.length, 0);
});

test("a real create checks the API gate before acquiring an account write lease", async () => {
  const h = await harness({ omitGate: true });
  const result = await h.invoke("meta_create_campaign_draft", {
    confirmation_phrase: `CREATE CAMPAIGN ${CAMPAIGN_NAME}`,
    name: CAMPAIGN_NAME,
    objective: "OUTCOME_ENGAGEMENT",
    request_id: REQUEST_ID,
    validate_only: false,
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /META_API_GATE is not configured/);
  assert.equal(h.lockCalls.length, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.kvReads.length, 0);
  assert.equal(h.kvWrites.length, 0);
});

for (const [label, account, errorPattern] of [
  ["wrong account identity", {
    id: "act_999999", account_id: "999999", name: "Wrong account", account_status: 1,
  }, /does not match/],
  ["empty account object", {}, /./],
]) {
  test(`${label} makes effective readiness false despite granted scopes`, async () => {
    const h = await harness({
      respond(call) {
        if (call.path === `act_${ACCOUNT}`) return account;
      },
    });
    const result = toolPayload(await h.invoke("meta_get_token_permissions"));
    assert.equal(result.scope_ready_for_reads, true);
    assert.equal(result.scope_ready_for_writes, true);
    assert.equal(result.configured_account_accessible, false);
    assert.equal(result.ready_for_reads, false);
    assert.equal(result.ready_for_writes, false);
    assert.equal(Object.hasOwn(result, "configured_account"), false);
    assert.match(result.account_access_error, errorPattern);
    assert.deepEqual(h.calls.map(call => call.path), ["me/permissions", "me", `act_${ACCOUNT}`]);
    assert.equal(postCalls(h).length, 0);
  });
}

test("global account gate serializes concurrent Graph calls from separate tool invocations", async () => {
  let active = 0;
  let maxActive = 0;
  const h = await harness({
    useGate: true,
    async respond(call) {
      if (call.path === `act_${ACCOUNT}`) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        active -= 1;
        return { id: `act_${ACCOUNT}`, name: "Offline account" };
      }
    },
  });
  const results = await Promise.all([
    h.invoke("meta_get_ad_account"),
    h.invoke("meta_get_ad_account"),
    h.invoke("meta_get_ad_account"),
  ]);
  assert.equal(maxActive, 1);
  assert.equal(h.calls.length, 3);
  for (const result of results) {
    assert.equal(toolPayload(result).account.id, `act_${ACCOUNT}`);
  }
  assert.equal(postCalls(h).length, 0);
});

test("global account gate retries a rate-limited GET exactly once", async () => {
  let accountAttempts = 0;
  const h = await harness({
    useGate: true,
    respond(call) {
      if (call.path === `act_${ACCOUNT}`) {
        accountAttempts += 1;
        if (accountAttempts === 1) {
          return {
            httpStatus: 429,
            body: {
              error: {
                code: 17,
                error_subcode: 2446079,
                message: "User request limit reached",
              },
            },
          };
        }
        return { id: `act_${ACCOUNT}`, name: "Offline account" };
      }
    },
  });
  const result = toolPayload(await h.invoke("meta_get_ad_account"));
  assert.equal(result.account.id, `act_${ACCOUNT}`);
  assert.equal(accountAttempts, 2);
  assert.deepEqual(h.calls.map(call => call.method), ["GET", "GET"]);
  assert.equal(postCalls(h).length, 0);
});

test("global account gate recognizes a Meta code 613 rate limit returned as HTTP 400", async () => {
  let accountAttempts = 0;
  const h = await harness({
    useGate: true,
    respond(call) {
      if (call.path === `act_${ACCOUNT}`) {
        accountAttempts += 1;
        if (accountAttempts === 1) {
          return {
            httpStatus: 400,
            body: { error: { code: 613, message: "Calls to this API have exceeded the rate limit" } },
          };
        }
        return { id: `act_${ACCOUNT}`, name: "Offline account" };
      }
    },
  });
  const result = toolPayload(await h.invoke("meta_get_ad_account"));
  assert.equal(result.account.id, `act_${ACCOUNT}`);
  assert.equal(accountAttempts, 2);
  assert.deepEqual(h.calls.map(call => call.method), ["GET", "GET"]);
});

test("non-JSON 429 with a long Retry-After enters cooldown without an inline retry", async () => {
  let accountAttempts = 0;
  const h = await harness({
    useGate: true,
    respond(call) {
      if (call.path === `act_${ACCOUNT}`) {
        accountAttempts += 1;
        return {
          httpStatus: 429,
          headers: { "Retry-After": "10" },
          rawBody: "upstream rate limit without JSON",
        };
      }
    },
  });
  const first = await h.invoke("meta_get_ad_account");
  assert.equal(first.isError, true);
  assert.match(first.content[0].text, /category=RATE_LIMIT/);
  assert.match(first.content[0].text, /non-JSON HTTP 429/);
  assert.equal(accountAttempts, 1, "Retry-After above the inline cap must not be slept and retried");

  const second = await h.invoke("meta_get_ad_account");
  assert.equal(second.isError, true);
  assert.match(second.content[0].text, /category=RATE_LIMIT_COOLDOWN/);
  assert.equal(accountAttempts, 1, "cooldown must reject before another Graph request");
  assert.equal(h.calls.length, 1);
});

test("global account gate never retries a rate-limited POST", async () => {
  let postAttempts = 0;
  const h = await harness({
    useGate: true,
    respond(call) {
      if (call.method === "POST" && call.path === CAMPAIGN) {
        postAttempts += 1;
        return {
          httpStatus: 429,
          body: {
            error: {
              code: 17,
              error_subcode: 2446079,
              message: "User request limit reached",
            },
          },
        };
      }
    },
  });
  const result = await h.invoke("meta_set_delivery_status", {
    confirmation_phrase: `SET CAMPAIGN ${CAMPAIGN} ACTIVE`,
    expected_name: CAMPAIGN_NAME,
    object_id: CAMPAIGN,
    object_type: "CAMPAIGN",
    status: "ACTIVE",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /category=RATE_LIMIT/);
  assert.equal(postAttempts, 1);
  assert.deepEqual(h.calls.map(call => call.method), ["GET", "POST"]);
  assert.equal(h.auditEvents.length, 0);
});

test("granted scopes cannot report readiness when configured account returns permission error 200", async () => {
  const h = await harness({ respond(call) {
    if (call.path === `act_${ACCOUNT}`) return { httpStatus: 403, body: {
      error: { code: 200, message: "Ad account owner has NOT grant ads_management or ads_read permission" },
    } };
  } });
  const result = toolPayload(await h.invoke("meta_get_token_permissions"));
  assert.equal(result.account_accessible, false);
  assert.equal(result.account, null);
  assert.equal(result.configured_account_accessible, false);
  assert.match(result.account_access_error, /200/);
  assert.equal(result.ready_for_reads, false);
  assert.equal(result.ready_for_writes, false);
  assert.equal(result.write_access_verified, false);
  assert.equal(result.permissions.every(item => item.status === "granted"), true);
  assert.equal(h.calls.filter(call => call.path === `act_${ACCOUNT}`).length, 1);
  assert.equal(Object.hasOwn(result, "account_inventory"), false);
  assertReadOnlyDiagnostic(h);
});

test("readiness reports a successful minimal account read independently of WhatsApp diagnostics", async () => {
  const h = await harness({ respond(call) {
    if (call.path === "me/accounts" || call.path === PAGE || call.path.includes("whatsapp_business_accounts")) {
      throw new Error("Offline business diagnostic unavailable");
    }
  } });
  const result = toolPayload(await h.invoke("meta_get_token_permissions"));
  assert.equal(result.account_accessible, true);
  assert.equal(result.account.account_id, ACCOUNT);
  assert.equal(result.account_access_error, null);
  assert.equal(result.ready_for_reads, true);
  assert.equal(result.ready_for_writes, true);
  assert.equal(result.write_access_verified, false);
  assert.equal(result.asset_diagnostics_included, false);
  assert.deepEqual(result.accessible_pages, []);
  assert.deepEqual(result.page_whatsapp_diagnostics, []);
  assert.deepEqual(result.whatsapp_assets, {});
  assert.deepEqual(h.calls.map(call => call.path), ["me/permissions", "me", `act_${ACCOUNT}`]);
  assertReadOnlyDiagnostic(h);
});

for (const [label, options] of [
  ["disabled write switch", { env: { META_WRITE_ENABLED: "false" } }],
  ["missing management scope", { respond(call) {
    if (call.path === "me/permissions") return { data: [{ permission: "ads_read", status: "granted" }] };
  } }],
]) test(`${label} prevents write readiness without denying confirmed read access`, async () => {
  const h = await harness(options);
  const result = toolPayload(await h.invoke("meta_get_token_permissions", { include_account_inventory: false }));
  assert.equal(result.account_accessible, true);
  assert.equal(result.configured_account_accessible, true);
  assert.equal(result.ready_for_reads, true);
  assert.equal(result.ready_for_writes, false);
  assert.equal(result.write_access_verified, false);
  assert.equal(h.calls.some(call => call.path === "me/adaccounts"), false);
  assertReadOnlyDiagnostic(h);
});

for (const [label, response] of [
  ["mismatched account identity", () => ({ id: "act_999999", account_id: "999999", name: "Other", account_status: 1 })],
  ["network failure", () => { throw new Error("Offline network failure"); }],
]) test(`${label} cannot report configured-account readiness`, async () => {
  const h = await harness({ respond(call) { if (call.path === `act_${ACCOUNT}`) return response(); } });
  const result = toolPayload(await h.invoke("meta_get_token_permissions"));
  assert.equal(result.account_accessible, false);
  assert.equal(result.configured_account_accessible, false);
  assert.equal(result.ready_for_reads, false);
  assert.equal(result.ready_for_writes, false);
  assert.equal(result.account, null);
  assert.ok(result.account_access_error);
  assertReadOnlyDiagnostic(h);
});

const expectedInventoryAccount = { id: `act_${ACCOUNT}`, name: "Offline account", account_status: 1 };
const unrelatedInventoryAccount = { id: "act_999999", name: "UNRELATED_PRIVATE_NAME", account_status: 1 };

test("opt-in account inventory stops at configured account and exposes only its whitelisted metadata", async () => {
  const h = await harness({ respond(call) {
    if (call.path === "me/adaccounts") return {
      data: [unrelatedInventoryAccount, { ...expectedInventoryAccount, access_token: "UNEXPECTED_PRIVATE_FIELD" }],
      paging: { next: "https://example.invalid/PRIVATE_NEXT", cursors: { after: "PRIVATE_CURSOR" } },
    };
  } });
  const result = toolPayload(await h.invoke("meta_get_token_permissions", { include_account_inventory: true }));
  assert.deepEqual(result.account_inventory, {
    configured_account_found: true, scan_complete: false, accounts_scanned: 2, configured_account: expectedInventoryAccount,
  });
  const calls = h.calls.filter(call => call.path === "me/adaccounts");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, { fields: "id,name,account_status", limit: "25" });
  assert.doesNotMatch(JSON.stringify(result), /UNRELATED_PRIVATE_NAME|UNEXPECTED_PRIVATE_FIELD|PRIVATE_NEXT|PRIVATE_CURSOR/);
  assertReadOnlyDiagnostic(h);
});

test("account inventory follows only bounded after cursors and finds configured account on a later page", async () => {
  const h = await harness({ respond(call) {
    if (call.path === "me/adaccounts") return call.params.after
      ? { data: [expectedInventoryAccount] }
      : { data: [unrelatedInventoryAccount], paging: { next: "https://not-requested.invalid/private", cursors: { after: "NEXT_PAGE" } } };
  } });
  const result = toolPayload(await h.invoke("meta_get_token_permissions", { include_account_inventory: true }));
  assert.deepEqual(result.account_inventory, {
    configured_account_found: true, scan_complete: true, accounts_scanned: 2, configured_account: expectedInventoryAccount,
  });
  const calls = h.calls.filter(call => call.path === "me/adaccounts");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].params, { fields: "id,name,account_status", limit: "25", after: "NEXT_PAGE" });
  assert.doesNotMatch(JSON.stringify(result.account_inventory), /UNRELATED_PRIVATE_NAME|NEXT_PAGE|https:/);
  assertReadOnlyDiagnostic(h);
});

test("account inventory distinguishes exhausted absence from a truncated 75-account scan", async () => {
  for (const hasMore of [false, true]) {
    let pages = 0;
    const h = await harness({ respond(call) {
      if (call.path !== "me/adaccounts") return;
      pages++;
      return { data: Array.from({ length: 25 }, (_, i) => ({ ...unrelatedInventoryAccount, id: `act_${800000 + pages * 25 + i}` })),
        ...(hasMore ? { paging: { next: "https://not-requested.invalid/private", cursors: { after: `NEXT_${pages}` } } } : {}) };
    } });
    const result = toolPayload(await h.invoke("meta_get_token_permissions", { include_account_inventory: true }));
    assert.deepEqual(result.account_inventory, {
      configured_account_found: false, scan_complete: !hasMore, accounts_scanned: hasMore ? 75 : 25, configured_account: null,
    });
    assert.equal(pages, hasMore ? 3 : 1);
    assertReadOnlyDiagnostic(h);
  }
});

test("inventory errors are isolated and stop scanning without changing configured account readiness", async () => {
  let pages = 0;
  const h = await harness({ respond(call) {
    if (call.path !== "me/adaccounts") return;
    pages++;
    if (pages === 1) return { data: [unrelatedInventoryAccount], paging: { next: "https://not-requested.invalid/", cursors: { after: "NEXT" } } };
    return { httpStatus: 403, body: { error: { code: 200, message: "Inventory denied https://private.invalid/?after=PRIVATE_CURSOR" } } };
  } });
  const result = toolPayload(await h.invoke("meta_get_token_permissions", { include_account_inventory: true }));
  assert.equal(pages, 2);
  assert.equal(result.account_inventory.configured_account_found, false);
  assert.equal(result.account_inventory.scan_complete, false);
  assert.equal(result.account_inventory.accounts_scanned, 1);
  assert.match(result.account_inventory.diagnostic_error, /200/);
  assert.doesNotMatch(JSON.stringify(result.account_inventory), /https:|PRIVATE_CURSOR|UNRELATED_PRIVATE_NAME/);
  assert.equal(result.account_accessible, true);
  assert.equal(result.ready_for_reads, true);
  assertReadOnlyDiagnostic(h);
});

test("inventory cannot promote failed direct configured-account access to readiness", async () => {
  const h = await harness({ respond(call) {
    if (call.path === `act_${ACCOUNT}`) return { httpStatus: 403, body: { error: { code: 200, message: "Access denied" } } };
    if (call.path === "me/adaccounts") return { data: [expectedInventoryAccount] };
  } });
  const result = toolPayload(await h.invoke("meta_get_token_permissions", { include_account_inventory: true }));
  assert.equal(result.account_inventory.configured_account_found, true);
  assert.equal(result.account_accessible, false);
  assert.equal(result.configured_account_accessible, false);
  assert.equal(result.ready_for_reads, false);
  assert.equal(result.ready_for_writes, false);
  assertReadOnlyDiagnostic(h);
});

const businessInput = { business_access_diagnostic_id: BUSINESS };
const businessAccount = { id: `act_${ACCOUNT}`, account_id: ACCOUNT, name: "Configured account", business: { id: BUSINESS }, user_tasks: ["ANALYZE", "ADVERTISE"] };
const systemUser = { id: "900005", name: "Offline test subject", role: "ADMIN" };
const otherSystemUser = { id: "888881", name: "PRIVATE_OTHER_SUBJECT", role: "ADMIN" };
const otherBusinessAccount = { id: "act_888882", account_id: "888882", name: "PRIVATE_OTHER_ACCOUNT" };

function businessFixtures(overrides = {}) {
  return (call) => {
    const override = overrides[call.path];
    if (override) return typeof override === "function" ? override(call) : override;
    if (call.path === `${BUSINESS}/system_users`) return { data: [otherSystemUser, systemUser] };
    if (call.path === `${BUSINESS}/owned_ad_accounts`) return { data: [otherBusinessAccount, businessAccount] };
    if (call.path === `${BUSINESS}/client_ad_accounts`) return { data: [businessAccount] };
  };
}

function assertBoundedBusinessRead(h) {
  assertReadOnlyDiagnostic(h);
  assert.equal(h.lockCalls.length, 0);
  assert.equal(h.calls.some(call => /assigned_ad_accounts|whatsapp|me\/accounts|me\/adaccounts/.test(call.path)), false);
  for (const edge of ["system_users", "owned_ad_accounts", "client_ad_accounts"]) {
    const calls = h.calls.filter(call => call.path.endsWith(`/${edge}`));
    assert.ok(calls.length <= 3);
    for (const call of calls) assert.equal(call.params.limit, "25");
  }
}

test("business diagnostic observes ADMIN and ownership without promoting denied account access or disclosing unrelated assets", async () => {
  const h = await harness({ respond: businessFixtures({
    [`act_${ACCOUNT}`]: { httpStatus: 403, body: { error: { code: 200, message: "Access denied" } } },
    [`${BUSINESS}/system_users`]: { data: [otherSystemUser, { ...systemUser, private_field: "PRIVATE_FIELD" }] },
    [`${BUSINESS}/owned_ad_accounts`]: { data: [otherBusinessAccount, { ...businessAccount, private_field: "PRIVATE_FIELD" }] },
  }) });
  const result = toolPayload(await h.invoke("meta_get_token_permissions", {
    ...businessInput,
    include_account_inventory: true,
    include_asset_diagnostics: true,
  }));
  const d = result.business_access_diagnostic;
  assert.equal(d.system_users.match.role, "ADMIN");
  assert.equal(d.owned_ad_accounts.match_found, true);
  assert.equal(d.owned_ad_accounts.match.business_matches_requested, true);
  assert.equal(d.client_ad_accounts.skipped, true);
  assert.equal(result.ready_for_reads, false);
  assert.equal(result.ready_for_writes, false);
  assert.equal(result.write_access_verified, false);
  assert.equal(result.page_diagnostics_skipped, true);
  assert.equal(result.asset_diagnostics_included, false);
  assert.equal(result.whatsapp_assets.skipped, true);
  assert.equal(result.account_inventory.skipped, true);
  assert.equal(Object.hasOwn(d, "admin_authorized"), false);
  assert.doesNotMatch(JSON.stringify(result), /888881|888882|PRIVATE_OTHER|PRIVATE_FIELD/);
  assert.deepEqual(h.calls.filter(call => call.path.startsWith(`${BUSINESS}/`)).map(call => call.params), [
    { fields: "id,system_user_id,name,role", limit: "25" },
    { fields: "id,account_id,name,business,user_tasks", limit: "25", include_shared_ad_accounts: "false" },
  ]);
  assertBoundedBusinessRead(h);
});

test("business diagnostic still reads ownership after denied system-user access and does not repeat the failed edge", async () => {
  const h = await harness({ respond: businessFixtures({
    [`${BUSINESS}/system_users`]: { httpStatus: 403, body: { error: { code: 200, error_subcode: 123, message: "PRIVATE_PERSON 888884 https://secret.invalid/?access_token=PRIVATE_TOKEN" } } },
  }) });
  const result = toolPayload(await h.invoke("meta_get_token_permissions", businessInput));
  const d = result.business_access_diagnostic;
  assert.equal(d.system_users.match_found, false);
  assert.equal(d.system_users.scan_complete, false);
  assert.match(d.system_users.diagnostic_error, /code=200, subcode=123/);
  assert.equal(d.owned_ad_accounts.match_found, true);
  assert.equal(h.calls.filter(call => call.path === `${BUSINESS}/system_users`).length, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PERSON|888884|secret.invalid|PRIVATE_TOKEN/);
  assertBoundedBusinessRead(h);
});

test("business diagnostic finds a shared configured account only on the client edge without exposing the owner's identity", async () => {
  const h = await harness({ respond: businessFixtures({
    [`${BUSINESS}/system_users`]: { data: [otherSystemUser] },
    [`${BUSINESS}/owned_ad_accounts`]: { data: [otherBusinessAccount] },
    [`${BUSINESS}/client_ad_accounts`]: { data: [{ ...businessAccount, business: { id: "888885", name: "PRIVATE_OWNER" } }] },
  }) });
  const result = toolPayload(await h.invoke("meta_get_token_permissions", businessInput));
  const d = result.business_access_diagnostic;
  assert.equal(d.system_users.match_found, false);
  assert.equal(d.system_users.scan_complete, true);
  assert.equal(d.owned_ad_accounts.match_found, false);
  assert.equal(d.client_ad_accounts.match_found, true);
  assert.equal(d.client_ad_accounts.match.business_matches_requested, false);
  assert.doesNotMatch(JSON.stringify(result), /888885|PRIVATE_OWNER|PRIVATE_OTHER/);
  assertBoundedBusinessRead(h);
});

for (const systemId of [900005, "900005"]) test(`system-user alternate ID matches the token subject when supplied safely as ${typeof systemId}`, async () => {
  const h = await harness({ respond: businessFixtures({
    [`${BUSINESS}/system_users`]: { data: [{ id: "122098925067456170", system_user_id: systemId, name: "Mapped subject", role: "ADMIN" }] },
  }) });
  const result = toolPayload(await h.invoke("meta_get_token_permissions", businessInput));
  assert.equal(result.business_access_diagnostic.system_users.match_found, true);
  assert.equal(result.business_access_diagnostic.system_users.match.system_user_id, "900005");
  assert.equal(result.business_access_diagnostic.system_users.match.id, "122098925067456170");
  assertBoundedBusinessRead(h);
});

test("large string business and system-user IDs preserve exact digits beyond JavaScript's safe range", async () => {
  const business = "123456789012345678901234567890";
  const subject = "122098925067456170";
  const h = await harness({ respond(call) {
    if (call.path === "me") return { id: subject, name: "Token subject" };
    if (call.path === `${business}/system_users`) return { data: [{ ...systemUser, id: "61593685101326", system_user_id: subject }] };
    if (call.path === `${business}/owned_ad_accounts`) return { data: [{ ...businessAccount, business: { id: business } }] };
  } });
  const result = toolPayload(await h.invoke("meta_get_token_permissions", { business_access_diagnostic_id: business }));
  assert.equal(result.business_access_diagnostic.business_id, business);
  assert.equal(result.business_access_diagnostic.system_users.match.system_user_id, subject);
  assert.equal(result.business_access_diagnostic.system_users.match.id, "61593685101326");
  assertBoundedBusinessRead(h);
});

for (const unsafeId of [Number.MAX_SAFE_INTEGER + 1, -1, 1.5, "not-a-number"]) test(`unsafe optional system-user ID ${unsafeId} is omitted without discarding a valid ID match`, async () => {
  const h = await harness({ respond: businessFixtures({
    [`${BUSINESS}/system_users`]: { data: [{ ...systemUser, system_user_id: unsafeId }] },
  }) });
  const result = toolPayload(await h.invoke("meta_get_token_permissions", businessInput));
  const d = result.business_access_diagnostic.system_users;
  assert.equal(d.match_found, true);
  assert.equal(d.match.id, systemUser.id);
  assert.equal(Object.hasOwn(d.match, "system_user_id"), false);
  assert.match(d.identity_warning, /omitted/);
  assertBoundedBusinessRead(h);
});

test("imprecise alternate IDs never prove system-user identity", async () => {
  const h = await harness({ respond: businessFixtures({
    me: { id: String(Number.MAX_SAFE_INTEGER + 1), name: "Subject" },
    [`${BUSINESS}/system_users`]: { data: [{ ...otherSystemUser, system_user_id: Number.MAX_SAFE_INTEGER + 1 }] },
  }) });
  const result = toolPayload(await h.invoke("meta_get_token_permissions", businessInput));
  assert.equal(result.business_access_diagnostic.system_users.match_found, false);
  assert.match(result.business_access_diagnostic.system_users.identity_warning, /incomplete/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_OTHER_SUBJECT|888881/);
  assertBoundedBusinessRead(h);
});

test("business scans use only returned cursors, stop after three pages per edge, and distinguish incomplete results", async () => {
  const counts = {};
  const h = await harness({ respond(call) {
    if (!call.path.startsWith(`${BUSINESS}/`)) return;
    const n = counts[call.path] = (counts[call.path] || 0) + 1;
    if (n > 1) assert.equal(call.params.after, `CURSOR_${n - 1}`);
    const isUser = call.path.endsWith("system_users");
    return { data: Array.from({ length: 25 }, (_, i) => ({ id: `${isUser ? "" : "act_"}${700000 + n * 25 + i}`, name: "PRIVATE_OTHER" })),
      paging: { next: "https://never-fetch.invalid/PRIVATE_URL", cursors: { after: `CURSOR_${n}` } } };
  } });
  const result = toolPayload(await h.invoke("meta_get_token_permissions", businessInput));
  for (const edge of ["system_users", "owned_ad_accounts", "client_ad_accounts"]) {
    assert.equal(counts[`${BUSINESS}/${edge}`], 3);
    assert.equal(result.business_access_diagnostic[edge].scan_complete, false);
    assert.equal(result.business_access_diagnostic[edge].records_scanned, 75);
    assert.equal(result.business_access_diagnostic[edge].match_found, false);
  }
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_OTHER|PRIVATE_URL|CURSOR_|7000/);
  assertBoundedBusinessRead(h);
});

for (const paging of [{ next: "https://ignored.invalid/" }, { next: "https://ignored.invalid/", cursors: { after: "REPEATED" } }]) test("business scanning stops on missing or repeated cursors without claiming complete absence", async () => {
  const h = await harness({ respond: businessFixtures({ [`${BUSINESS}/system_users`]: { data: [], paging } }) });
  const result = toolPayload(await h.invoke("meta_get_token_permissions", businessInput));
  const d = result.business_access_diagnostic.system_users;
  assert.equal(d.scan_complete, false);
  assert.match(d.diagnostic_error, /incomplete/);
  assert.ok(h.calls.filter(call => call.path === `${BUSINESS}/system_users`).length <= 2);
  assertBoundedBusinessRead(h);
});

for (const [label, body] of [
  ["missing data", { paging: {} }],
  ["too many rows", { data: Array.from({ length: 26 }, () => otherBusinessAccount) }],
  ["mismatched configured account_id", { data: [{ ...businessAccount, account_id: "888888" }] }],
  ["imprecise account_id", { data: [{ ...businessAccount, account_id: Number.MAX_SAFE_INTEGER + 1 }] }],
]) test(`business ${label} returns incomplete sanitized diagnostics and still checks the client edge`, async () => {
  const h = await harness({ respond: businessFixtures({ [`${BUSINESS}/owned_ad_accounts`]: body }) });
  const result = toolPayload(await h.invoke("meta_get_token_permissions", businessInput));
  const d = result.business_access_diagnostic;
  assert.equal(d.owned_ad_accounts.match_found, false);
  assert.equal(d.owned_ad_accounts.scan_complete, false);
  assert.ok(d.owned_ad_accounts.diagnostic_error);
  assert.equal(d.client_ad_accounts.scan_complete, true);
  assertBoundedBusinessRead(h);
});

test("a rate-limited direct account read skips all business edges", async () => {
  const h = await harness({ respond: businessFixtures({ [`act_${ACCOUNT}`]: { httpStatus: 429, body: { error: { code: 17, message: "Rate limited" } } } }) });
  const result = toolPayload(await h.invoke("meta_get_token_permissions", businessInput));
  assert.equal(result.business_access_diagnostic.skipped, true);
  assert.equal(h.calls.some(call => call.path.startsWith(`${BUSINESS}/`)), false);
  assert.equal(h.calls.filter(call => call.path === `act_${ACCOUNT}`).length, 1);
  assertBoundedBusinessRead(h);
});

for (const edge of ["system_users", "owned_ad_accounts"]) test(`persistent rate limit returned by the gate on ${edge} stops subsequent business edges`, async () => {
  const h = await harness({ respond: businessFixtures({ [`${BUSINESS}/${edge}`]: { httpStatus: 429, body: { error: { code: 613, message: "Rate limited" } } } }) });
  const result = toolPayload(await h.invoke("meta_get_token_permissions", businessInput));
  assert.equal(result.business_access_diagnostic.client_ad_accounts.skipped, true);
  assert.equal(h.calls.some(call => call.path === `${BUSINESS}/client_ad_accounts`), false);
  if (edge === "system_users") assert.equal(h.calls.some(call => call.path === `${BUSINESS}/owned_ad_accounts`), false);
  assert.equal(h.calls.filter(call => call.path === `${BUSINESS}/${edge}`).length, 1);
  assertBoundedBusinessRead(h);
});

for (const businessId of ["", "../me", "act_123", "123/owned_ad_accounts", "1".repeat(31), 900006]) test(`invalid business ID ${businessId} is rejected before any network activity`, async () => {
  const h = await harness();
  await assert.rejects(h.invoke("meta_get_token_permissions", { business_access_diagnostic_id: businessId }));
  assert.equal(h.calls.length, 0);
  assert.equal(h.lockCalls.length, 0);
});

test("account reads remain single-request by default and omit unrequested targeting diagnostics", async () => {
  const h = await harness();
  const result = toolPayload(await h.invoke("meta_get_ad_account"));
  assert.equal(result.account.id, `act_${ACCOUNT}`);
  assert.equal(result.connector_version, "2.3.11");
  assert.equal(Object.hasOwn(result, "work_position_search"), false);
  assert.equal(Object.hasOwn(result, "work_position_validation"), false);
  assert.equal(Object.hasOwn(result, "audience_inventory"), false);
  assert.equal(Object.hasOwn(result, "geo_location_search"), false);
  assert.equal(Object.hasOwn(result, "reach_estimate"), false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "GET");
  assert.equal(h.calls[0].path, `act_${ACCOUNT}`);
  assert.equal(h.kvWrites.length, 0);
});

test("opt-in work-position lookup and validation are bounded, Brazil-specific GET requests", async () => {
  const positions = [{ id: "910001", name: "Physician", type: "work_positions" }];
  const validation = [{ id: "910001", valid: true }, { id: "910002", valid: false }];
  const h = await harness({
    respond(call) {
      if (call.path === `act_${ACCOUNT}/targetingsearch`) {
        return { data: positions, paging: { cursors: { after: "offline-cursor" } } };
      }
      if (call.path === `act_${ACCOUNT}/targetingvalidation`) return { data: validation };
    },
  });
  const result = toolPayload(await h.invoke("meta_get_ad_account", {
    work_position_queries: ["Physician", "Emergency Physician"],
    work_position_ids: ["910001", "910002"],
  }));
  assert.equal(result.account.id, `act_${ACCOUNT}`);
  assert.equal(h.calls.length, 4); // account + two searches + one batched validation
  assert.equal(postCalls(h).length, 0);
  const searches = h.calls.filter(call => call.path.endsWith("/targetingsearch"));
  assert.equal(searches.length, 2);
  assert.deepEqual(searches.map(call => call.params.q), ["Physician", "Emergency Physician"]);
  for (const call of searches) {
    assert.equal(call.method, "GET");
    assert.deepEqual(call.params.countries, ["BR"]);
    assert.equal(call.params.limit_type, "work_positions");
    assert.deepEqual(call.params.whitelisted_types, ["work_positions"]);
    assert.equal(call.params.limit, "20");
  }
  const check = h.calls.find(call => call.path.endsWith("/targetingvalidation"));
  assert.equal(check.method, "GET");
  assert.deepEqual(check.params.targeting_list, [
    { type: "work_positions", id: "910001" },
    { type: "work_positions", id: "910002" },
  ]);
  assert.equal(result.work_position_search.length, 2);
  assert.equal(result.work_position_search[0].query, "Physician");
  assert.deepEqual(result.work_position_search[0].results, positions);
  assert.deepEqual(result.work_position_validation.results, validation);
  assert.equal(h.kvWrites.length, 0);
});

test("work-position schema bounds and transport failures preserve account-read safety", async () => {
  for (const input of [
    { work_position_queries: Array.from({ length: 6 }, () => "Physician") },
    { work_position_ids: Array.from({ length: 21 }, (_, i) => String(910001 + i)) },
    { work_position_ids: ["not-a-numeric-id"] },
  ]) {
    const h = await harness();
    await assert.rejects(h.invoke("meta_get_ad_account", input));
    assert.equal(h.calls.length, 0);
  }
  const h = await harness({
    respond(call) {
      if (call.path.endsWith("/targetingsearch") || call.path.endsWith("/targetingvalidation")) {
        return { httpStatus: 400, body: { error: { code: 100, message: "Offline targeting diagnostic failure" } } };
      }
    },
  });
  const result = toolPayload(await h.invoke("meta_get_ad_account", {
    work_position_queries: ["Physician"], work_position_ids: ["910001"],
  }));
  assert.equal(result.account.id, `act_${ACCOUNT}`);
  assert.equal(result.connector_version, "2.3.11");
  assert.match(result.work_position_search[0].diagnostic_error, /Offline targeting diagnostic failure/);
  assert.match(result.work_position_validation.diagnostic_error, /Offline targeting diagnostic failure/);
  assert.equal(postCalls(h).length, 0);
  assert.equal(h.kvWrites.length, 0);
});

test("city diagnostics use bounded Brazil city GET searches and return only location metadata", async () => {
  const city = { key: "930001", name: "Chapecó", type: "city", country_code: "BR", country_name: "Brazil", region: "Santa Catarina", region_id: "459" };
  const h = await harness({
    respond(call) {
      if (call.path === "search") return {
        data: [{ ...city, raw_url: "https://graph.facebook.com/?access_token=FAKE_SECRET_MUST_NOT_RETURN" }],
        paging: { next: "https://graph.facebook.com/?access_token=FAKE_SECRET_MUST_NOT_RETURN", cursors: { after: "private-cursor" } },
      };
    },
  });
  const result = toolPayload(await h.invoke("meta_get_ad_account", { geo_location_queries: [" Chapecó ", "Videira"] }));
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls.slice(1).map(call => call.params.q), ["Chapecó", "Videira"]);
  for (const call of h.calls.slice(1)) {
    assert.equal(call.method, "GET");
    assert.equal(call.path, "search");
    assert.deepEqual(call.params, { type: "adgeolocation", location_types: ["city"], country_code: "BR", q: call.params.q, limit: "20" });
  }
  assert.deepEqual(result.geo_location_search, [
    { query: "Chapecó", results: [city] }, { query: "Videira", results: [city] },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /FAKE_SECRET|access_token|paging|private-cursor/);
  assert.equal(postCalls(h).length, 0);
  assert.equal(h.kvWrites.length, 0);
  assert.equal(h.kvReads.length, 0);
});

test("city diagnostics normalize numeric region identifiers and preserve string identifiers", async () => {
  for (const regionId of [459, "459"]) {
    const h = await harness({
      respond(call) {
        if (call.path === "search") return {
          data: [{ key: "248896", name: "Chapecó", type: "city", country_code: "BR", region: "Santa Catarina", region_id: regionId }],
        };
      },
    });
    const result = toolPayload(await h.invoke("meta_get_ad_account", { geo_location_queries: ["Chapecó"] }));
    assert.equal(result.geo_location_search[0].results[0].region_id, "459");
    assert.equal(result.geo_location_search[0].results[0].key, "248896");
    assert.equal(postCalls(h).length, 0);
    assert.equal(h.kvWrites.length, 0);
  }
});

test("malformed region identifiers fail only the city diagnostic without leaking arbitrary objects", async () => {
  for (const regionId of [{ access_token: "FAKE_SECRET_MUST_NOT_RETURN" }, -1, 1.5]) {
    const h = await harness({
      respond(call) {
        if (call.path === "search") return { data: [{ key: "248896", name: "Chapecó", region_id: regionId }] };
      },
    });
    const result = toolPayload(await h.invoke("meta_get_ad_account", { geo_location_queries: ["Chapecó"] }));
    assert.equal(result.account.id, `act_${ACCOUNT}`);
    assert.match(result.geo_location_search[0].diagnostic_error, /region_id/);
    assert.equal(Object.hasOwn(result.geo_location_search[0], "results"), false);
    assert.doesNotMatch(JSON.stringify(result), /FAKE_SECRET|access_token/);
    assert.equal(postCalls(h).length, 0);
    assert.equal(h.kvWrites.length, 0);
  }
});

test("reach estimation preserves nested targeting and normalizes only aggregate data from object or array responses", async () => {
  const targeting = {
    age_min: 26, age_max: 54,
    geo_locations: { cities: [{ key: "930001" }] },
    flexible_spec: [{ work_positions: [{ id: "910001" }, { id: "910002" }] }],
    targeting_automation: { advantage_audience: 0 }, user_age_unknown: false,
  };
  const estimate = { users_lower_bound: 0, users_upper_bound: 1000, estimate_ready: false };
  for (const asArray of [false, true]) {
    const h = await harness({
      respond(call) {
        if (call.path === `act_${ACCOUNT}/reachestimate`) return {
          data: asArray ? [{ ...estimate, access_token: "FAKE_SECRET_MUST_NOT_RETURN" }] : { ...estimate, access_token: "FAKE_SECRET_MUST_NOT_RETURN" },
          paging: { next: "https://graph.facebook.com/?access_token=FAKE_SECRET_MUST_NOT_RETURN" },
        };
      },
    });
    const result = toolPayload(await h.invoke("meta_get_ad_account", { reach_estimate_targeting: targeting }));
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[1], { method: "GET", path: `act_${ACCOUNT}/reachestimate`, params: { targeting_spec: targeting } });
    assert.deepEqual(result.reach_estimate, { results: [estimate] });
    assert.doesNotMatch(JSON.stringify(result), /FAKE_SECRET|access_token|paging/);
    assert.equal(postCalls(h).length, 0);
    assert.equal(h.kvWrites.length, 0);
    assert.equal(h.kvReads.length, 0);
  }
});

test("city and reach input bounds reject oversized diagnostic requests before network access", async () => {
  for (const input of [
    { geo_location_queries: [] },
    { geo_location_queries: Array(6).fill("Chapecó") },
    { geo_location_queries: [" "] },
    { geo_location_queries: ["X".repeat(81)] },
    { reach_estimate_targeting: "not-an-object" },
    { reach_estimate_targeting: { oversized: "X".repeat(50_000) } },
  ]) {
    const h = await harness();
    await assert.rejects(h.invoke("meta_get_ad_account", input));
    assert.equal(h.calls.length, 0);
  }
});

test("city and reach failures remain isolated diagnostics and preserve the account read", async () => {
  const h = await harness({
    respond(call) {
      if (call.path === "search" && call.params.q === "Chapecó") return {
        httpStatus: 400, body: { error: { code: 100, message: "Offline city diagnostic failure" } },
      };
      if (call.path === "search") return { data: [] };
      if (call.path.endsWith("/reachestimate")) return {
        httpStatus: 400, body: { error: { code: 100, message: "Offline reach diagnostic failure" } },
      };
    },
  });
  const result = toolPayload(await h.invoke("meta_get_ad_account", {
    geo_location_queries: ["Chapecó", "Videira"], reach_estimate_targeting: { geo_locations: { countries: ["BR"] } },
  }));
  assert.equal(result.account.id, `act_${ACCOUNT}`);
  assert.match(result.geo_location_search[0].diagnostic_error, /Offline city diagnostic failure/);
  assert.deepEqual(result.geo_location_search[1], { query: "Videira", results: [] });
  assert.match(result.reach_estimate.diagnostic_error, /Offline reach diagnostic failure/);
  assert.equal(postCalls(h).length, 0);
  assert.equal(h.kvWrites.length, 0);
  assert.equal(h.kvReads.length, 0);
});

test("saved and custom audience inventories use fixed account GET edges and sanitize pagination", async () => {
  for (const kind of ["saved", "custom"]) {
    const edge = kind === "saved" ? "saved_audiences" : "customaudiences";
    const audiences = kind === "saved"
      ? [{ id: "920001", name: "Médicos Sul", targeting: { age_min: 26, age_max: 55 } }]
      : [{ id: "920002", name: "Médicos Sul", subtype: "CUSTOM", data_source: { type: "FILE_IMPORTED" } }];
    const h = await harness({
      respond(call) {
        if (call.path === `act_${ACCOUNT}/${edge}`) {
          return {
            data: audiences,
            paging: {
              cursors: { before: "offline-before", after: "offline-after" },
              ...(kind === "saved" ? {
                next: `https://graph.facebook.com/v26.0/act_${ACCOUNT}/${edge}?access_token=FAKE_SECRET_MUST_NOT_RETURN`,
              } : {}),
            },
          };
        }
      },
    });
    const input = { audience_inventory: { kind, ...(kind === "custom" ? { after: "opaque-next-page", limit: 17 } : {}) } };
    const result = toolPayload(await h.invoke("meta_get_ad_account", input));
    assert.equal(h.calls.length, 2); // account plus exactly one metadata page
    const request = h.calls[1];
    assert.equal(request.method, "GET");
    assert.equal(request.path, `act_${ACCOUNT}/${edge}`);
    assert.equal(request.params.limit, kind === "saved" ? "100" : "17");
    assert.equal(request.params.after, kind === "saved" ? undefined : "opaque-next-page");
    assert.match(request.params.fields, kind === "saved" ? /targeting/ : /data_source/);
    assert.doesNotMatch(request.params.fields, /(^|,)users(,|$)/);
    assert.equal(result.audience_inventory.kind, kind);
    assert.deepEqual(result.audience_inventory.audiences, audiences);
    assert.equal(result.audience_inventory.paging.after, "offline-after");
    assert.equal(result.audience_inventory.has_next, kind === "saved");
    // An after cursor alone must not imply another page; raw URL/token is private.
    assert.doesNotMatch(JSON.stringify(result), /FAKE_SECRET_MUST_NOT_RETURN|graph\.facebook\.com|access_token/);
    assert.equal(postCalls(h).length, 0);
    assert.equal(h.kvWrites.length, 0);
    assert.equal(h.kvReads.length, 0);
  }
});

test("audience inventory bounds and injected account or endpoint reject before Graph access", async () => {
  for (const audience_inventory of [
    { kind: "members" },
    { kind: "saved", limit: 0 },
    { kind: "custom", limit: 101 },
    { kind: "saved", limit: 1.5 },
    { kind: "custom", after: "a".repeat(2001) },
    { kind: "saved", account_id: "999999" },
    { kind: "custom", path: "999999/users" },
  ]) {
    const h = await harness();
    await assert.rejects(h.invoke("meta_get_ad_account", { audience_inventory }));
    assert.equal(h.calls.length, 0);
    assert.equal(h.kvWrites.length, 0);
  }
});

test("audience metadata failures remain isolated from the normal account result", async () => {
  for (const kind of ["saved", "custom"]) {
    const h = await harness({
      respond(call) {
        if (call.path.endsWith("/saved_audiences") || call.path.endsWith("/customaudiences")) {
          return { httpStatus: 400, body: { error: { code: 100, message: "Offline audience inventory failure" } } };
        }
      },
    });
    const result = toolPayload(await h.invoke("meta_get_ad_account", { audience_inventory: { kind } }));
    assert.equal(result.account.id, `act_${ACCOUNT}`);
    assert.equal(result.connector_version, "2.3.11");
    assert.equal(result.audience_inventory.kind, kind);
    assert.match(result.audience_inventory.diagnostic_error, /Offline audience inventory failure/);
    assert.equal(Object.hasOwn(result.audience_inventory, "audiences"), false);
    assert.equal(postCalls(h).length, 0);
    assert.equal(h.kvWrites.length, 0);
  }
});

test("ad inventory exposes creative and delivery diagnostic fields through owned read-only edges", async () => {
  const ads = [{
    id: "900007", name: "Offline auditable ad", adset_id: ADSET, campaign_id: CAMPAIGN,
    status: "PAUSED", effective_status: "PAUSED",
    issues_info: [{ error_code: 123, error_message: "Offline delivery issue", level: "AD" }],
    ad_review_feedback: { global: { "1": "Offline editorial feedback" } },
    failed_delivery_checks: [{ check_name: "OFFLINE_CHECK", summary: "Offline delivery check failed" }],
    creative: {
      id: "900008", name: "Offline creative", image_hash: "offline-image-hash",
      thumbnail_url: "https://images.example/thumbnail.jpg",
      object_story_spec: {
        page_id: PAGE,
        link_data: {
          image_hash: "offline-image-hash", link: `https://wa.me/${PHONE}`,
          call_to_action: { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP", link: `https://wa.me/${PHONE}` } },
        },
      },
    },
  }];
  for (const [scope, parentId] of [[{ adset_id: ADSET }, ADSET], [{ campaign_id: CAMPAIGN }, CAMPAIGN], [{}, `act_${ACCOUNT}`]]) {
    const h = await harness({
      respond(call) {
        if (call.path === `${parentId}/ads`) return {
          data: ads,
          paging: { cursors: { before: "offline-before", after: "offline-after" }, next: "https://graph.facebook.com/private-pagination-url" },
        };
      },
    });
    const result = toolPayload(await h.invoke("meta_list_ads", { ...scope, after: "cursor-in", limit: 7 }));
    assert.deepEqual(result.ads, ads);
    assert.deepEqual(result.paging, { before: "offline-before", after: "offline-after" });
    const adsRead = h.calls.at(-1);
    assert.equal(adsRead.method, "GET");
    assert.equal(adsRead.path, `${parentId}/ads`);
    assert.equal(adsRead.params.fields, "id,name,adset_id,campaign_id,status,effective_status,issues_info,ad_review_feedback,failed_delivery_checks,creative{id,name,object_story_spec,image_hash,thumbnail_url},created_time,updated_time");
    assert.equal(adsRead.params.after, "cursor-in");
    assert.equal(adsRead.params.limit, "7");
    assert.equal(h.calls.length, Object.keys(scope).length ? 2 : 1);
    if (Object.keys(scope).length) assert.equal(h.calls[0].path, parentId);
    assert.equal(postCalls(h).length, 0);
    assert.equal(h.kvReads.length, 0);
    assert.equal(h.kvWrites.length, 0);
  }
  const wrongOwner = await harness({ adset: { ...adsetFixture, account_id: "999999" } });
  const rejected = await wrongOwner.invoke("meta_list_ads", { adset_id: ADSET });
  assert.equal(rejected.isError, true);
  assert.equal(wrongOwner.calls.length, 1);
  assert.equal(wrongOwner.calls[0].path, ADSET);
  assert.equal(postCalls(wrongOwner).length, 0);
});

test("ad delivery diagnostic read surfaces field errors without silently retrying a reduced inventory", async () => {
  const h = await harness({ respond(call) {
    if (call.path === `act_${ACCOUNT}/ads`) return {
      httpStatus: 400,
      body: { error: { code: 100, message: "Offline diagnostic field unavailable: issues_info" } },
    };
  } });
  const result = await h.invoke("meta_list_ads");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /diagnostic field unavailable: issues_info/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "GET");
  assert.equal(postCalls(h).length, 0);
  assert.equal(h.lockCalls.length, 0);
});

const scheduleWindow = { days: [0, 1, 2, 3, 4, 5, 6], start_minute: 480, end_minute: 1380, timezone_type: "ADVERTISER" };
const scheduledInput = (overrides = {}) => adsetInput({
  lifetime_budget_minor: 40000,
  start_time: "2026-09-07T08:00:00-02:00",
  end_time: "2026-09-14T08:00:00-02:00",
  adset_schedule: [scheduleWindow], ...overrides,
});
for (const goal of ["LINK_CLICKS", "CONVERSATIONS"]) {
  for (const validateOnly of [true, false]) {
    test(`explicit WhatsApp ${goal} ${validateOnly ? "validation" : "creation"} preserves medical targeting, schedule, phone, budget and pause`, async () => {
      const h = await harness({ respond(call) {
        if (call.method === "POST" && call.path === `act_${ACCOUNT}/adsets`) {
          return validateOnly ? { success: true } : { id: ADSET };
        }
      } });
      const input = scheduledInput({
        destination_type: "WHATSAPP", optimization_goal: goal,
        targeting: {
          age_min: 26, age_max: 54,
          geo_locations: { cities: [{ key: "249674" }] },
          excluded_geo_locations: { countries: ["AR"], regions: [{ key: "452" }, { key: "456" }] },
          flexible_spec: [{ work_positions: [{ id: "125395097503911" }, { id: "138787906146791" }] }],
          targeting_automation: { advantage_audience: 0 },
        },
        validate_only: validateOnly,
        confirmation_phrase: `CREATE ADSET ${CAMPAIGN} ${ADSET_NAME}`,
      });
      const inputSnapshot = JSON.stringify(input);
      const result = toolPayload(await h.invoke("meta_create_adset_draft", input));
      const posts = postCalls(h);
      assert.equal(posts.length, 1);
      const { params } = posts[0];
      assert.equal(params.destination_type, "WHATSAPP");
      assert.equal(params.optimization_goal, goal);
      assert.equal(params.status, "PAUSED");
      assert.deepEqual(params.promoted_object, input.promoted_object);
      assert.deepEqual(params.targeting, input.targeting);
      assert.deepEqual(params.adset_schedule, input.adset_schedule);
      assert.deepEqual(params.pacing_type, ["day_parting"]);
      assert.equal(params.start_time, input.start_time);
      assert.equal(params.end_time, input.end_time);
      assert.equal(params.lifetime_budget, "40000");
      assert.equal(JSON.stringify(input), inputSnapshot);
      if (validateOnly) {
        assert.equal(result.resolved_destination_type, params.destination_type);
        assert.equal(result.resolved_optimization_goal, params.optimization_goal);
        assert.equal(result.status_for_create, "PAUSED");
        assert.deepEqual(params.execution_options, ["validate_only", "include_recommendations"]);
        assert.equal(h.kvWrites.length, 0);
        assert.equal(h.auditEvents.length, 0);
      } else {
        assert.equal(result.result.id, ADSET);
        assert.equal(result.idempotent_replay, false);
        assert.equal(Object.hasOwn(params, "execution_options"), false);
        assert.equal(h.kvWrites.length, 1);
        assert.equal(h.auditEvents.length, 1);
      }
    });
  }
}
test("explicit WhatsApp LINK_CLICKS still requires confirmation before creation", async () => {
  const h = await harness();
  const result = await h.invoke("meta_create_adset_draft", scheduledInput({
    destination_type: "WHATSAPP", optimization_goal: "LINK_CLICKS", validate_only: false,
  }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Confirmation mismatch/);
  assert.equal(postCalls(h).length, 0);
  assert.equal(h.kvWrites.length, 0);
});
for (const goal of ["POST_ENGAGEMENT", "REACH"]) {
  test(`ON_POST ${goal} remains independent of WhatsApp routing`, async () => {
    const h = await harness();
    const input = scheduledInput({
      destination_type: "ON_POST", optimization_goal: goal,
      promoted_object: { page_id: PAGE },
    });
    const result = toolPayload(await h.invoke("meta_create_adset_draft", input));
    const { params } = postCalls(h)[0];
    assert.equal(params.destination_type, "ON_POST");
    assert.equal(params.optimization_goal, goal);
    assert.deepEqual(params.promoted_object, { page_id: PAGE });
    assert.deepEqual(params.targeting, input.targeting);
    assert.deepEqual(params.adset_schedule, input.adset_schedule);
    assert.equal(params.lifetime_budget, "40000");
    assert.equal(params.status, "PAUSED");
    assert.equal(result.resolved_destination_type, params.destination_type);
    assert.equal(result.resolved_optimization_goal, params.optimization_goal);
    assert.equal(h.kvWrites.length, 0);
  });
}
for (const [label, overrides, pattern] of [
  ["selected WhatsApp phone", {}, /conflicts/],
  ["conversations goal", {
    promoted_object: { page_id: PAGE }, optimization_goal: "CONVERSATIONS",
  }, /requires optimization_goal POST_ENGAGEMENT or REACH/],
  ["link-click goal", {
    promoted_object: { page_id: PAGE }, optimization_goal: "LINK_CLICKS",
  }, /requires optimization_goal POST_ENGAGEMENT or REACH/],
]) test(`ON_POST rejects ${label} before any Graph request`, async () => {
  const h = await harness();
  const result = await h.invoke("meta_create_adset_draft", adsetInput({
    destination_type: "ON_POST", optimization_goal: "POST_ENGAGEMENT", ...overrides,
  }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, pattern);
  assert.equal(h.calls.length, 0);
  assert.equal(h.kvWrites.length, 0);
});
test("scheduled WhatsApp validation sends account-timezone windows and preserves phone", async () => {
  const h = await harness();
  const result = await h.invoke("meta_create_adset_draft", scheduledInput());
  assert.ok(!result.isError);
  const post = h.calls.find((c) => c.method === "POST");
  assert.deepEqual(post.params.adset_schedule, [scheduleWindow]);
  assert.deepEqual(post.params.pacing_type, ["day_parting"]);
  assert.equal(post.params.promoted_object.whatsapp_phone_number, PHONE);
  assert.equal(post.params.optimization_goal, "CONVERSATIONS");
  assert.equal(post.params.status, "PAUSED");
  assert.equal(post.params.lifetime_budget, "40000");
  assert.ok(post.params.execution_options.includes("validate_only"));
  assert.equal(h.kvWrites.length, 0);
});
for (const [label, overrides] of [
  ["daily budget", {daily_budget_minor: 2000}],
  ["missing lifetime", {lifetime_budget_minor: undefined}],
  ["missing end", {end_time: undefined}],
  ["missing zone", {start_time: "2026-09-07T08:00:00"}],
  ["reversed dates", {end_time: "2026-09-06T08:00:00-02:00"}],
]) test(`scheduled creation rejects ${label} before POST`, async () => {
  const h = await harness();
  const result = await h.invoke("meta_create_adset_draft", scheduledInput(overrides));
  assert.equal(result.isError, true);
  assert.equal(h.calls.filter((c) => c.method === "POST").length, 0);
});
test("scheduled creation rejects campaign budget before POST", async () => {
  const h = await harness({campaign: {...campaignFixture, lifetime_budget: "40000"}});
  const result = await h.invoke("meta_create_adset_draft", scheduledInput());
  assert.equal(result.isError, true);
  assert.equal(h.calls.filter((c) => c.method === "POST").length, 0);
});
for (const window of [
  {...scheduleWindow, days: [7]}, {...scheduleWindow, start_minute: 481},
  {...scheduleWindow, start_minute: 510}, {...scheduleWindow, end_minute: 1350},
  {...scheduleWindow, start_minute: 480, end_minute: 510},
  {...scheduleWindow, end_minute: 480}, {...scheduleWindow, timezone_type: "USER"},
]) test(`invalid schedule ${JSON.stringify(window)} is rejected`, async () => {
  const h = await harness();
  await assert.rejects(h.invoke("meta_create_adset_draft", scheduledInput({adset_schedule: [window]})));
  assert.equal(h.calls.length, 0);
});
test("overlapping windows are rejected", async () => {
  const h = await harness();
  await assert.rejects(h.invoke("meta_create_adset_draft", scheduledInput({adset_schedule: [scheduleWindow, scheduleWindow]})));
  assert.equal(h.calls.length, 0);
});
test("unscheduled flow does not gain pacing fields", async () => {
  const h = await harness();
  await h.invoke("meta_create_adset_draft", adsetInput());
  const post = h.calls.find((c) => c.method === "POST");
  assert.equal(post.params.adset_schedule, undefined);
  assert.equal(post.params.pacing_type, undefined);
});

for (const [label, budget] of [
  ["ad-set budgets", {}],
  ["campaign daily budget", { daily_budget_minor: 2000 }],
  ["campaign lifetime budget", { lifetime_budget_minor: 40000 }],
]) for (const validateOnly of [true, false]) {
  test(`${label} campaign ${validateOnly ? "validation" : "creation"} preserves budget ownership and PAUSED status`, async () => {
    const h = await harness({ respond(call) {
      if (call.method === "POST" && call.path === `act_${ACCOUNT}/campaigns`) {
        return validateOnly ? { success: true } : { id: CAMPAIGN };
      }
    } });
    const result = toolPayload(await h.invoke("meta_create_campaign_draft", {
      name: CAMPAIGN_NAME,
      objective: "OUTCOME_ENGAGEMENT",
      request_id: REQUEST_ID,
      validate_only: validateOnly,
      confirmation_phrase: `CREATE CAMPAIGN ${CAMPAIGN_NAME}`,
      ...budget,
    }));
    const posts = postCalls(h);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, `act_${ACCOUNT}/campaigns`);
    const params = posts[0].params;
    assert.equal(params.status, "PAUSED");
    if (Object.keys(budget).length === 0) {
      assert.equal(params.is_adset_budget_sharing_enabled, "false");
      assert.equal(Object.hasOwn(params, "daily_budget"), false);
      assert.equal(Object.hasOwn(params, "lifetime_budget"), false);
    } else {
      assert.equal(Object.hasOwn(params, "is_adset_budget_sharing_enabled"), false);
      if (budget.daily_budget_minor) assert.equal(params.daily_budget, "2000");
      if (budget.lifetime_budget_minor) assert.equal(params.lifetime_budget, "40000");
    }
    if (validateOnly) {
      assert.equal(result.mode, "validate_only");
      assert.deepEqual(params.execution_options, ["validate_only", "include_recommendations"]);
      assert.equal(h.kvWrites.length, 0);
    } else {
      assert.equal(result.result.id, CAMPAIGN);
      assert.equal(result.idempotent_replay, false);
      assert.equal(Object.hasOwn(params, "execution_options"), false);
      assert.equal(h.kvWrites.length, 1);
    }
  });
}

for (const include of [false, true]) {
  test(`ad-set targeting expansion diagnostics are opt-in (${include}) and read-only`, async () => {
    const h = await harness({ respond(call) {
      if (call.method === "GET" && call.path === `act_${ACCOUNT}/adsets`) {
        assert.equal(call.params.fields.includes("targeting_optimization_types"), include);
        return { data: [{ id: ADSET, ...(include ? { targeting_optimization_types: [{ detailed_targeting: 0 }] } : {}) }] };
      }
    } });
    const result = toolPayload(await h.invoke("meta_list_adsets", include ? { include_targeting_diagnostics: true } : {}));
    assert.equal(result.adsets[0].id, ADSET);
    assert.equal(Object.hasOwn(result.adsets[0], "targeting_optimization_types"), include);
    if (include) assert.deepEqual(result.adsets[0].targeting_optimization_types, [{ detailed_targeting: 0 }]);
    assert.equal(postCalls(h).length, 0);
    assert.equal(h.kvWrites.length, 0);
  });
}

// These status tests share the real lock, persisted storage, and API gate across
// independently constructed MCP handlers. The old always-acquire stub cannot
// detect either transport-session leaks or same-session reentrancy.
function statusTestClock() {
  let now = Date.parse("2026-09-12T12:00:00.000Z");
  return {
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    advance(ms) { now += ms; },
    setTimeout(callback, ms) {
      now += ms;
      queueMicrotask(callback);
      return 0;
    },
  };
}

function sharedStatusRuntime() {
  const values = new Map();
  const storageWrites = [];
  let queue = Promise.resolve();
  return {
    calls: [], fetchSignals: [], lockCalls: [], values, storageWrites,
    state: {
      blockConcurrencyWhile(callback) {
        const result = queue.then(callback, callback);
        queue = result.then(() => undefined, () => undefined);
        return result;
      },
      storage: {
        async get(key) { return structuredClone(values.get(key)); },
        async put(key, value) {
          if (typeof key === "object") {
            for (const [entryKey, entryValue] of Object.entries(key)) {
              storageWrites.push({ action: "put", key: entryKey, value: structuredClone(entryValue) });
              values.set(entryKey, structuredClone(entryValue));
            }
            return;
          }
          storageWrites.push({ action: "put", key, value: structuredClone(value) });
          values.set(key, structuredClone(value));
        },
        async delete(key) {
          storageWrites.push({ action: "delete", key });
          return values.delete(key);
        },
      },
    },
  };
}

function statusInput(status = "ACTIVE", overrides = {}) {
  return {
    confirmation_phrase: `SET CAMPAIGN ${CAMPAIGN} ${status}`,
    expected_name: CAMPAIGN_NAME,
    object_id: CAMPAIGN,
    object_type: "CAMPAIGN",
    status,
    ...overrides,
  };
}

function statusDeferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function statusPair(options = {}) {
  const runtime = sharedStatusRuntime();
  const clock = statusTestClock();
  const state = { value: {
    ...campaignFixture,
    daily_budget: "2000",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    start_time: "2026-09-05T18:22:58-0200",
  } };
  const initial = structuredClone(state.value);
  const setup = {
    sharedRuntime: runtime, clock, useGate: true,
    writeLockRespond: options.writeLockRespond,
    async respond(call) {
      const override = options.respond && await options.respond(call, state, runtime, clock);
      if (override !== undefined) return override;
      if (call.path === CAMPAIGN && call.method === "GET") return state.value;
      if (call.path === CAMPAIGN && call.method === "POST") {
        assert.deepEqual(Object.keys(call.params), ["status"], "delivery changes must not send budget or targeting fields");
        state.value = { ...state.value, status: call.params.status, effective_status: call.params.status };
        return { success: true };
      }
    },
  };
  const first = await harness({ ...setup, sessionId: "streamable-http:transport-a" });
  const second = await harness({ ...setup, sessionId: options.sameSession ? "streamable-http:transport-a" : "streamable-http:transport-b" });
  return { first, second, runtime, clock, state, initial };
}

async function directStatusLock(runtime, payload) {
  const response = await runtime.lock.fetch(new Request("https://meta-write-lock.internal/lease", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }));
  return { status: response.status, body: await response.json() };
}

function assertStatusLeaseRetained(runtime, clock) {
  const lease = runtime.values.get("lease");
  assert.ok(lease, "uncertain writes must retain the account lease");
  assert.match(lease.holder, /^operation:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.ok(Date.parse(lease.expires_at) > clock.Date.now());
  assert.equal(runtime.lockCalls.filter(c => c.payload.action === "release_owned").length, 0);
}

test("status mutex releases a verified operation so a different transport can write immediately", async () => {
  const p = await statusPair();
  const first = toolPayload(await p.first.invoke("meta_set_delivery_status", statusInput()));
  assert.equal(first.after.status, "ACTIVE");
  assert.equal(p.runtime.values.has("lease"), false);
  const second = toolPayload(await p.second.invoke("meta_set_delivery_status", statusInput("PAUSED")));
  assert.equal(second.after.status, "PAUSED");
  assert.equal(p.runtime.values.has("lease"), false);
  assert.deepEqual(p.state.value, p.initial, "both changes preserve the complete unrelated campaign configuration");
  assert.deepEqual(p.runtime.calls.map(c => c.method), ["GET", "POST", "GET", "GET", "POST", "GET"]);
  for (let i = 0; i < p.runtime.calls.length; i++) {
    assert.equal(p.runtime.fetchSignals[i] instanceof AbortSignal, p.runtime.calls[i].method === "POST",
      "only the fenced status POST has the bounded request lifetime");
  }
  const acquisitions = p.runtime.lockCalls.filter(c => c.payload.action === "acquire");
  assert.equal(acquisitions.length, 2);
  assert.notEqual(acquisitions[0].payload.holder, acquisitions[1].payload.holder);
  for (const { payload } of acquisitions) assert.match(payload.holder, /^operation:[0-9a-f-]{36}$/i);
  assert.deepEqual(p.runtime.lockCalls.map(c => c.payload.action), [
    "acquire", "assert_owner", "release_owned", "acquire", "assert_owner", "release_owned",
  ]);
  assert.ok(p.clock.Date.now() - Date.parse("2026-09-12T12:00:00.000Z") < 600000);
});

for (const sameSession of [false, true]) test(`status mutex excludes overlapping handlers before first Graph read (same transport=${sameSession})`, async () => {
  const entered = statusDeferred();
  const finish = statusDeferred();
  let reads = 0;
  const p = await statusPair({ sameSession, async respond(call) {
    if (call.path === CAMPAIGN && call.method === "GET" && ++reads === 1) {
      entered.resolve();
      await finish.promise;
    }
  } });
  const first = p.first.invoke("meta_set_delivery_status", statusInput());
  await entered.promise;
  const second = await p.second.invoke("meta_set_delivery_status", statusInput());
  assert.equal(second.isError, true);
  assert.match(second.content[0].text, /WRITE_LOCKED/);
  assert.deepEqual(p.runtime.calls.map(c => c.method), ["GET"], "competing operation cannot start an unprotected read");
  finish.resolve();
  const completed = toolPayload(await first);
  assert.equal(completed.after.status, "ACTIVE");
  assert.equal(postCalls(p.first).length, 1);
  assert.equal(p.runtime.values.has("lease"), false);
});

test("status mutex remains exclusive until readback completes", async () => {
  const entered = statusDeferred();
  const finish = statusDeferred();
  let reads = 0;
  const p = await statusPair({ async respond(call) {
    if (call.path === CAMPAIGN && call.method === "GET" && ++reads === 2) {
      entered.resolve();
      await finish.promise;
    }
  } });
  const first = p.first.invoke("meta_set_delivery_status", statusInput());
  await entered.promise;
  const second = await p.second.invoke("meta_set_delivery_status", statusInput("PAUSED"));
  assert.equal(second.isError, true);
  assert.match(second.content[0].text, /WRITE_LOCKED/);
  assert.equal(postCalls(p.first).length, 1);
  finish.resolve();
  assert.equal(toolPayload(await first).after.status, "ACTIVE");
  assert.equal(p.runtime.values.has("lease"), false);
});

test("status mutex cannot replace a live legacy session lease, even from that transport", async () => {
  const p = await statusPair();
  const acquired = await directStatusLock(p.runtime, {
    action: "acquire", holder: "streamable-http:transport-a", operation: "legacy package", ttl_ms: 600000,
  });
  assert.equal(acquired.status, 200);
  const lease = structuredClone(p.runtime.values.get("lease"));
  const result = await p.first.invoke("meta_set_delivery_status", statusInput());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /WRITE_LOCKED/);
  assert.deepEqual(p.runtime.values.get("lease"), lease);
  assert.equal(p.runtime.calls.length, 0);
});

test("status mutex no-op uses the configured status, sends zero POSTs, and releases its lease", async () => {
  const p = await statusPair();
  p.state.value.effective_status = "PENDING_REVIEW";
  const result = toolPayload(await p.first.invoke("meta_set_delivery_status", statusInput("PAUSED")));
  assert.equal(result.no_op, true);
  assert.equal(result.after.status, "PAUSED");
  assert.equal(result.after.effective_status, "PENDING_REVIEW");
  assert.equal(postCalls(p.first).length, 0);
  assert.equal(p.runtime.values.has("lease"), false);
  assert.deepEqual(p.runtime.lockCalls.map(c => c.payload.action), ["acquire", "release_owned"]);
});

test("status mutex checks the exact confirmation before acquiring a lease or calling Graph", async () => {
  const p = await statusPair();
  const result = await p.first.invoke("meta_set_delivery_status", statusInput("ACTIVE", { confirmation_phrase: "SET CAMPAIGN WRONG ACTIVE" }));
  assert.equal(result.isError, true);
  assert.equal(p.runtime.lockCalls.length, 0);
  assert.equal(p.runtime.calls.length, 0);
});

for (const [label, alter] of [
  ["wrong account", value => ({ ...value, account_id: "999999" })],
  ["wrong ID", value => ({ ...value, id: "999999" })],
  ["stale name", value => ({ ...value, name: "Externally renamed" })],
  ["invalid object response", () => ({ id: CAMPAIGN })],
  ["archived object", value => ({ ...value, status: "ARCHIVED" })],
  ["read transport failure", () => { throw new Error("Offline GET network failure"); }],
]) test(`status mutex releases on a pre-POST ${label}`, async () => {
  const p = await statusPair({ respond(call, state) {
    if (call.path === CAMPAIGN && call.method === "GET") return alter(state.value);
  } });
  const result = await p.first.invoke("meta_set_delivery_status", statusInput());
  assert.equal(result.isError, true);
  assert.equal(postCalls(p.first).length, 0);
  assert.equal(p.runtime.values.has("lease"), false);
  assert.deepEqual(p.runtime.lockCalls.map(c => c.payload.action), ["acquire", "release_owned"]);
});

for (const [label, response] of [
  ["POST timeout", () => { throw new Error("Offline POST timeout"); }],
  ["non-JSON POST", () => ({ rawBody: "malformed upstream body" })],
  ["empty POST object", () => ({})],
  ["explicit POST failure", () => ({ success: false })],
  ["explicit failure with matching ID", () => ({ success: false, id: CAMPAIGN })],
  ["wrong POST ID", () => ({ id: "999999" })],
]) test(`status mutex retains its lease after ${label} without retrying`, async () => {
  const p = await statusPair({ respond(call) {
    if (call.path === CAMPAIGN && call.method === "POST") return response();
  } });
  const result = await p.first.invoke("meta_set_delivery_status", statusInput());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /WRITE_OUTCOME_UNCERTAIN/);
  assert.equal(postCalls(p.first).length, 1);
  assertStatusLeaseRetained(p.runtime, p.clock);
});

for (const [label, alter] of [
  ["wrong account", value => ({ ...value, account_id: "999999" })],
  ["wrong ID", value => ({ ...value, id: "999999" })],
  ["renamed object", value => ({ ...value, name: "Externally renamed" })],
  ["unchanged status", value => ({ ...value, status: "PAUSED" })],
  ["changed budget", value => ({ ...value, daily_budget: "99999" })],
  ["removed budget field", value => { const changed = { ...value }; delete changed.daily_budget; return changed; }],
  ["missing status", value => { const changed = { ...value }; delete changed.status; return changed; }],
  ["unavailable read", () => { throw new Error("Offline readback unavailable"); }],
]) test(`status mutex retains its lease when readback has ${label}`, async () => {
  let reads = 0;
  const p = await statusPair({ respond(call, state) {
    if (call.path === CAMPAIGN && call.method === "GET" && ++reads === 2) return alter(state.value);
  } });
  const result = await p.first.invoke("meta_set_delivery_status", statusInput());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /WRITE_OUTCOME_UNCERTAIN/);
  assert.equal(postCalls(p.first).length, 1);
  assertStatusLeaseRetained(p.runtime, p.clock);
});

test("status mutex accepts a matching POST ID and verifies configured status independently of review", async () => {
  const p = await statusPair({ respond(call, state) {
    if (call.path === CAMPAIGN && call.method === "POST") {
      state.value = { ...state.value, status: "ACTIVE", effective_status: "PENDING_REVIEW" };
      return { id: CAMPAIGN };
    }
  } });
  const result = toolPayload(await p.first.invoke("meta_set_delivery_status", statusInput()));
  assert.equal(result.after.status, "ACTIVE");
  assert.equal(result.after.effective_status, "PENDING_REVIEW");
  assert.equal(p.runtime.values.has("lease"), false);
});

test("status mutex reports a release warning without hiding a verified successful mutation", async () => {
  const p = await statusPair({ writeLockRespond(call) {
    if (call.payload.action === "release_owned") return { httpStatus: 503, body: { code: "OFFLINE_LOCK_UNAVAILABLE" } };
  } });
  const raw = await p.first.invoke("meta_set_delivery_status", statusInput());
  assert.notEqual(raw.isError, true);
  const result = toolPayload(raw);
  assert.equal(result.after.status, "ACTIVE");
  assert.equal(typeof result.write_lease_release_warning, "string");
  assert.ok(result.write_lease_release_warning.length > 0);
  assert.equal(postCalls(p.first).length, 1);
  assert.ok(p.runtime.values.has("lease"));
});

test("status mutex rejects a POST queued beyond lease expiry immediately before Graph dispatch", async () => {
  const blockerEntered = statusDeferred();
  const unblock = statusDeferred();
  let blocker;
  let reads = 0;
  const p = await statusPair({ async respond(call, state, runtime) {
    if (call.path === CAMPAIGN && call.method === "GET" && ++reads === 1) {
      // Queue a legitimate independent read before the status handler enqueues
      // its POST. It remains in flight until the operation's lease has expired.
      blocker = runtime.gate.fetch(new Request("https://meta-api-gate.internal/call", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "GET", path: `act_${ACCOUNT}`, params: {} }),
      }));
      return state.value;
    }
    if (call.path === `act_${ACCOUNT}`) {
      blockerEntered.resolve();
      await unblock.promise;
    }
  } });
  const pending = p.first.invoke("meta_set_delivery_status", statusInput());
  await blockerEntered.promise;
  p.clock.advance(600001);
  unblock.resolve();
  const result = await pending;
  assert.equal((await blocker).status, 200);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /WRITE_LEASE_EXPIRED/);
  assert.doesNotMatch(result.content[0].text, /WRITE_OUTCOME_UNCERTAIN/);
  assert.equal(postCalls(p.first).length, 0, "an expired owner cannot reach Meta from the gate queue");
  assert.equal(p.runtime.lockCalls.filter(c => c.payload.action === "assert_owner").length, 1);
  assert.equal(p.runtime.lockCalls.filter(c => c.payload.action === "release_owned").length, 1);
  assert.equal(p.runtime.values.has("lease"), false, "proven non-dispatch releases the operation's own expired lease");
  assert.deepEqual(p.state.value, p.initial);
});

test("status mutex releases after a rate-limit cooldown begins between preflight and POST", async () => {
  let cooldownRequest;
  let reads = 0;
  const p = await statusPair({ respond(call, state, runtime) {
    if (call.path === CAMPAIGN && call.method === "GET" && ++reads === 1) {
      cooldownRequest = runtime.gate.fetch(new Request("https://meta-api-gate.internal/call", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "GET", path: `act_${ACCOUNT}`, params: {} }),
      }));
      return state.value;
    }
    if (call.path === `act_${ACCOUNT}`) return {
      httpStatus: 429, headers: { "Retry-After": "60" },
      body: { error: { code: 17, message: "Offline rate limit" } },
    };
  } });
  const result = await p.first.invoke("meta_set_delivery_status", statusInput());
  assert.equal((await cooldownRequest).status, 429);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /RATE_LIMIT_COOLDOWN/);
  assert.doesNotMatch(result.content[0].text, /WRITE_OUTCOME_UNCERTAIN/);
  assert.equal(postCalls(p.first).length, 0);
  assert.equal(p.runtime.values.has("lease"), false);
  assert.deepEqual(p.state.value, p.initial);
  assert.deepEqual(p.runtime.lockCalls.map(c => c.payload.action), ["acquire", "release_owned"]);
});

test("status mutex rejects a near-expiry lease before dispatch and releases it", async () => {
  let reads = 0;
  const p = await statusPair({ respond(call, state, runtime, clock) {
    if (call.path === CAMPAIGN && call.method === "GET" && ++reads === 1) clock.advance(540001);
  } });
  const result = await p.first.invoke("meta_set_delivery_status", statusInput());
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /WRITE_OUTCOME_UNCERTAIN/);
  assert.equal(postCalls(p.first).length, 0);
  assert.equal(p.runtime.values.has("lease"), false);
  assert.deepEqual(p.state.value, p.initial);
  assert.deepEqual(p.runtime.lockCalls.map(c => c.payload.action), ["acquire", "assert_owner", "release_owned"]);
});

test("lease ownership checks are read-only and reject expired or mismatched owners", async () => {
  const p = await statusPair();
  await directStatusLock(p.runtime, { action: "acquire", holder: "operation:owner-a", operation: "offline A", ttl_ms: 600000 });
  const storageWrites = p.runtime.storageWrites.length;
  const liveLease = structuredClone(p.runtime.values.get("lease"));
  const owner = await directStatusLock(p.runtime, { action: "assert_owner", holder: "operation:owner-a" });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.active, true);
  assert.equal(owner.body.holder_matches, true);
  const other = await directStatusLock(p.runtime, { action: "assert_owner", holder: "operation:owner-b" });
  assert.equal(other.status, 409);
  p.clock.advance(600001);
  const expired = await directStatusLock(p.runtime, { action: "assert_owner", holder: "operation:owner-a" });
  assert.equal(expired.status, 409);
  assert.equal(expired.body.code, "WRITE_LEASE_EXPIRED");
  assert.deepEqual(p.runtime.values.get("lease"), liveLease);
  assert.equal(p.runtime.storageWrites.length, storageWrites, "ownership checks cannot renew or remove leases");
  assert.equal(p.runtime.calls.length, 0);
});

for (const successorExpired of [false, true]) test(`expired status owner cannot release a successor lease (successor expired=${successorExpired})`, async () => {
  const p = await statusPair();
  await directStatusLock(p.runtime, { action: "acquire", holder: "operation:owner-a", operation: "offline A", ttl_ms: 600000 });
  p.clock.advance(600001);
  await directStatusLock(p.runtime, { action: "acquire", holder: "operation:owner-b", operation: "offline B", ttl_ms: 600000 });
  if (successorExpired) p.clock.advance(600001);
  const successor = structuredClone(p.runtime.values.get("lease"));
  const writes = p.runtime.storageWrites.length;
  const stale = await directStatusLock(p.runtime, { action: "release_owned", holder: "operation:owner-a" });
  assert.equal(stale.status, 409);
  assert.deepEqual(p.runtime.values.get("lease"), successor);
  assert.equal(p.runtime.storageWrites.length, writes);
});

function geoFixture() {
  const fixture = ageFixture();
  fixture.targeting.geo_locations = { countries: ["BR"], location_types: ["home", "recent", "frequently_in"] };
  fixture.targeting.excluded_geo_locations = { countries: ["AR", "PY", "UY"], regions: [{ key: "460" }] };
  fixture.targeting.targeting_automation = { advantage_audience: 1, individual_setting: { geo: 1, age: 0 }, shared_audiences: 0 };
  return fixture;
}

function geoInput(overrides = {}) {
  return { adset_id: ADSET, expected_name: ADSET_NAME, region_keys: ["452", "456", "459"], ...overrides };
}

function geoRealInput(overrides = {}) {
  return geoInput({
    validate_only: false,
    confirmation_phrase: "UPDATE ADSET GEO " + ADSET + " REGIONS 452,456,459 GEO_EXPANSION 0",
    ...overrides,
  });
}

// Execute the production account gate and durable lock across two transports.
async function geoPair(options = {}) {
  const runtime = sharedStatusRuntime();
  const clock = statusTestClock();
  const state = { value: structuredClone(options.initial ?? geoFixture()) };
  const initial = structuredClone(state.value);
  const setup = {
    sharedRuntime: runtime, clock, useGate: true,
    writeLockRespond: options.writeLockRespond,
    async respond(call) {
      const override = options.respond && await options.respond(call, state, runtime, clock);
      if (override !== undefined) return override;
      if (call.path === ADSET && call.method === "GET") return state.value;
      if (call.path === ADSET && call.method === "POST") {
        if (call.params.execution_options) {
          assert.deepEqual(call.params.execution_options, ["validate_only"]);
          assert.deepEqual(Object.keys(call.params).sort(), ["execution_options", "targeting"]);
        } else {
          assert.deepEqual(Object.keys(call.params), ["targeting"]);
          state.value = { ...state.value, targeting: structuredClone(call.params.targeting) };
          state.value.targeting.geo_locations.regions = state.value.targeting.geo_locations.regions
            .map(({ key }) => ({ key, name: "Display " + key, country: "BR" })).reverse();
        }
        return { success: true };
      }
    },
  };
  const first = await harness({ ...setup, sessionId: "geo-transport-a" });
  const second = await harness({ ...setup, sessionId: "geo-transport-b" });
  return { first, second, runtime, clock, state, initial };
}

function realGeoPosts(runtime) {
  return runtime.calls.filter(c => c.method === "POST" && !c.params.execution_options);
}


for (const retainLegacy of [false, true]) test("geo legacy compatibility omits the removed write field and verifies readback (retained=" + retainLegacy + ")", async () => {
  const initial = geoFixture();
  initial.targeting.targeting_optimization = "none";
  initial.targeting_optimization_types = [{ detailed_targeting: 0, lookalike: 0 }];
  let realWrite = false;
  const p = await geoPair({ initial, respond(call, state) {
    if (call.path === ADSET && call.method === "POST") {
      assert.equal(Object.hasOwn(call.params.targeting, "targeting_optimization"), false,
        "the removed field must not be sent in validation or real update");
      if (!call.params.execution_options) realWrite = true;
    }
    if (call.path === ADSET && call.method === "GET" && realWrite && retainLegacy) {
      state.value.targeting.targeting_optimization = "none";
      return state.value;
    }
  } });
  const result = toolPayload(await p.first.invoke("meta_update_adset_geo", geoRealInput()));
  assert.equal(result.verified, true);
  assert.equal(result.before.targeting.targeting_optimization, "none");
  assert.equal(result.after.targeting.targeting_optimization, retainLegacy ? "none" : undefined);
  assert.deepEqual(result.after.targeting_optimization_types, initial.targeting_optimization_types);
  assert.equal(result.after.targeting.targeting_automation.individual_setting.geo, 0);
  assert.equal(realGeoPosts(p.runtime).length, 1);
  assert.equal(p.runtime.values.has("lease"), false);
});

test("geo legacy compatibility still fails if Meta changes effective detailed expansion", async () => {
  const initial = geoFixture();
  initial.targeting.targeting_optimization = "none";
  initial.targeting_optimization_types = [{ detailed_targeting: 0, lookalike: 0 }];
  let realWrite = false;
  const p = await geoPair({ initial, respond(call, state) {
    if (call.path === ADSET && call.method === "POST" && !call.params.execution_options) realWrite = true;
    if (call.path === ADSET && call.method === "GET" && realWrite) {
      state.value.targeting_optimization_types = [{ detailed_targeting: 1, lookalike: 0 }];
      return state.value;
    }
  } });
  const result = await p.first.invoke("meta_update_adset_geo", geoRealInput());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /WRITE_OUTCOME_UNCERTAIN.*targeting_optimization_types/);
  assert.equal(realGeoPosts(p.runtime).length, 1);
  assertStatusLeaseRetained(p.runtime, p.clock);
});

test("geo legacy compatibility rejects other legacy values before any POST", async () => {
  const initial = geoFixture();
  initial.targeting.targeting_optimization = "expansion_all";
  const p = await geoPair({ initial });
  const result = await p.first.invoke("meta_update_adset_geo", geoRealInput());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unsupported legacy targeting_optimization/);
  assert.equal(p.runtime.calls.filter(c => c.method === "POST").length, 0);
  assert.equal(p.runtime.values.has("lease"), false);
});


test("geo restriction previews the exact change and leaves the complete ad set unchanged", async () => {
  const p = await geoPair();
  const result = toolPayload(await p.first.invoke("meta_update_adset_geo", geoInput()));
  assert.equal(result.mode, "validate_only");
  assert.equal(result.verified_unchanged, true);
  assert.equal(result.required_confirmation, geoRealInput().confirmation_phrase);
  assert.deepEqual(p.state.value, p.initial);
  const proposed = structuredClone(p.initial);
  proposed.targeting.geo_locations = { regions: [{ key: "452" }, { key: "456" }, { key: "459" }], location_types: ["home", "recent", "frequently_in"] };
  proposed.targeting.targeting_automation.individual_setting.geo = 0;
  assert.deepEqual(result.proposed, proposed);
  assert.equal(realGeoPosts(p.runtime).length, 0);
  assert.equal(p.runtime.values.has("lease"), false);
});

for (const automationPresent of [true, false]) test("geo restriction preserves all other settings and verifies Graph region enrichment (automation=" + automationPresent + ")", async () => {
  const initial = geoFixture();
  if (!automationPresent) {
    delete initial.targeting.targeting_automation;
    initial.targeting.age_min = 18;
    initial.targeting.age_max = 65;
    delete initial.targeting.flexible_spec;
    initial.destination_type = "WEBSITE";
    initial.optimization_goal = "OFFSITE_CONVERSIONS";
    initial.effective_status = "CAMPAIGN_PAUSED";
  }
  const p = await geoPair({ initial });
  const result = toolPayload(await p.first.invoke("meta_update_adset_geo", geoRealInput({ region_keys: ["459", "452", "456"] })));
  assert.equal(result.mode, "updated");
  assert.equal(result.verified, true);
  assert.equal(result.after.status, p.initial.status);
  const post = realGeoPosts(p.runtime)[0];
  const expected = structuredClone(initial.targeting);
  expected.geo_locations = { regions: [{ key: "452" }, { key: "456" }, { key: "459" }], location_types: ["home", "recent", "frequently_in"] };
  expected.targeting_automation = automationPresent
    ? { advantage_audience: 1, individual_setting: { geo: 0, age: 0 }, shared_audiences: 0 }
    : { individual_setting: { geo: 0 } };
  assert.deepEqual(post.params.targeting, expected);
  assert.equal(realGeoPosts(p.runtime).length, 1);
  assert.equal(p.runtime.values.has("lease"), false);
  assert.ok(p.runtime.fetchSignals.filter(Boolean).length >= 2);
  const repeated = toolPayload(await p.second.invoke("meta_update_adset_geo", geoRealInput()));
  assert.equal(repeated.mode, "no_change");
  assert.equal(repeated.verified, true);
  assert.equal(realGeoPosts(p.runtime).length, 1);
  assert.equal(p.runtime.values.has("lease"), false);
});

test("geo restriction supports a narrower subset of already included states", async () => {
  const initial = geoFixture();
  initial.targeting.geo_locations = { regions: [{ key: "452", name: "Parana", country: "BR" }, { key: "456", name: "RS", country: "BR" }, { key: "459", name: "SC", country: "BR" }] };
  const p = await geoPair({ initial });
  const result = toolPayload(await p.first.invoke("meta_update_adset_geo", geoRealInput({
    region_keys: ["459"], confirmation_phrase: "UPDATE ADSET GEO " + ADSET + " REGIONS 459 GEO_EXPANSION 0",
  })));
  assert.equal(result.verified, true);
  assert.deepEqual(realGeoPosts(p.runtime)[0].params.targeting.geo_locations, { regions: [{ key: "459" }] });
});

for (const [label, geo] of [
  ["city coverage", { cities: [{ key: "100" }] }],
  ["radius coverage", { custom_locations: [{ latitude: -26, longitude: -49, radius: 80 }] }],
  ["mixed country/regions", { countries: ["BR"], regions: [{ key: "459" }] }],
  ["additional country", { countries: ["BR", "AR"] }],
  ["foreign country", { countries: ["AR"] }],
  ["country group", { country_groups: ["worldwide"] }],
  ["state expansion", { regions: [{ key: "459" }] }],
]) test("geo restriction rejects " + label + " before any POST", async () => {
  const initial = geoFixture();
  initial.targeting.geo_locations = geo;
  const p = await geoPair({ initial });
  const result = await p.first.invoke("meta_update_adset_geo", geoRealInput());
  assert.equal(result.isError, true);
  assert.equal(p.runtime.calls.filter(c => c.method === "POST").length, 0);
  assert.equal(p.runtime.values.has("lease"), false);
  assert.deepEqual(p.state.value, p.initial);
});

for (const region_keys of [[], ["460"], ["452", "452"]]) test("geo restriction rejects invalid region input " + JSON.stringify(region_keys), async () => {
  const p = await geoPair();
  await assert.rejects(p.first.invoke("meta_update_adset_geo", geoInput({ region_keys })));
  assert.equal(p.runtime.calls.length, 0);
  assert.equal(p.runtime.lockCalls.length, 0);
});

test("geo restriction rejects stale identity/name/status and incomplete geography before validation", async () => {
  for (const override of [{ id: "999999" }, { account_id: "999999" }, { name: "Stale name" }, { status: "ARCHIVED" }, { targeting: {} }]) {
    const p = await geoPair({ initial: { ...geoFixture(), ...override } });
    const result = await p.first.invoke("meta_update_adset_geo", geoRealInput());
    assert.equal(result.isError, true);
    assert.equal(p.runtime.calls.filter(c => c.method === "POST").length, 0);
    assert.equal(p.runtime.values.has("lease"), false);
  }
});

test("geo restriction validates exact confirmation before reads or locks", async () => {
  const p = await geoPair();
  const result = await p.first.invoke("meta_update_adset_geo", geoRealInput({ confirmation_phrase: "incorrect" }));
  assert.equal(result.isError, true);
  assert.equal(p.runtime.calls.length, 0);
  assert.equal(p.runtime.lockCalls.length, 0);
});

test("geo restriction honors the write switch and fails before reads", async () => {
  const h = await harness({ env: { META_WRITE_ENABLED: "false" } });
  const result = await h.invoke("meta_update_adset_geo", geoInput());
  assert.equal(result.isError, true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.lockCalls.length, 0);
});

test("geo restriction stops on failed Meta validation without a real update", async () => {
  const p = await geoPair({ respond(call) {
    if (call.method === "POST") return { success: false };
  } });
  const result = await p.first.invoke("meta_update_adset_geo", geoRealInput());
  assert.equal(result.isError, true);
  assert.equal(realGeoPosts(p.runtime).length, 0);
  assert.deepEqual(p.state.value, p.initial);
  assert.equal(p.runtime.values.has("lease"), false);
});

test("geo restriction detects concurrent targeting changes after validation without a real update", async () => {
  let reads = 0;
  const p = await geoPair({ respond(call, state) {
    if (call.path === ADSET && call.method === "GET" && ++reads === 2) {
      state.value.targeting.age_max = 61;
      return state.value;
    }
  } });
  const result = await p.first.invoke("meta_update_adset_geo", geoRealInput());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /changed during geography validation/);
  assert.equal(realGeoPosts(p.runtime).length, 0);
  assert.equal(p.runtime.values.has("lease"), false);
});

for (const [label, drift] of [
  ["age", value => { value.targeting.age_max = 65; }],
  ["configured status", value => { value.status = "PAUSED"; }],
  ["budget", value => { value.lifetime_budget = "90000"; }],
  ["geographic expansion", value => { value.targeting.targeting_automation.individual_setting.geo = 1; }],
  ["omitted geographic expansion", value => { delete value.targeting.targeting_automation.individual_setting.geo; }],
  ["excluded geography", value => { delete value.targeting.excluded_geo_locations; }],
  ["extra geographic inclusion", value => { value.targeting.geo_locations.countries = ["BR"]; }],
  ["foreign metadata", value => { value.targeting.geo_locations.regions[0].country = "AR"; }],
]) test("geo restriction fails verification after " + label + " drift without retry or rollback", async () => {
  let posted = false;
  const p = await geoPair({ respond(call, state) {
    if (call.path === ADSET && call.method === "POST" && !call.params.execution_options) {
      state.value.targeting = structuredClone(call.params.targeting);
      posted = true;
      return { success: true };
    }
    if (call.path === ADSET && call.method === "GET" && posted) {
      drift(state.value);
      return state.value;
    }
  } });
  const result = await p.first.invoke("meta_update_adset_geo", geoRealInput());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /WRITE_OUTCOME_UNCERTAIN/);
  assert.equal(realGeoPosts(p.runtime).length, 1);
  assertStatusLeaseRetained(p.runtime, p.clock);
});

test("geo restriction keeps the operation lease after a lost mutation response", async () => {
  const p = await geoPair({ respond(call) {
    if (call.path === ADSET && call.method === "POST" && !call.params.execution_options) throw new Error("Offline connection lost after dispatch");
  } });
  const result = await p.first.invoke("meta_update_adset_geo", geoRealInput());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /WRITE_OUTCOME_UNCERTAIN/);
  assert.equal(realGeoPosts(p.runtime).length, 1);
  assertStatusLeaseRetained(p.runtime, p.clock);
});

test("geo restriction excludes a competing transport throughout validation and mutation", async () => {
  const entered = statusDeferred();
  const resume = statusDeferred();
  let firstValidation = true;
  const p = await geoPair({ async respond(call) {
    if (call.path === ADSET && call.params.execution_options && firstValidation) {
      firstValidation = false;
      entered.resolve();
      await resume.promise;
    }
  } });
  const firstCall = p.first.invoke("meta_update_adset_geo", geoRealInput());
  await entered.promise;
  const competing = await p.second.invoke("meta_update_adset_geo", geoRealInput());
  assert.equal(competing.isError, true);
  assert.match(competing.content[0].text, /WRITE_LOCKED/);
  assert.equal(p.runtime.calls.filter(c => c.method === "GET").length, 1);
  resume.resolve();
  assert.equal(toolPayload(await firstCall).verified, true);
  assert.equal(realGeoPosts(p.runtime).length, 1);
  assert.equal(p.runtime.values.has("lease"), false);
});

test("geo restriction fences an expired operation before dispatching the real POST", async () => {
  let reads = 0;
  const p = await geoPair({ respond(call, _state, _runtime, clock) {
    if (call.path === ADSET && call.method === "GET" && ++reads === 2) clock.advance(600001);
  } });
  const result = await p.first.invoke("meta_update_adset_geo", geoRealInput());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /WRITE_LEASE_EXPIRED/);
  assert.equal(realGeoPosts(p.runtime).length, 0);
  assert.equal(p.runtime.values.has("lease"), false);
});

// The BREVAR profile is tested as a user-visible contract: its eligible audience,
// local delivery hours, immutable commercial settings, and write uncertainty.
function brevarProfileFixture() {
  const value = geoFixture();
  delete value.lifetime_budget;
  delete value.adset_schedule;
  value.pacing_type = ["standard"];
  value.optimization_goal = "CONVERSATIONS";
  value.destination_type = "WHATSAPP";
  value.start_time = "2026-09-04T08:00:00-0200";
  value.end_time = "2026-10-02T23:59:00-0200";
  value.targeting.genders = [2];
  value.targeting.targeting_optimization = "none";
  value.targeting.targeting_relaxation_types = { lookalike: 1, custom_audience: 1 };
  value.targeting.excluded_geo_locations = {
    countries: ["AR", "PY", "UY"],
    regions: [{ key: "456", name: "Rio Grande do Sul", country: "BR" }, { key: "460", name: "Sao Paulo", country: "BR" }],
    location_types: ["home", "recent"],
  };
  value.targeting_optimization_types = [{ key: "detailed_targeting", value: 0 }, { key: "lookalike", value: 0 }];
  return value;
}

function brevarProfileInput(overrides = {}) {
  return { adset_id: ADSET, expected_name: ADSET_NAME, expected_campaign_name: CAMPAIGN_NAME, ...overrides };
}

function brevarProfileRealInput(overrides = {}) {
  const input = brevarProfileInput({ validate_only: false, ...overrides });
  return {
    ...input,
    confirmation_phrase: `CONFIGURE BREVAR ADSET ${ADSET} SOUTH_BR PHYSICIANS_10 AGE 25 50 HOURS 06-23 AMERICA_SAO_PAULO${input.name ? " NAME " + input.name : ""}`,
    ...overrides,
  };
}

async function brevarProfilePair(options = {}) {
  const runtime = sharedStatusRuntime();
  const clock = statusTestClock();
  const state = {
    value: structuredClone(options.initial ?? brevarProfileFixture()),
    campaign: structuredClone(options.campaign ?? { ...campaignFixture, status: "ACTIVE", effective_status: "ACTIVE", lifetime_budget: "70000", bid_strategy: "LOWEST_COST_WITHOUT_CAP", start_time: "2026-09-04T08:00:00-0200", stop_time: "2026-10-02T23:59:00-0200" }),
    account: { id: `act_${ACCOUNT}`, account_id: ACCOUNT, account_status: 1, currency: "BRL", timezone_name: options.timezone ?? "America/Noronha" },
  };
  const initial = structuredClone(state);
  const waits = [];
  const timeline = [];
  const advanceTimeout = clock.setTimeout;
  clock.setTimeout = (callback, ms) => {
    waits.push({ at: clock.Date.now(), ms });
    return advanceTimeout(() => {
      if (ms >= 31000) options.onProfileWait?.(state, runtime, clock);
      callback();
    }, ms);
  };
  const setup = {
    sharedRuntime: runtime, clock, useGate: true,
    async respond(call) {
      timeline.push({ at: clock.Date.now(), method: call.method, path: call.path, validate_only: Boolean(call.params.execution_options) });
      const override = options.respond && await options.respond(call, state, runtime, clock);
      if (override !== undefined) return override;
      if (call.path === ADSET && call.method === "GET") return state.value;
      if (call.path === CAMPAIGN && call.method === "GET") return state.campaign;
      if (call.path === `act_${ACCOUNT}` && call.method === "GET") return state.account;
      if (call.method === "POST") {
        assert.equal(call.path, ADSET, "the profile must never write to its campaign or account");
        const allowed = ["adset_schedule", "targeting"];
        if (Number(state.value.lifetime_budget) > 0) allowed.push("pacing_type");
        if (call.params.name !== undefined) allowed.push("name");
        if (call.params.execution_options !== undefined) {
          allowed.push("execution_options");
          assert.deepEqual(call.params.execution_options, ["validate_only"]);
        }
        assert.deepEqual(Object.keys(call.params).sort(), allowed.sort(), "profile updates cannot write budget, dates, destination, optimization or status");
        assert.equal(Object.hasOwn(call.params.targeting, "targeting_optimization"), false, "removed legacy field must not be sent");
        assert.equal(Object.hasOwn(call.params.targeting, "targeting_optimization_types"), false, "read-only expansion diagnostics cannot be sent as targeting");
        if (!call.params.execution_options) {
          for (const key of allowed) state.value[key] = structuredClone(call.params[key]);
        }
        return { success: true };
      }
    },
  };
  const first = await harness({ ...setup, sessionId: "brevar-profile-a" });
  const second = await harness({ ...setup, sessionId: "brevar-profile-b" });
  return { first, second, state, initial, runtime, clock, waits, timeline };
}

function brevarProfilePosts(runtime) { return runtime.calls.filter(c => c.method === "POST" && c.path === ADSET); }
function brevarProfileRealPosts(runtime) { return brevarProfilePosts(runtime).filter(c => !c.params.execution_options); }

function assertBrevarSchedule(schedule, start, end) {
  assert.ok(Array.isArray(schedule) && schedule.length > 0);
  const actual = new Map();
  for (const window of schedule) {
    assert.equal(window.timezone_type, "ADVERTISER");
    assert.equal(window.start_minute, start);
    assert.equal(window.end_minute, end);
    for (const day of window.days) {
      assert.ok(Number.isInteger(day) && day >= 0 && day <= 6);
      assert.equal(actual.has(day), false, "delivery windows must not overlap on any day");
      actual.set(day, true);
    }
  }
  assert.deepEqual([...actual.keys()].sort(), [0, 1, 2, 3, 4, 5, 6]);
}

test("BREVAR profile defaults to validation and proves the complete ad set and parent unchanged", async () => {
  const p = await brevarProfilePair();
  const result = toolPayload(await p.first.invoke("meta_configure_brevar_adset", brevarProfileInput()));
  assert.equal(result.mode, "validate_only");
  assert.equal(result.verified_unchanged, true);
  assert.equal(result.required_confirmation, brevarProfileRealInput().confirmation_phrase);
  assert.deepEqual(p.state, p.initial);
  assert.equal(brevarProfilePosts(p.runtime).length, 1);
  assert.equal(brevarProfileRealPosts(p.runtime).length, 0);
  assert.equal(p.runtime.values.has("lease"), false);
  for (const path of [ADSET, CAMPAIGN, `act_${ACCOUNT}`]) {
    assert.ok(p.runtime.calls.filter(c => c.method === "GET" && c.path === path).length >= 2, `${path} must be re-read after Meta validation`);
  }
});

for (const timezone of ["America/Noronha", "America/Sao_Paulo"]) test(`BREVAR profile preserves the CBO lifetime cap and maps 06-23 Brasilia to ${timezone}`, async () => {
  const p = await brevarProfilePair({ timezone });
  const result = toolPayload(await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput()));
  assert.equal(result.verified, true);
  assert.equal(result.mode, "updated");
  assert.equal(brevarProfileRealPosts(p.runtime).length, 1);
  const post = brevarProfileRealPosts(p.runtime)[0].params;
  assertBrevarSchedule(post.adset_schedule, timezone === "America/Noronha" ? 420 : 360, timezone === "America/Noronha" ? 1440 : 1380);
  assert.equal(Object.hasOwn(post, "pacing_type"), false, "CBO ad sets must not write campaign-owned pacing");
  assert.deepEqual(p.state.value.pacing_type, p.initial.value.pacing_type);
  assert.equal(result.delivery_schedule_verified, false, "a saved child schedule does not prove the CBO campaign applies day-parting");
  assert.equal(post.targeting.age_min, 25);
  assert.equal(post.targeting.age_max, 50);
  assert.equal(post.targeting.user_age_unknown, false);
  assert.ok(post.targeting.genders === undefined || post.targeting.genders.length === 0 || JSON.stringify(post.targeting.genders.slice().sort()) === "[1,2]", "the audience includes both sexes");
  assert.deepEqual(post.targeting.geo_locations.regions.map(r => String(r.key)).sort(), ["452", "456", "459"]);
  assert.equal(post.targeting.geo_locations.countries, undefined);
  assert.deepEqual(post.targeting.geo_locations.location_types, p.initial.value.targeting.geo_locations.location_types);
  assert.deepEqual(post.targeting.excluded_geo_locations.countries, ["AR", "PY", "UY"]);
  assert.deepEqual(post.targeting.excluded_geo_locations.regions, [{ key: "460", name: "Sao Paulo", country: "BR" }]);
  assert.equal(post.targeting.targeting_automation.advantage_audience, 0);
  assert.equal(post.targeting.targeting_automation.individual_setting.geo, 0);
  assert.equal(post.targeting.targeting_automation.individual_setting.age, 0);
  assert.equal(post.targeting.targeting_relaxation_types.lookalike, 0);
  assert.equal(post.targeting.targeting_relaxation_types.custom_audience, 0);
  assert.equal(post.targeting.flexible_spec.length, 1);
  assert.deepEqual(Object.keys(post.targeting.flexible_spec[0]), ["work_positions"]);
  assert.equal(post.targeting.flexible_spec[0].work_positions.length, 10);
  assert.equal(new Set(post.targeting.flexible_spec[0].work_positions.map(p => p.id)).size, 10);
  assert.deepEqual(post.targeting.flexible_spec[0].work_positions.map(p => p.id).sort(), [
    "125395097503911", "138787906146791", "1423257317968087", "1597521383816555", "359815664202923",
    "588508654618832", "649354901854686", "761820927245398", "896416657056805", "941373515875427",
  ].sort());
  assert.deepEqual(post.targeting.publisher_platforms, p.initial.value.targeting.publisher_platforms);
  for (const field of ["status", "campaign_id", "lifetime_budget", "daily_budget", "optimization_goal", "destination_type", "promoted_object", "start_time", "end_time", "billing_event", "bid_strategy", "bid_amount"]) {
    assert.deepEqual(p.state.value[field], p.initial.value[field], field + " must remain unchanged");
  }
  assert.deepEqual(p.state.campaign, p.initial.campaign);
  assert.equal(p.runtime.values.has("lease"), false);
});

test("BREVAR profile permits existing ABO lifetime budget and an explicitly confirmed rename without changing configured pause", async () => {
  const initial = brevarProfileFixture();
  initial.lifetime_budget = "40000";
  initial.status = "PAUSED";
  initial.effective_status = "PAUSED";
  const campaign = { ...campaignFixture };
  const name = "BREVAR | MEDICOS 25-50 | SUL | 06-23";
  const p = await brevarProfilePair({ initial, campaign });
  const result = toolPayload(await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput({ name })));
  assert.equal(result.verified, true);
  assert.equal(p.state.value.name, name);
  assert.equal(p.state.value.lifetime_budget, "40000");
  assert.equal(p.state.value.status, "PAUSED");
  assert.equal(result.delivery_schedule_verified, true);
  assert.deepEqual(brevarProfileRealPosts(p.runtime)[0].params.pacing_type, ["standard", "day_parting"]);
  assert.deepEqual(p.state.campaign, campaign);
  assert.equal(p.runtime.calls.some(c => c.method === "POST" && c.path !== ADSET), false);
});

for (const [label, amend] of [
  ["daily CBO budget", s => { delete s.campaign.lifetime_budget; s.campaign.daily_budget = "2000"; }],
  ["daily ABO budget", s => { delete s.campaign.lifetime_budget; s.value.daily_budget = "2000"; }],
  ["missing lifetime budget", s => { delete s.campaign.lifetime_budget; }],
  ["competing CBO and ABO lifetime budgets", s => { s.value.lifetime_budget = "40000"; }],
  ["expired end date", s => { s.value.end_time = "2026-09-11T22:00:00-0300"; }],
  ["expired parent end date", s => { s.campaign.stop_time = "2026-09-11T22:00:00-0300"; }],
  ["unsupported account timezone", s => { s.account.timezone_name = "UTC"; }],
  ["different course parent", s => { s.campaign.name = "ATLS isolated campaign"; }],
  ["stale parent name", s => { s.campaign.name = "BREVAR changed campaign"; }],
  ["wrong ad set account", s => { s.value.account_id = "999999"; }],
  ["wrong parent account", s => { s.campaign.account_id = "999999"; }],
  ["archived ad set", s => { s.value.status = "ARCHIVED"; }],
  ["missing detailed expansion proof", s => { s.value.targeting_optimization_types = [{ key: "lookalike", value: 0 }]; }],
  ["lookalike expansion enabled", s => { s.value.targeting_optimization_types = [{ key: "detailed_targeting", value: 0 }, { key: "lookalike", value: 1 }]; }],
  ["Brazil excluded", s => { s.value.targeting.excluded_geo_locations.countries.push("BR"); }],
  ["accelerated ABO pacing", s => { delete s.campaign.lifetime_budget; s.value.lifetime_budget = "40000"; s.value.pacing_type = ["no_pacing"]; }],
]) test("BREVAR profile refuses " + label + " before validation without changing any object", async () => {
  const p = await brevarProfilePair();
  amend(p.state);
  const result = await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput());
  assert.equal(result.isError, true);
  assert.equal(brevarProfilePosts(p.runtime).length, 0);
  assert.equal(p.runtime.values.has("lease"), false);
});

test("BREVAR profile checks the write switch and exact rename confirmation before reads or locking", async () => {
  const h = await harness({ env: { META_WRITE_ENABLED: "false" } });
  const disabled = await h.invoke("meta_configure_brevar_adset", brevarProfileInput());
  assert.equal(disabled.isError, true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.lockCalls.length, 0);
  const p = await brevarProfilePair();
  const mismatch = await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput({ name: "BREVAR renamed", confirmation_phrase: brevarProfileRealInput().confirmation_phrase }));
  assert.equal(mismatch.isError, true);
  assert.equal(p.runtime.calls.length, 0);
  assert.equal(p.runtime.lockCalls.length, 0);
});

test("BREVAR profile reports Instagram native editing restriction 1991005 and stops after one validation", async () => {
  const p = await brevarProfilePair({ respond(call) {
    if (call.method === "POST") return { httpStatus: 400, body: { error: { message: "Editing boosted Instagram posts is only allowed in the Instagram app", code: 10, error_subcode: 1991005, type: "OAuthException" } } };
  } });
  const result = await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /1991005/);
  assert.equal(brevarProfilePosts(p.runtime).length, 1);
  assert.equal(brevarProfileRealPosts(p.runtime).length, 0);
  assert.deepEqual(p.state, p.initial);
  assert.equal(p.runtime.values.has("lease"), false);
});

for (const [label, amend] of [
  ["parent budget", s => { s.campaign.lifetime_budget = "80000"; }],
  ["parent configured status", s => { s.campaign.status = "PAUSED"; }],
  ["ad set targeting", s => { s.value.targeting.age_max = 64; }],
  ["account timezone", s => { s.account.timezone_name = "America/Sao_Paulo"; }],
]) test("BREVAR profile rejects concurrent " + label + " change after validation before its real write", async () => {
  let validated = false;
  const p = await brevarProfilePair({ respond(call, state) {
    if (call.path === ADSET && call.params.execution_options) validated = true;
    if (call.method === "GET" && validated) { amend(state); validated = false; }
  } });
  const result = await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput());
  assert.equal(result.isError, true);
  assert.equal(brevarProfilePosts(p.runtime).length, 1);
  assert.equal(brevarProfileRealPosts(p.runtime).length, 0);
  assert.equal(p.runtime.values.has("lease"), false);
});

for (const [label, drift] of [
  ["age", s => { s.value.targeting.age_max = 65; }],
  ["medical profession", s => { s.value.targeting.flexible_spec[0].work_positions.pop(); }],
  ["geographic expansion", s => { s.value.targeting.targeting_automation.individual_setting.geo = 1; }],
  ["detailed expansion", s => { s.value.targeting_optimization_types = [{ key: "detailed_targeting", value: 1 }, { key: "lookalike", value: 0 }]; }],
  ["missing expansion proof", s => { delete s.value.targeting_optimization_types; }],
  ["daily schedule", s => { s.value.adset_schedule[0].start_minute += 60; }],
  ["configured status", s => { s.value.status = "PAUSED"; }],
  ["parent lifetime budget", s => { s.campaign.lifetime_budget = "80000"; }],
]) test("BREVAR profile retains its lease after post-write " + label + " drift and never retries or rolls back", async () => {
  let posted = false;
  const p = await brevarProfilePair({ respond(call, state) {
    if (call.method === "POST" && call.path === ADSET && !call.params.execution_options) posted = true;
    if (call.method === "GET" && posted) { drift(state); posted = false; }
  } });
  const result = await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /WRITE_OUTCOME_UNCERTAIN/);
  assert.equal(brevarProfileRealPosts(p.runtime).length, 1);
  assertStatusLeaseRetained(p.runtime, p.clock);
});

test("BREVAR profile retains its lease when a real mutation loses its response without repeating the POST", async () => {
  const p = await brevarProfilePair({ respond(call) {
    if (call.path === ADSET && call.method === "POST" && !call.params.execution_options) throw new Error("Offline lost mutation response");
  } });
  const result = await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /WRITE_OUTCOME_UNCERTAIN/);
  assert.equal(brevarProfileRealPosts(p.runtime).length, 1);
  assertStatusLeaseRetained(p.runtime, p.clock);
});

test("BREVAR profile prevents overlapping transports before the competitor can read Graph", async () => {
  const entered = statusDeferred();
  const resume = statusDeferred();
  let first = true;
  const p = await brevarProfilePair({ async respond(call) {
    if (call.path === ADSET && call.params.execution_options && first) {
      first = false;
      entered.resolve();
      await resume.promise;
    }
  } });
  const running = p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput());
  await entered.promise;
  const count = p.runtime.calls.length;
  const competing = await p.second.invoke("meta_configure_brevar_adset", brevarProfileRealInput());
  assert.equal(competing.isError, true);
  assert.match(competing.content[0].text, /WRITE_LOCKED/);
  assert.equal(p.runtime.calls.length, count);
  resume.resolve();
  assert.equal(toolPayload(await running).verified, true);
  assert.equal(brevarProfileRealPosts(p.runtime).length, 1);
  assert.equal(p.runtime.values.has("lease"), false);
});

test("BREVAR profile fences lease expiry after validation before a real Graph POST", async () => {
  let validated = false;
  const p = await brevarProfilePair({ respond(call, _state, _runtime, clock) {
    if (call.path === ADSET && call.params.execution_options) validated = true;
    if (call.method === "GET" && validated) { clock.advance(600001); validated = false; }
  } });
  const result = await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /WRITE_LEASE_EXPIRED/);
  assert.equal(brevarProfileRealPosts(p.runtime).length, 0);
  assert.equal(p.runtime.values.has("lease"), false);
});

test("BREVAR profile replaces old student/interests/age-range targeting with the sole medical job clause", async () => {
  const initial = brevarProfileFixture();
  initial.targeting.age_range = [24, 65];
  initial.targeting.interests = [{ id: "800001", name: "Medicine interest" }];
  initial.targeting.education_majors = [{ id: "800002", name: "Medicine students" }];
  initial.targeting.education_statuses = [1, 2];
  initial.targeting.flexible_spec = [{ interests: [{ id: "800003" }], education_majors: [{ id: "800004" }] }];
  const p = await brevarProfilePair({ initial });
  const result = toolPayload(await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput()));
  assert.equal(result.verified, true);
  const written = brevarProfileRealPosts(p.runtime)[0].params.targeting;
  for (const field of ["age_range", "interests", "education_majors", "education_statuses"]) assert.equal(Object.hasOwn(written, field), false);
  assert.deepEqual(Object.keys(written.flexible_spec[0]), ["work_positions"]);
  assert.equal(written.flexible_spec[0].work_positions.length, 10);
});

test("BREVAR profile accepts equivalent display names, week-window splitting and effective review status, then performs a no-op", async () => {
  let posted = false;
  const p = await brevarProfilePair({ respond(call, state) {
    if (call.path === ADSET && call.method === "POST" && !call.params.execution_options) posted = true;
    if (call.path === ADSET && call.method === "GET" && posted) {
      posted = false;
      state.value.targeting.genders = [0];
      state.value.targeting.geo_locations.regions = state.value.targeting.geo_locations.regions.map(r => ({ ...r, country: "BR", name: "Localized region " + r.key })).reverse();
      state.value.targeting.flexible_spec[0].work_positions = state.value.targeting.flexible_spec[0].work_positions.map(p => ({ ...p, name: "Localized profession " + p.id })).reverse();
      const window = state.value.adset_schedule[0];
      state.value.adset_schedule = window.days.map(day => ({ ...window, days: [day] })).reverse();
      state.value.effective_status = "IN_PROCESS";
      state.campaign.effective_status = "IN_PROCESS";
      return state.value;
    }
  } });
  const result = toolPayload(await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput()));
  assert.equal(result.verified, true);
  assert.equal(result.after.status, "ACTIVE");
  assert.equal(result.after.effective_status, "IN_PROCESS");
  assert.equal(p.runtime.values.has("lease"), false);
  const beforeRepeating = brevarProfilePosts(p.runtime).length;
  const repeated = toolPayload(await p.second.invoke("meta_configure_brevar_adset", brevarProfileRealInput()));
  assert.equal(repeated.mode, "no_change");
  assert.equal(repeated.verified, true);
  assert.equal(brevarProfilePosts(p.runtime).length, beforeRepeating, "an equivalent profile needs no validation or mutation POST");
  assert.equal(p.runtime.values.has("lease"), false);
});

test("BREVAR profile does not introduce an unsupported individual age setting when absent", async () => {
  const initial = brevarProfileFixture();
  delete initial.targeting.targeting_automation.individual_setting.age;
  const p = await brevarProfilePair({ initial });
  const result = toolPayload(await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput()));
  assert.equal(result.verified, true);
  assert.equal(brevarProfileRealPosts(p.runtime).length, 1);
  for (const post of brevarProfilePosts(p.runtime)) {
    assert.equal(Object.hasOwn(post.params.targeting.targeting_automation.individual_setting, "age"), false);
    assert.equal(post.params.targeting.age_min, 25);
    assert.equal(post.params.targeting.age_max, 50);
    assert.equal(post.params.targeting.user_age_unknown, false);
  }
  assert.equal(p.runtime.values.has("lease"), false);
});

test("BREVAR profile rejects an existing enabled individual age expansion before any POST", async () => {
  const initial = brevarProfileFixture();
  initial.targeting.targeting_automation.individual_setting.age = 1;
  const p = await brevarProfilePair({ initial });
  const result = await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput());
  assert.equal(result.isError, true);
  assert.equal(brevarProfilePosts(p.runtime).length, 0);
  assert.deepEqual(p.state, p.initial);
  assert.equal(p.runtime.values.has("lease"), false);
});

test("BREVAR profile verifies a CBO schedule only when the parent pacing already enables day-parting", async () => {
  const p = await brevarProfilePair();
  p.state.campaign.pacing_type = ["standard", "day_parting"];
  const result = toolPayload(await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput()));
  assert.equal(result.verified, true);
  assert.equal(result.delivery_schedule_verified, true);
  assert.equal(Object.hasOwn(brevarProfileRealPosts(p.runtime)[0].params, "pacing_type"), false);
});

test("BREVAR profile recognizes an unchanged CBO child without pacing while reporting unverified parent scheduling", async () => {
  const p = await brevarProfilePair();
  delete p.state.value.pacing_type;
  const first = toolPayload(await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput()));
  assert.equal(first.verified, true);
  assert.equal(first.delivery_schedule_verified, false);
  const posts = brevarProfilePosts(p.runtime).length;
  const repeated = toolPayload(await p.second.invoke("meta_configure_brevar_adset", brevarProfileRealInput()));
  assert.equal(repeated.mode, "no_change");
  assert.equal(repeated.verified, true);
  assert.equal(repeated.delivery_schedule_verified, false);
  assert.equal(brevarProfilePosts(p.runtime).length, posts);
  assert.equal(Object.hasOwn(p.state.value, "pacing_type"), false);
});

test("BREVAR profile waits at least 31 seconds after completed validation and rereads every authority before the real POST", async () => {
  let validationCompletedAt;
  const p = await brevarProfilePair({ respond(call, _state, _runtime, clock) {
    if (call.path === ADSET && call.params.execution_options) {
      clock.advance(5000); // Validation itself is slow; its start must not count toward the gap.
      validationCompletedAt = clock.Date.now();
      return { success: true };
    }
  } });
  const result = toolPayload(await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput()));
  assert.equal(result.verified, true);
  const real = p.timeline.find(c => c.method === "POST" && c.path === ADSET && !c.validate_only);
  assert.ok(real.at - validationCompletedAt >= 31000, "the one real POST must follow completion of validation by at least 31 seconds");
  assert.equal(p.waits.filter(w => w.ms >= 31000).length, 1);
  const between = p.timeline.filter(c => c.method === "GET" && c.at >= validationCompletedAt && c.at < real.at);
  for (const path of [ADSET, CAMPAIGN, `act_${ACCOUNT}`]) {
    const reads = between.filter(c => c.path === path);
    assert.ok(reads.length > 0, path + " must be reread between the successful validation and mutation");
    assert.ok(reads.every(c => c.at >= validationCompletedAt + 31000), path + " must be reread after the complete gap");
  }
  assert.equal(brevarProfileRealPosts(p.runtime).length, 1);
  assert.equal(p.runtime.values.has("lease"), false);
});

test("BREVAR profile preview performs no 31-second mutation gap", async () => {
  const p = await brevarProfilePair();
  const result = toolPayload(await p.first.invoke("meta_configure_brevar_adset", brevarProfileInput()));
  assert.equal(result.verified_unchanged, true);
  assert.equal(p.waits.some(w => w.ms >= 31000), false);
  assert.equal(brevarProfileRealPosts(p.runtime).length, 0);
});

for (const [label, amend] of [
  ["parent budget", s => { s.campaign.lifetime_budget = "80000"; }],
  ["medical audience", s => { s.value.targeting.age_max = 65; }],
  ["account timezone", s => { s.account.timezone_name = "America/Sao_Paulo"; }],
]) test("BREVAR profile stops if " + label + " changes during the 31-second gap", async () => {
  let waitSeen = false;
  const p = await brevarProfilePair({ onProfileWait(state) { waitSeen = true; amend(state); } });
  const result = await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput());
  assert.equal(waitSeen, true);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /changed during validation/);
  assert.equal(brevarProfilePosts(p.runtime).length, 1);
  assert.equal(brevarProfileRealPosts(p.runtime).length, 0);
  assert.equal(p.runtime.values.has("lease"), false);
});

test("BREVAR profile stops after its lease expires during the mutation gap without dispatching the real POST", async () => {
  let waitSeen = false;
  const p = await brevarProfilePair({ onProfileWait(_state, _runtime, clock) { waitSeen = true; clock.advance(600001); } });
  const result = await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput());
  assert.equal(waitSeen, true);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /WRITE_LEASE_EXPIRED/);
  assert.equal(brevarProfilePosts(p.runtime).length, 1);
  assert.equal(brevarProfileRealPosts(p.runtime).length, 0);
  assert.equal(p.runtime.values.has("lease"), false);
});

test("BREVAR profile does not wait or retry after rate-limited validation #613/4841018", async () => {
  const p = await brevarProfilePair({ respond(call) {
    if (call.path === ADSET && call.params.execution_options) return {
      httpStatus: 400, body: { error: { message: "One ad-set edit per 30 seconds", type: "OAuthException", code: 613, error_subcode: 4841018 } },
    };
  } });
  const result = await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /4841018/);
  assert.equal(p.waits.some(w => w.ms >= 31000), false);
  assert.equal(brevarProfilePosts(p.runtime).length, 1);
  assert.equal(brevarProfileRealPosts(p.runtime).length, 0);
  assert.equal(p.runtime.values.has("lease"), false);
});

test("BREVAR profile retains the lease and never retries a rate-limited real POST after the validated gap", async () => {
  const p = await brevarProfilePair({ respond(call) {
    if (call.path === ADSET && call.method === "POST" && !call.params.execution_options) return {
      httpStatus: 400, body: { error: { message: "One ad-set edit per 30 seconds", type: "OAuthException", code: 613, error_subcode: 4841018 } },
    };
  } });
  const result = await p.first.invoke("meta_configure_brevar_adset", brevarProfileRealInput());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /WRITE_OUTCOME_UNCERTAIN/);
  assert.match(result.content[0].text, /4841018/);
  assert.equal(p.waits.filter(w => w.ms >= 31000).length, 1);
  assert.equal(brevarProfileRealPosts(p.runtime).length, 1);
  assertStatusLeaseRetained(p.runtime, p.clock);
});


function brevarCampaignPacingInput(overrides = {}) {
  return { campaign_id: CAMPAIGN, expected_name: CAMPAIGN_NAME, expected_lifetime_budget_minor: 70000, ...overrides };
}

function brevarCampaignPacingRealInput(overrides = {}) {
  return brevarCampaignPacingInput({ validate_only: false, confirmation_phrase: `CONFIGURE BREVAR CAMPAIGN PACING ${CAMPAIGN} DAY_PARTING LIFETIME 70000${overrides.allow_unscheduled_children ? " ALLOW_UNSCHEDULED_CHILDREN_WHILE_PAUSED" : ""}`, ...overrides });
}

async function brevarCampaignPacingHarness(options = {}) {
  const clock = statusTestClock();
  const runtime = sharedStatusRuntime();
  const child = brevarProfileFixture();
  delete child.pacing_type;
  child.targeting.age_min = 25;
  child.targeting.age_max = 50;
  child.adset_schedule = [{ days: [0, 1, 2, 3, 4, 5, 6], start_minute: 420, end_minute: 1440, timezone_type: "ADVERTISER" }];
  const state = {
    campaign: { ...campaignFixture, status: "ACTIVE", effective_status: "ACTIVE", lifetime_budget: "70000", pacing_type: ["standard"], start_time: "2026-09-04T08:00:00-0200", stop_time: "2026-10-02T23:59:00-0200" },
    adsets: [child, { ...structuredClone(child), id: "900013", name: "BREVAR second paused child", status: "PAUSED", effective_status: "PAUSED" }],
    account: { id: `act_${ACCOUNT}`, account_id: ACCOUNT, timezone_name: "America/Noronha" },
  };
  options.adjustState?.(state);
  const initial = structuredClone(state);
  const waits = [];
  const timeline = [];
  const advanceTimeout = clock.setTimeout;
  clock.setTimeout = (callback, ms) => {
    waits.push({ at: clock.Date.now(), ms });
    return advanceTimeout(() => { if (ms >= 31000) options.onWait?.(state, runtime, clock); callback(); }, ms);
  };
  const h = await harness({ useGate: true, sharedRuntime: runtime, clock, respond: async call => {
    timeline.push({ at: clock.Date.now(), method: call.method, path: call.path, validation: Boolean(call.params.execution_options) });
    const override = await options.respond?.(call, state, clock);
    if (override !== undefined) return override;
    if (call.method === "GET" && call.path === `act_${ACCOUNT}`) return state.account;
    if (call.method === "GET" && call.path === CAMPAIGN) return state.campaign;
    if (call.method === "GET" && call.path === `${CAMPAIGN}/adsets`) {
      assert.equal(Number(call.params.limit), 100);
      return { data: state.adsets };
    }
    if (call.method === "POST") {
      assert.equal(call.path, CAMPAIGN, "campaign pacing never mutates children or the account");
      assert.deepEqual(Object.keys(call.params).sort(), call.params.execution_options ? ["execution_options", "pacing_type"] : ["pacing_type"]);
      assert.deepEqual(call.params.pacing_type, ["day_parting"]);
      if (call.params.execution_options) assert.deepEqual(call.params.execution_options, ["validate_only"]);
      else state.campaign.pacing_type = structuredClone(call.params.pacing_type);
      return { success: true };
    }
  } });
  return { ...h, state, initial, waits, timeline, runtime, clock };
}

test("BREVAR campaign pacing previews the exact lifetime cap and audits every child without a real write", async () => {
  const h = await brevarCampaignPacingHarness();
  const result = toolPayload(await h.invoke("meta_configure_brevar_campaign_pacing", brevarCampaignPacingInput()));
  assert.equal(result.mode, "validate_only");
  assert.equal(result.verified_unchanged, true);
  assert.equal(result.required_confirmation, brevarCampaignPacingRealInput().confirmation_phrase);
  assert.equal(result.proposed.campaign.lifetime_budget, "70000");
  assert.deepEqual(result.proposed.campaign.pacing_type, ["day_parting"]);
  assert.deepEqual(h.state, h.initial);
  assert.equal(postCalls(h).length, 1);
  assert.ok(postCalls(h)[0].params.execution_options);
  assert.equal(h.waits.some(w => w.ms >= 31000), false);
  assert.equal(h.runtime.values.has("lease"), false);
});

test("BREVAR campaign pacing writes only parent day-parting after the 31-second gap and fresh complete hierarchy reads", async () => {
  let validationCompletedAt;
  const h = await brevarCampaignPacingHarness({ respond(call, _state, clock) {
    if (call.method === "POST" && call.params.execution_options) { clock.advance(5000); validationCompletedAt = clock.Date.now(); return { success: true }; }
  } });
  const result = toolPayload(await h.invoke("meta_configure_brevar_campaign_pacing", brevarCampaignPacingRealInput()));
  assert.equal(result.verified, true);
  assert.equal(result.delivery_schedule_verified, true);
  assert.equal(h.state.campaign.lifetime_budget, "70000");
  assert.equal(h.state.campaign.status, h.initial.campaign.status);
  assert.deepEqual(h.state.adsets, h.initial.adsets);
  const real = h.timeline.find(c => c.method === "POST" && !c.validation);
  assert.ok(real.at - validationCompletedAt >= 31000);
  for (const path of [`act_${ACCOUNT}`, CAMPAIGN, `${CAMPAIGN}/adsets`]) {
    const reads = h.timeline.filter(c => c.method === "GET" && c.path === path && c.at >= validationCompletedAt && c.at < real.at);
    assert.ok(reads.length > 0);
    assert.ok(reads.every(c => c.at >= validationCompletedAt + 31000));
  }
  assert.equal(postCalls(h).filter(c => !c.params.execution_options).length, 1);
  assert.equal(h.runtime.values.has("lease"), false);
  const count = postCalls(h).length;
  const repeated = toolPayload(await h.invoke("meta_configure_brevar_campaign_pacing", brevarCampaignPacingRealInput()));
  assert.equal(repeated.mode, "no_change");
  assert.equal(repeated.delivery_schedule_verified, true);
  assert.equal(postCalls(h).length, count);
});

for (const [label, amend] of [
  ["incorrect lifetime cap", s => { s.campaign.lifetime_budget = "80000"; }],
  ["daily parent budget", s => { s.campaign.daily_budget = "2000"; }],
  ["other course parent", s => { s.campaign.name = "ATLS"; }],
  ["child with daily budget", s => { s.adsets[1].daily_budget = "1000"; }],
  ["child with lifetime budget", s => { s.adsets[1].lifetime_budget = "40000"; }],
  ["foreign child account", s => { s.adsets[1].account_id = "999999"; }],
  ["foreign child parent", s => { s.adsets[1].campaign_id = "999999"; }],
  ["paused child missing its schedule", s => { delete s.adsets[1].adset_schedule; }],
  ["paused child using incorrect local hours", s => { s.adsets[1].adset_schedule[0].start_minute = 480; }],
  ["expired child", s => { s.adsets[1].end_time = "2026-09-11T20:00:00-0300"; }],
  ["unsupported parent pacing", s => { s.campaign.pacing_type = ["no_pacing"]; }],
]) test("BREVAR campaign pacing rejects " + label + " before any POST", async () => {
  const h = await brevarCampaignPacingHarness({ adjustState: amend });
  const result = await h.invoke("meta_configure_brevar_campaign_pacing", brevarCampaignPacingRealInput());
  assert.equal(result.isError, true);
  assert.equal(postCalls(h).length, 0);
  assert.deepEqual(h.state, h.initial);
  assert.equal(h.runtime.values.has("lease"), false);
});

test("BREVAR campaign pacing refuses incomplete child pagination instead of silently auditing the first page only", async () => {
  const h = await brevarCampaignPacingHarness({ respond(call, state) {
    if (call.path === `${CAMPAIGN}/adsets`) return { data: state.adsets, paging: { next: "https://graph.facebook.com/ignored", cursors: { after: "NEXT" } } };
  } });
  const result = await h.invoke("meta_configure_brevar_campaign_pacing", brevarCampaignPacingRealInput());
  assert.equal(result.isError, true);
  assert.equal(postCalls(h).length, 0);
  assert.equal(h.calls.filter(c => c.path === `${CAMPAIGN}/adsets`).length, 1);
});

for (const [label, amend] of [
  ["parent cap", s => { s.campaign.lifetime_budget = "80000"; }],
  ["paused child schedule", s => { s.adsets[1].adset_schedule[0].end_minute = 1380; }],
  ["account timezone", s => { s.account.timezone_name = "America/Sao_Paulo"; }],
]) test("BREVAR campaign pacing stops when " + label + " changes during the validation gap", async () => {
  const h = await brevarCampaignPacingHarness({ onWait: amend });
  const result = await h.invoke("meta_configure_brevar_campaign_pacing", brevarCampaignPacingRealInput());
  assert.equal(result.isError, true);
  assert.equal(postCalls(h).length, 1);
  assert.ok(postCalls(h)[0].params.execution_options);
  assert.equal(h.runtime.values.has("lease"), false);
});

test("BREVAR campaign pacing retains its lease if a paused child's targeting drifts after the real parent POST", async () => {
  let posted = false;
  const h = await brevarCampaignPacingHarness({ respond(call, state) {
    if (call.method === "POST" && !call.params.execution_options) posted = true;
    if (call.method === "GET" && call.path === `${CAMPAIGN}/adsets` && posted) state.adsets[1].targeting.age_max = 65;
  } });
  const result = await h.invoke("meta_configure_brevar_campaign_pacing", brevarCampaignPacingRealInput());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /WRITE_OUTCOME_UNCERTAIN/);
  assert.equal(postCalls(h).filter(c => !c.params.execution_options).length, 1);
  assertStatusLeaseRetained(h.runtime, h.clock);
});

function pausedCampaignWithPendingChild(state) {
  state.campaign.status = "PAUSED";
  state.campaign.effective_status = "PAUSED";
  delete state.adsets[1].adset_schedule;
}

test("BREVAR campaign pacing refuses the unscheduled-child exception for an active campaign", async () => {
  const h = await brevarCampaignPacingHarness({ adjustState(state) { delete state.adsets[1].adset_schedule; } });
  const result = await h.invoke("meta_configure_brevar_campaign_pacing", brevarCampaignPacingRealInput({ allow_unscheduled_children: true }));
  assert.equal(result.isError, true);
  assert.equal(postCalls(h).length, 0);
  assert.deepEqual(h.state, h.initial);
  assert.equal(h.runtime.values.has("lease"), false);
});

for (const preview of [true, false]) test(`BREVAR campaign pacing ${preview ? "previews" : "updates"} only the paused parent while reporting its unscheduled child as pending`, async () => {
  const h = await brevarCampaignPacingHarness({ adjustState: pausedCampaignWithPendingChild });
  const input = preview ? brevarCampaignPacingInput({ allow_unscheduled_children: true }) : brevarCampaignPacingRealInput({ allow_unscheduled_children: true });
  const result = toolPayload(await h.invoke("meta_configure_brevar_campaign_pacing", input));
  assert.equal(preview ? result.verified_unchanged : result.verified, true);
  assert.equal(result.delivery_schedule_verified, false);
  assert.deepEqual(result.pending_adset_ids, ["900013"]);
  if (preview) {
    assert.equal(result.required_confirmation, brevarCampaignPacingRealInput({ allow_unscheduled_children: true }).confirmation_phrase);
    assert.deepEqual(h.state, h.initial);
  } else {
    assert.deepEqual(h.state.campaign.pacing_type, ["day_parting"]);
    assert.equal(h.state.campaign.status, "PAUSED");
    assert.equal(h.state.campaign.lifetime_budget, "70000");
  }
  assert.deepEqual(h.state.adsets, h.initial.adsets);
  assert.equal(postCalls(h).filter(c => !c.params.execution_options).length, preview ? 0 : 1);
  assert.equal(h.runtime.values.has("lease"), false);
});

test("BREVAR campaign pacing requires explicit authorization even if the campaign with an unscheduled child is paused", async () => {
  const h = await brevarCampaignPacingHarness({ adjustState: pausedCampaignWithPendingChild });
  const result = await h.invoke("meta_configure_brevar_campaign_pacing", brevarCampaignPacingRealInput());
  assert.equal(result.isError, true);
  assert.equal(postCalls(h).length, 0);
  assert.equal(h.runtime.values.has("lease"), false);
});

for (const [label, schedule] of [
  ["empty calendar", []],
  ["different hours", [{ days: [0, 1, 2, 3, 4, 5, 6], start_minute: 480, end_minute: 1440, timezone_type: "ADVERTISER" }]],
]) test("BREVAR campaign pacing still rejects an existing " + label + " when the unscheduled-child exception is authorized", async () => {
  const h = await brevarCampaignPacingHarness({ adjustState(state) { pausedCampaignWithPendingChild(state); state.adsets[1].adset_schedule = schedule; } });
  const result = await h.invoke("meta_configure_brevar_campaign_pacing", brevarCampaignPacingRealInput({ allow_unscheduled_children: true }));
  assert.equal(result.isError, true);
  assert.equal(postCalls(h).length, 0);
  assert.equal(h.runtime.values.has("lease"), false);
});

test("BREVAR campaign pacing checks the exception-specific confirmation before reads and locking", async () => {
  const h = await brevarCampaignPacingHarness({ adjustState: pausedCampaignWithPendingChild });
  const result = await h.invoke("meta_configure_brevar_campaign_pacing", brevarCampaignPacingRealInput({ allow_unscheduled_children: true, confirmation_phrase: brevarCampaignPacingRealInput().confirmation_phrase }));
  assert.equal(result.isError, true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.lockCalls.length, 0);
});

test("BREVAR campaign pacing aborts when the paused campaign is activated during the unscheduled-child validation gap", async () => {
  const h = await brevarCampaignPacingHarness({ adjustState: pausedCampaignWithPendingChild, onWait(state) { state.campaign.status = "ACTIVE"; } });
  const result = await h.invoke("meta_configure_brevar_campaign_pacing", brevarCampaignPacingRealInput({ allow_unscheduled_children: true }));
  assert.equal(result.isError, true);
  assert.equal(postCalls(h).length, 1);
  assert.equal(postCalls(h).filter(c => !c.params.execution_options).length, 0);
  assert.equal(h.runtime.values.has("lease"), false);
});

test("BREVAR campaign pacing retains its lease when the paused campaign is activated after the real write with a pending child", async () => {
  let posted = false;
  const h = await brevarCampaignPacingHarness({ adjustState: pausedCampaignWithPendingChild, respond(call, state) {
    if (call.method === "POST" && !call.params.execution_options) posted = true;
    if (call.method === "GET" && call.path === CAMPAIGN && posted) state.campaign.status = "ACTIVE";
  } });
  const result = await h.invoke("meta_configure_brevar_campaign_pacing", brevarCampaignPacingRealInput({ allow_unscheduled_children: true }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /WRITE_OUTCOME_UNCERTAIN/);
  assert.equal(postCalls(h).filter(c => !c.params.execution_options).length, 1);
  assertStatusLeaseRetained(h.runtime, h.clock);
});

test("BREVAR campaign pacing no-op keeps a missing child pending even when parent day-parting is already set", async () => {
  const h = await brevarCampaignPacingHarness({ adjustState(state) { pausedCampaignWithPendingChild(state); state.campaign.pacing_type = ["day_parting"]; } });
  const result = toolPayload(await h.invoke("meta_configure_brevar_campaign_pacing", brevarCampaignPacingRealInput({ allow_unscheduled_children: true })));
  assert.equal(result.mode, "no_change");
  assert.equal(result.verified, true);
  assert.equal(result.delivery_schedule_verified, false);
  assert.deepEqual(result.pending_adset_ids, ["900013"]);
  assert.equal(postCalls(h).length, 0);
  assert.equal(h.runtime.values.has("lease"), false);
});

test("BREVAR campaign pacing verifies delivery with the exception enabled when every paused campaign child has the correct calendar", async () => {
  const h = await brevarCampaignPacingHarness({ adjustState(state) { state.campaign.status = "PAUSED"; state.campaign.effective_status = "PAUSED"; } });
  const result = toolPayload(await h.invoke("meta_configure_brevar_campaign_pacing", brevarCampaignPacingRealInput({ allow_unscheduled_children: true })));
  assert.equal(result.verified, true);
  assert.equal(result.delivery_schedule_verified, true);
  assert.deepEqual(result.pending_adset_ids, []);
  assert.equal(h.state.campaign.status, "PAUSED");
  assert.equal(h.runtime.values.has("lease"), false);
});

// BREVAR replacement runs the actual durable lock/journal. No Meta request,
// production credential, real network, or external object is used by these tests.
const BREVAR_AD = "900090";
const BREVAR_OLD_CREATIVE = "900091";
const BREVAR_NEW_CREATIVE = "900092";
const BREVAR_PAGE = "102139681237405";
const BREVAR_PHONE = "554791822809";
const BREVAR_IMAGE_HASH = "a".repeat(32);
function creativeReplaceInput(overrides = {}) {
  return { ad_id: BREVAR_AD, expected_name: "BREVAR | CONVITE | V1", message: "Treinamento supervisionado para médicos e médicas. Blumenau, 3 de outubro.", headline: "BREVAR em Blumenau", description: "Livro físico e prática supervisionada", image_hash: BREVAR_IMAGE_HASH, link_url: `https://wa.me/${BREVAR_PHONE}?text=Tenho%20interesse`, request_id: REQUEST_ID, ...overrides };
}
async function creativeReplacementHarness(options = {}) {
  const clock = options.clock ?? statusTestClock();
  const runtime = options.runtime ?? sharedStatusRuntime();
  const state = options.state ?? {
    ad: { id: BREVAR_AD, account_id: ACCOUNT, name: "BREVAR | CONVITE | V1", adset_id: ADSET, campaign_id: CAMPAIGN, status: "PAUSED", effective_status: "WITH_ISSUES", creative: { id: BREVAR_OLD_CREATIVE }, tracking_specs: [{ "action.type": ["offsite_conversion"] }] },
    adset: { ...ageFixture(), destination_type: "WHATSAPP", optimization_goal: "CONVERSATIONS", promoted_object: { page_id: BREVAR_PAGE, whatsapp_phone_number: BREVAR_PHONE } },
    campaign: { ...campaignFixture, lifetime_budget: "70000", stop_time: "2026-10-02T23:59:00-0200" },
    oldCreative: { id: BREVAR_OLD_CREATIVE, account_id: ACCOUNT, name: "Old creative", object_story_spec: { page_id: BREVAR_PAGE, instagram_actor_id: "102009001", link_data: { image_hash: "b".repeat(32), message: "Médicos e acadêmicos", name: "BREVAR", link: `https://wa.me/${BREVAR_PHONE}`, call_to_action: { type: "WHATSAPP_MESSAGE", value: { link: `https://wa.me/${BREVAR_PHONE}`, app_destination: "WHATSAPP" } } } }, url_tags: "utm_source=meta" },
    newCreative: null,
  };
  if (options.adjustState) options.adjustState(state);
  const h = await harness({ useGate: true, clock, sharedRuntime: runtime, writeLockRespond: options.writeLockRespond, respond: async (call) => {
    const override = options.respond && await options.respond(call, state);
    if (override !== undefined) return override;
    if (call.method === "GET" && call.path === BREVAR_AD) return structuredClone(state.ad);
    if (call.method === "GET" && call.path === ADSET) return structuredClone(state.adset);
    if (call.method === "GET" && call.path === CAMPAIGN) return structuredClone(state.campaign);
    if (call.method === "GET" && call.path === BREVAR_OLD_CREATIVE) return structuredClone(state.oldCreative);
    if (call.method === "GET" && call.path === BREVAR_NEW_CREATIVE) return structuredClone(state.newCreative);
    if (call.method === "GET" && call.path === `act_${ACCOUNT}/adimages`) return { data: [{ hash: BREVAR_IMAGE_HASH }] };
    if (call.method === "POST" && call.path === `act_${ACCOUNT}/adcreatives`) {
      state.newCreative = { ...structuredClone(call.params), id: BREVAR_NEW_CREATIVE, account_id: ACCOUNT };
      return { id: BREVAR_NEW_CREATIVE };
    }
    if (call.method === "POST" && call.path === BREVAR_AD && !call.params.execution_options) {
      state.ad.creative = { id: BREVAR_NEW_CREATIVE };
      state.ad.effective_status = "PENDING_REVIEW";
      if (options.afterAttach) options.afterAttach(state);
      return { success: true };
    }
    if (call.method === "POST") return { success: true };
  } });
  return { ...h, state, clock, runtime };
}
async function replaceCreative(h, overrides = {}) {
  const input = creativeReplaceInput(overrides);
  const preview = toolPayload(await h.invoke("meta_update_brevar_ad_creative", input));
  return h.invoke("meta_update_brevar_ad_creative", { ...input, validate_only: false, confirmation_phrase: preview.required_confirmation });
}
function realCreativePosts(h) { return postCalls(h).filter((call) => !call.params.execution_options); }

test("creative replacement waits 31 seconds after attachment validation and rereads the hierarchy before attaching", async () => {
  const clock = statusTestClock();
  const waits = [];
  const timeline = [];
  const advanceTimeout = clock.setTimeout;
  clock.setTimeout = (callback, ms) => { waits.push({ at: clock.Date.now(), ms }); return advanceTimeout(callback, ms); };
  let attachmentValidatedAt;
  const h = await creativeReplacementHarness({ clock, respond(call) {
    timeline.push({ at: clock.Date.now(), path: call.path, method: call.method, validation: Boolean(call.params.execution_options) });
    if (call.method === "POST" && call.path === BREVAR_AD && call.params.execution_options) {
      clock.advance(5000);
      attachmentValidatedAt = clock.Date.now();
      return { success: true };
    }
  } });
  const result = toolPayload(await replaceCreative(h));
  assert.equal(result.verified, true);
  const attachment = timeline.find(c => c.method === "POST" && c.path === BREVAR_AD && !c.validation);
  assert.ok(attachment.at - attachmentValidatedAt >= 31000);
  const relevantWaits = waits.filter(w => w.ms >= 31000);
  assert.equal(relevantWaits.length, 1, "different /ads preview and /adcreatives endpoints must not gain unnecessary 31-second gaps");
  assert.ok(relevantWaits[0].at >= attachmentValidatedAt);
  const between = timeline.filter(c => c.method === "GET" && c.at >= attachmentValidatedAt && c.at < attachment.at);
  for (const path of [BREVAR_AD, ADSET, CAMPAIGN, BREVAR_OLD_CREATIVE]) {
    const reads = between.filter(c => c.path === path);
    assert.ok(reads.length > 0, path + " must be reread before attaching");
    assert.ok(reads.every(c => c.at >= attachmentValidatedAt + 31000), path + " must be reread after the complete attachment gap");
  }
  assert.deepEqual(realCreativePosts(h).map(c => c.path), [`act_${ACCOUNT}/adcreatives`, BREVAR_AD]);
  assert.equal(h.runtime.values.get(`brevar-creative:${REQUEST_ID}`).stage, "COMPLETE");
});

test("creative replacement detects an ad change during the attachment gap and retains CREATIVE_CREATED without attaching", async () => {
  const clock = statusTestClock();
  const advanceTimeout = clock.setTimeout;
  let waitSeen = false;
  let h;
  clock.setTimeout = (callback, ms) => advanceTimeout(() => {
    if (ms >= 31000) { waitSeen = true; h.state.ad.name = "Externally changed during gap"; }
    callback();
  }, ms);
  h = await creativeReplacementHarness({ clock });
  const result = await replaceCreative(h);
  assert.equal(waitSeen, true);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /RECONCILIATION_REQUIRED.*CREATIVE_CREATED/s);
  assert.match(result.content[0].text, /ad.name/);
  assert.deepEqual(realCreativePosts(h).map(c => c.path), [`act_${ACCOUNT}/adcreatives`]);
  assert.equal(h.state.ad.creative.id, BREVAR_OLD_CREATIVE);
  assert.equal(h.runtime.values.get(`brevar-creative:${REQUEST_ID}`).stage, "CREATIVE_CREATED");
  assert.equal(h.runtime.values.has("lease"), true);
});

test("creative replacement stops when its lease expires in the attachment gap and retains its created-creative journal", async () => {
  const clock = statusTestClock();
  const advanceTimeout = clock.setTimeout;
  let waitSeen = false;
  clock.setTimeout = (callback, ms) => advanceTimeout(() => {
    if (ms >= 31000) { waitSeen = true; clock.advance(11 * 60 * 1000); }
    callback();
  }, ms);
  const h = await creativeReplacementHarness({ clock });
  const result = await replaceCreative(h);
  assert.equal(waitSeen, true);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /RECONCILIATION_REQUIRED.*CREATIVE_CREATED/s);
  assert.match(result.content[0].text, /WRITE_LEASE_EXPIRED/);
  assert.deepEqual(realCreativePosts(h).map(c => c.path), [`act_${ACCOUNT}/adcreatives`]);
  assert.equal(h.state.ad.creative.id, BREVAR_OLD_CREATIVE);
  assert.equal(h.runtime.values.get(`brevar-creative:${REQUEST_ID}`).stage, "CREATIVE_CREATED");
});

test("creative replacement defaults to inline-only validation and verifies the complete hierarchy without creating anything", async () => {
  const h = await creativeReplacementHarness();
  const result = toolPayload(await h.invoke("meta_update_brevar_ad_creative", creativeReplaceInput()));
  assert.equal(result.mode, "validate_only"); assert.equal(result.verified_unchanged, true);
  assert.equal(result.proposed.object_story_spec.link_data.call_to_action.type, "WHATSAPP_MESSAGE");
  assert.deepEqual(result.proposed.object_story_spec.link_data.call_to_action.value, { app_destination: "WHATSAPP", link: creativeReplaceInput().link_url });
  assert.equal(result.proposed.object_story_spec.instagram_actor_id, "102009001");
  assert.deepEqual(postCalls(h).map((call) => [call.path, call.params.execution_options]), [[`act_${ACCOUNT}/ads`, ["validate_only"]]]);
  assert.equal(realCreativePosts(h).length, 0);
  assert.equal(h.runtime.values.has(`brevar-creative:${REQUEST_ID}`), false);
  assert.equal(h.runtime.values.has("lease"), false);
});

test("creative replacement updates the existing ad ID only and replay verifies current settings with zero POSTs", async () => {
  const h = await creativeReplacementHarness();
  const before = structuredClone(h.state);
  const preview = toolPayload(await h.invoke("meta_update_brevar_ad_creative", creativeReplaceInput()));
  const input = creativeReplaceInput({ validate_only: false, confirmation_phrase: preview.required_confirmation });
  const result = toolPayload(await h.invoke("meta_update_brevar_ad_creative", input));
  assert.equal(result.verified, true); assert.equal(result.ad_id, BREVAR_AD); assert.equal(result.creative_id, BREVAR_NEW_CREATIVE);
  assert.deepEqual(h.state.adset, before.adset); assert.deepEqual(h.state.campaign, before.campaign);
  assert.equal(h.state.ad.status, "PAUSED");
  assert.deepEqual(realCreativePosts(h).map((c) => c.path), [`act_${ACCOUNT}/adcreatives`, BREVAR_AD]);
  assert.deepEqual(Object.keys(realCreativePosts(h)[1].params), ["creative"]);
  assert.deepEqual(realCreativePosts(h)[1].params.creative, { creative_id: BREVAR_NEW_CREATIVE });
  assert.equal(h.runtime.values.get(`brevar-creative:${REQUEST_ID}`).stage, "COMPLETE");
  assert.equal(h.runtime.values.get(`brevar-creative-ad:${BREVAR_AD}`).stage, "COMPLETE");
  assert.equal(h.runtime.values.has("lease"), false);
  const posts = postCalls(h).length;
  const replay = toolPayload(await h.invoke("meta_update_brevar_ad_creative", input));
  assert.equal(replay.mode, "idempotent_replay"); assert.equal(replay.verified, true);
  assert.equal(postCalls(h).length, posts);
});

for (const [name, adjustment, inputOverride, error] of [
  ["active ads", s => { s.ad.status = "ACTIVE"; }, {}, /configured PAUSED/],
  ["other courses", s => { s.ad.name = "ATLS"; s.campaign.name = "ATLS"; }, { expected_name: "ATLS" }, /limited to.*BREVAR/],
  ["native Instagram boosts", s => { s.oldCreative.source_instagram_media_id = "1028"; }, {}, /native workflow/],
  ["existing posts", s => { s.oldCreative.object_story_id = `${BREVAR_PAGE}_12`; }, {}, /native workflow/],
  ["wrong WhatsApp phone", () => {}, { link_url: "https://wa.me/5599999999999" }, /approved BREVAR phone/],
  ["non-approved site", s => { s.adset.destination_type = "ON_POST"; s.adset.optimization_goal = "POST_ENGAGEMENT"; }, { link_url: "https://evil.example/produtos/72/curso-brevar-fundamentos-t04-blumenau-sc/" }, /approved BREVAR course URL/],
  ["foreign ad accounts", s => { s.ad.account_id = "3"; }, {}, /does not belong/],
  ["foreign creatives", s => { s.oldCreative.account_id = "3"; }, {}, /Creative identity or account/],
  ["wrong Page", s => { s.oldCreative.object_story_spec.page_id = "3"; }, {}, /Stoicus Page/],
]) {
  test(`creative replacement refuses ${name} before any POST`, async () => {
    const h = await creativeReplacementHarness({ adjustState: adjustment });
    const result = await h.invoke("meta_update_brevar_ad_creative", creativeReplaceInput(inputOverride));
    assert.equal(result.isError, true); assert.match(result.content[0].text, error);
    assert.equal(postCalls(h).length, 0); assert.equal(h.runtime.values.has("lease"), false);
  });
}

test("creative replacement on-post uses the approved site, preserves Instagram identity and disables no settings", async () => {
  const h = await creativeReplacementHarness({ adjustState(s) { s.adset.destination_type = "ON_POST"; s.adset.optimization_goal = "POST_ENGAGEMENT"; } });
  const result = toolPayload(await replaceCreative(h, { link_url: "https://www.stoicus.com.br/produtos/72/curso-brevar-fundamentos-t04-blumenau-sc/?utm_source=meta" }));
  assert.equal(result.verified, true);
  assert.equal(result.proposed.object_story_spec.link_data.call_to_action.type, "LEARN_MORE");
  assert.equal(result.proposed.url_tags, h.state.oldCreative.url_tags);
});

test("creative replacement rejects an unowned image hash and a failed Meta validation without any create", async () => {
  for (const phase of ["image", "validation"]) {
    const h = await creativeReplacementHarness({ respond(call) {
      if (phase === "image" && call.path.endsWith("/adimages")) return { data: [] };
      if (phase === "validation" && call.method === "POST") return { success: false };
    } });
    const result = await h.invoke("meta_update_brevar_ad_creative", creativeReplaceInput());
    assert.equal(result.isError, true); assert.equal(realCreativePosts(h).length, 0);
    assert.equal(h.runtime.values.has("lease"), false);
  }
});

test("creative replacement detects parent targeting drift after validation before creating a creative", async () => {
  const h = await creativeReplacementHarness({ respond(call, state) {
    if (call.path === `act_${ACCOUNT}/ads` && call.method === "POST") state.adset.targeting.age_max = 65;
  } });
  const result = await h.invoke("meta_update_brevar_ad_creative", creativeReplaceInput());
  assert.equal(result.isError, true); assert.match(result.content[0].text, /adset.targeting/);
  assert.equal(realCreativePosts(h).length, 0);
});

test("creative replacement detects concurrent parent budget change after create and never attaches", async () => {
  const h = await creativeReplacementHarness({ respond(call, state) {
    if (call.path === BREVAR_NEW_CREATIVE && call.method === "GET") state.campaign.lifetime_budget = "90000";
  } });
  const result = await replaceCreative(h);
  assert.equal(result.isError, true); assert.match(result.content[0].text, /RECONCILIATION_REQUIRED.*CREATIVE_CREATED/s);
  assert.equal(realCreativePosts(h).length, 1);
  assert.equal(h.state.ad.creative.id, BREVAR_OLD_CREATIVE);
  assert.equal(h.runtime.values.get(`brevar-creative:${REQUEST_ID}`).stage, "CREATIVE_CREATED");
  assert.equal(h.runtime.values.has("lease"), true);
});

test("creative create outcome uncertainty blocks the same and a different request ID after lease expiry", async () => {
  const h = await creativeReplacementHarness({ respond(call) {
    if (call.path.endsWith("/adcreatives") && call.method === "POST") return { rawBody: "unconfirmed", httpStatus: 502 };
  } });
  const result = await replaceCreative(h);
  assert.equal(result.isError, true); assert.match(result.content[0].text, /RECONCILIATION_REQUIRED.*CREATE_PENDING/s);
  assert.equal(h.runtime.values.get(`brevar-creative:${REQUEST_ID}`).stage, "CREATE_PENDING");
  const posts = postCalls(h).length;
  h.clock.advance(11 * 60 * 1_000);
  const same = await h.invoke("meta_update_brevar_ad_creative", creativeReplaceInput());
  assert.equal(same.isError, true); assert.match(same.content[0].text, /CREATE_PENDING/);
  const other = await h.invoke("meta_update_brevar_ad_creative", creativeReplaceInput({ request_id: "22345678-1234-4234-9234-123456789012" }));
  assert.equal(other.isError, true); assert.match(other.content[0].text, /different request_id cannot bypass/);
  assert.equal(postCalls(h).length, posts);
});

test("creative attachment uncertainty leaves durable attachment intent and never repeats attachment", async () => {
  const h = await creativeReplacementHarness({ afterAttach(state) { state.ad.status = "ACTIVE"; } });
  const result = await replaceCreative(h);
  assert.equal(result.isError, true); assert.match(result.content[0].text, /RECONCILIATION_REQUIRED.*ATTACH_PENDING/s);
  assert.equal(h.runtime.values.get(`brevar-creative:${REQUEST_ID}`).stage, "ATTACH_PENDING");
  const posts = postCalls(h).length;
  h.clock.advance(11 * 60 * 1_000);
  const replay = await h.invoke("meta_update_brevar_ad_creative", creativeReplaceInput());
  assert.equal(replay.isError, true); assert.match(replay.content[0].text, /ATTACH_PENDING/);
  assert.equal(postCalls(h).length, posts);
});

test("creative replay rejects changed input or externally changed completed ad instead of silently succeeding", async () => {
  const h = await creativeReplacementHarness();
  toolPayload(await replaceCreative(h));
  const posts = postCalls(h).length;
  const reused = await h.invoke("meta_update_brevar_ad_creative", creativeReplaceInput({ headline: "Different" }));
  assert.equal(reused.isError, true); assert.match(reused.content[0].text, /different creative inputs/);
  h.state.ad.creative = { id: BREVAR_OLD_CREATIVE };
  const drift = await h.invoke("meta_update_brevar_ad_creative", creativeReplaceInput());
  assert.equal(drift.isError, true); assert.match(drift.content[0].text, /current settings: ad.creative/);
  assert.equal(postCalls(h).length, posts);
});

test("creative final readback checks contents, not just attached creative ID", async () => {
  const h = await creativeReplacementHarness({ afterAttach(state) { state.newCreative.object_story_spec.link_data.message = "Unexpected changed content"; } });
  const result = await replaceCreative(h);
  assert.equal(result.isError, true); assert.match(result.content[0].text, /Creative read-back mismatch: object_story_spec/);
  assert.equal(h.runtime.values.get(`brevar-creative:${REQUEST_ID}`).stage, "ATTACH_PENDING");
});


test("creative replacement removes the academic welcome flow and stale caption, retaining the approved wa.me prefill", async () => {
  const h = await creativeReplacementHarness({ adjustState(s) {
    s.oldCreative.object_story_spec.link_data.page_welcome_message = "Informe nome, email; médicos e acadêmicos";
    s.oldCreative.object_story_spec.link_data.caption = "Meio-Oeste exclusivo";
  } });
  const result = toolPayload(await replaceCreative(h));
  assert.equal(Object.hasOwn(result.proposed.object_story_spec.link_data, "page_welcome_message"), false);
  assert.equal(Object.hasOwn(result.proposed.object_story_spec.link_data, "caption"), false);
  assert.equal(result.proposed.object_story_spec.link_data.link, creativeReplaceInput().link_url);
});

test("creative journal save failure after creation prevents attachment and any subsequent duplicate create", async () => {
  const h = await creativeReplacementHarness({ writeLockRespond(call) {
    if (call.payload.action === "creative_journal_put" && call.payload.expected_stage === "CREATE_PENDING") {
      return { httpStatus: 503, body: { code: "SIMULATED_STORAGE_UNAVAILABLE" } };
    }
  } });
  const result = await replaceCreative(h);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, new RegExp(`CREATE_PENDING, creative ${BREVAR_NEW_CREATIVE}`));
  assert.equal(h.runtime.values.get(`brevar-creative:${REQUEST_ID}`).stage, "CREATE_PENDING");
  assert.equal(realCreativePosts(h).length, 1);
  h.clock.advance(11 * 60 * 1_000);
  const replay = await h.invoke("meta_update_brevar_ad_creative", creativeReplaceInput());
  assert.equal(replay.isError, true); assert.match(replay.content[0].text, /CREATE_PENDING/);
  assert.equal(realCreativePosts(h).length, 1);
});

test("creative replacement checks the original ad again after attachment validation to prevent a concurrent creative overwrite", async () => {
  const h = await creativeReplacementHarness({ respond(call, state) {
    if (call.path === BREVAR_AD && call.method === "POST" && call.params.execution_options) state.ad.name = "Externally renamed";
  } });
  const result = await replaceCreative(h);
  assert.equal(result.isError, true); assert.match(result.content[0].text, /ad.name/);
  assert.equal(realCreativePosts(h).length, 1); assert.equal(h.state.ad.creative.id, BREVAR_OLD_CREATIVE);
  assert.equal(h.runtime.values.get(`brevar-creative:${REQUEST_ID}`).stage, "CREATIVE_CREATED");
});

test("creative replacement never attaches when its operation lease expires after creative creation", async () => {
  let clock;
  const h = await creativeReplacementHarness({ respond(call) {
    if (call.method === "GET" && call.path === BREVAR_NEW_CREATIVE) clock.advance(11 * 60 * 1_000);
  } });
  clock = h.clock;
  const result = await replaceCreative(h);
  assert.equal(result.isError, true); assert.match(result.content[0].text, /RECONCILIATION_REQUIRED/);
  assert.equal(realCreativePosts(h).length, 1);
  assert.equal(h.runtime.values.get(`brevar-creative:${REQUEST_ID}`).stage, "CREATIVE_CREATED");
});

test("creative replacement operation lease excludes a second chat during creative creation", async () => {
  let signalEntered, resolveCreate;
  const entered = new Promise(resolve => { signalEntered = resolve; });
  const blocked = new Promise(resolve => { resolveCreate = resolve; });
  const h = await creativeReplacementHarness({ respond: async call => {
    if (call.method === "POST" && call.path.endsWith("/adcreatives")) { signalEntered(); await blocked; }
  } });
  const preview = toolPayload(await h.invoke("meta_update_brevar_ad_creative", creativeReplaceInput()));
  const input = creativeReplaceInput({ validate_only: false, confirmation_phrase: preview.required_confirmation });
  const otherInput = creativeReplaceInput({ request_id: "22345678-1234-4234-9234-123456789012" });
  const otherPreview = toolPayload(await h.invoke("meta_update_brevar_ad_creative", otherInput));
  const first = h.invoke("meta_update_brevar_ad_creative", input);
  await entered;
  const other = await creativeReplacementHarness({ clock: h.clock, runtime: h.runtime, state: h.state });
  const second = await other.invoke("meta_update_brevar_ad_creative", input);
  assert.equal(second.isError, true); assert.match(second.content[0].text, /WRITE_LOCKED/);
  const differentId = await other.invoke("meta_update_brevar_ad_creative", { ...otherInput, validate_only: false, confirmation_phrase: otherPreview.required_confirmation });
  assert.equal(differentId.isError, true); assert.match(differentId.content[0].text, /WRITE_LOCKED/);
  resolveCreate();
  const completed = toolPayload(await first);
  assert.equal(completed.verified, true);
  assert.deepEqual(realCreativePosts(h).map(c => c.path), [`act_${ACCOUNT}/adcreatives`, BREVAR_AD]);
});


test("creative create gate denial is explicitly no-dispatch but retains durable intent for reconciliation", async () => {
  let runtime;
  const h = await creativeReplacementHarness({ writeLockRespond(call) {
    if (call.payload.action === "assert_owner" && runtime.values.get(`brevar-creative:${REQUEST_ID}`)?.stage === "CREATE_PENDING") {
      return { httpStatus: 409, body: { code: "WRITE_LEASE_EXPIRED" } };
    }
  } });
  runtime = h.runtime;
  const result = await replaceCreative(h);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /gate confirmed no creative-create POST was dispatched/);
  assert.equal(realCreativePosts(h).length, 0);
  assert.equal(runtime.values.get(`brevar-creative:${REQUEST_ID}`).stage, "CREATE_PENDING");
});

test("creative journal rejects stale operation holders after lease takeover and rejects skipped stages", async () => {
  const h = await creativeReplacementHarness();
  toolPayload(await h.invoke("meta_update_brevar_ad_creative", creativeReplaceInput()));
  const call = payload => h.runtime.lock.fetch(new Request("https://meta-write-lock.internal/lease", { method: "POST", body: JSON.stringify(payload) }));
  assert.equal((await call({ action: "acquire", holder: "old", operation: "test", ttl_ms: 60000 })).status, 200);
  h.clock.advance(61000);
  assert.equal((await call({ action: "acquire", holder: "new", operation: "test", ttl_ms: 60000 })).status, 200);
  const record = { fingerprint: "x", stage: "CREATE_PENDING", ad_id: BREVAR_AD, request_id: REQUEST_ID };
  const stale = await call({ action: "creative_journal_put", holder: "old", request_id: REQUEST_ID, ad_id: BREVAR_AD, expected_stage: "ABSENT", record });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, "WRITE_LOCKED");
  const skipped = await call({ action: "creative_journal_put", holder: "new", request_id: REQUEST_ID, ad_id: BREVAR_AD, expected_stage: "ABSENT", record: { ...record, stage: "COMPLETE" } });
  assert.equal(skipped.status, 409); assert.equal((await skipped.json()).code, "CREATIVE_JOURNAL_CONFLICT");
  assert.equal(h.runtime.values.has(`brevar-creative:${REQUEST_ID}`), false);
});


const UPLOAD_ASSET_PATH = "/creative-assets/brevar-sul-test.jpg";
const UPLOAD_ASSET_NAME = "brevar-sul-test.jpg";
const UPLOAD_ASSET_BYTES = Uint8Array.from([255, 216, 255, 99, 255, 217]);
const UPLOAD_ASSET_HASH = "0123456789abcdef0123456789abcdef";

function publicUploadAsset(request) {
  assert.equal(request.method, "GET");
  const url = new URL(request.url);
  assert.equal(url.origin, "https://creative-assets.internal");
  if (url.pathname !== UPLOAD_ASSET_PATH) return new Response("Missing", { status: 404 });
  return new Response(UPLOAD_ASSET_BYTES, { headers: { "Content-Type": "image/jpeg" } });
}

function uploadAssetInput(overrides = {}) {
  return {
    asset_path: UPLOAD_ASSET_PATH,
    confirmation_phrase: `UPLOAD CREATIVE ASSET act_${ACCOUNT} ${UPLOAD_ASSET_PATH}`,
    validate_only: false,
    ...overrides,
  };
}

function uploadAssetResponse(call) {
  if (call.path !== `act_${ACCOUNT}/adimages`) return undefined;
  if (call.method === "POST") {
    return { images: { bytes: { hash: UPLOAD_ASSET_HASH, name: "Meta generated name", url: "https://do-not-return.invalid/?access_token=private" } } };
  }
  return { data: [{ hash: UPLOAD_ASSET_HASH, name: "Meta generated name", account_id: ACCOUNT, url: "https://do-not-return.invalid/?access_token=private" }] };
}

test("creative asset preview reports local metadata and performs no Meta call or lease", async () => {
  const h = await harness({ creativeAssetResponse: publicUploadAsset });
  const result = toolPayload(await h.invoke("meta_upload_creative_asset", { asset_path: UPLOAD_ASSET_PATH }));
  assert.equal(result.mode, "local_preview");
  assert.equal(result.meta_validation_performed, false);
  assert.equal(result.meta_write_performed, false);
  assert.equal(result.proposed.mime_type, "image/jpeg");
  assert.equal(result.proposed.size_bytes, UPLOAD_ASSET_BYTES.length);
  assert.equal(result.proposed.image_name, UPLOAD_ASSET_NAME);
  assert.match(result.proposed.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.required_confirmation, uploadAssetInput().confirmation_phrase);
  assert.equal(h.calls.length, 0);
  assert.equal(h.lockCalls.length, 0);
  assert.equal(JSON.stringify(result).includes(Buffer.from(UPLOAD_ASSET_BYTES).toString("base64")), false);
});

test("creative asset preview rejects absent manifest paths without any Meta call", async () => {
  const h = await harness({ creativeAssetResponse: publicUploadAsset });
  const result = await h.invoke("meta_upload_creative_asset", { asset_path: "/creative-assets/not-registered.jpg" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /absent from the public manifest/);
  assert.equal(h.calls.length, 0);
});

test("creative asset path schema refuses external URLs and traversal", async () => {
  const h = await harness({ creativeAssetResponse: publicUploadAsset });
  for (const asset_path of ["https://example.com/ad.jpg", "/creative-assets/../private.jpg", "/creative-assets/a.jpg?token=secret", "/creative-assets/%2E%2E/private.jpg"]) {
    await assert.rejects(h.invoke("meta_upload_creative_asset", { asset_path }));
  }
  assert.equal(h.calls.length, 0);
});

test("creative asset upload enforces enabled writes and exact account-bound confirmation", async () => {
  const disabled = await harness({ creativeAssetResponse: publicUploadAsset, env: { META_WRITE_ENABLED: "false" } });
  const disabledResult = await disabled.invoke("meta_upload_creative_asset", uploadAssetInput());
  assert.equal(disabledResult.isError, true);
  assert.match(disabledResult.content[0].text, /disabled/);
  assert.equal(disabled.calls.length, 0);
  const h = await harness({ creativeAssetResponse: publicUploadAsset });
  const wrong = await h.invoke("meta_upload_creative_asset", uploadAssetInput({ confirmation_phrase: "UPLOAD CREATIVE ASSET anything" }));
  assert.equal(wrong.isError, true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.lockCalls.length, 0);
});

test("creative asset upload confirms account identity before dispatch", async () => {
  const h = await harness({ creativeAssetResponse: publicUploadAsset, respond(call) {
    if (call.path === `act_${ACCOUNT}`) return { id: "act_888888", account_id: "888888" };
    return uploadAssetResponse(call);
  } });
  const result = await h.invoke("meta_upload_creative_asset", uploadAssetInput());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /identity was not confirmed/);
  assert.equal(h.calls.filter(call => call.method === "POST").length, 0);
  assert.equal(h.lockCalls.at(-1).payload.action, "release_owned");
});

test("creative asset upload posts only approved bytes and returns a verified account-bound image hash", async () => {
  const h = await harness({ creativeAssetResponse: publicUploadAsset, respond: uploadAssetResponse });
  const result = toolPayload(await h.invoke("meta_upload_creative_asset", uploadAssetInput({ bytes: "ATTACKER", url: "https://not-used.invalid" })));
  assert.equal(result.mode, "uploaded");
  assert.equal(result.verified, true);
  assert.equal(result.image_hash, UPLOAD_ASSET_HASH);
  assert.equal(result.account_id, `act_${ACCOUNT}`);
  assert.deepEqual(h.calls.map(call => [call.method, call.path]), [
    ["GET", `act_${ACCOUNT}`], ["POST", `act_${ACCOUNT}/adimages`], ["GET", `act_${ACCOUNT}/adimages`],
  ]);
  assert.deepEqual(h.calls[1].params, { bytes: Buffer.from(UPLOAD_ASSET_BYTES).toString("base64") });
  assert.deepEqual(h.calls[2].params, { fields: "hash,name,account_id", hashes: [UPLOAD_ASSET_HASH], limit: "2" });
  assert.equal(h.lockCalls.at(-1).payload.action, "release_owned");
  assert.match(h.lockCalls[0].payload.holder, /^operation:/);
  assert.equal(JSON.stringify(result).includes("access_token"), false);
  assert.equal(JSON.stringify(result).includes("do-not-return"), false);
  assert.equal(JSON.parse(h.auditEvents[0]).operation, "upload_creative_asset");
});

for (const scenario of ["empty upload", "multiple hashes", "invalid hash", "wrong hash", "wrong name", "wrong account", "read failure", "post failure"]) {
  test(`creative asset upload retains its lease without retry on uncertain result: ${scenario}`, async () => {
    const h = await harness({ creativeAssetResponse: publicUploadAsset, respond(call) {
      if (call.path === `act_${ACCOUNT}/adimages`) {
        if (call.method === "POST") {
          if (scenario === "empty upload") return { images: {} };
          if (scenario === "multiple hashes") return { images: { one: { hash: UPLOAD_ASSET_HASH }, two: { hash: UPLOAD_ASSET_HASH } } };
          if (scenario === "invalid hash") return { images: { bytes: { hash: "https://unsafe.invalid" } } };
          if (scenario === "post failure") return { httpStatus: 500, body: { error: { message: "Upload response unavailable" } } };
        } else {
          if (scenario === "wrong hash") return { data: [{ hash: "ffffffffffffffffffffffffffffffff", name: "Meta generated name", account_id: ACCOUNT }] };
          if (scenario === "wrong account") return { data: [{ hash: UPLOAD_ASSET_HASH, name: "Meta generated name", account_id: "888888" }] };
          if (scenario === "wrong name") return { data: [{ hash: UPLOAD_ASSET_HASH, name: "other.jpg", account_id: ACCOUNT }] };
          if (scenario === "read failure") return { httpStatus: 500, body: { error: { message: "Read unavailable" } } };
        }
      }
      return uploadAssetResponse(call);
    } });
    const result = await h.invoke("meta_upload_creative_asset", uploadAssetInput());
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /WRITE_OUTCOME_UNCERTAIN/);
    assert.equal(h.calls.filter(call => call.method === "POST").length, 1);
    assert.equal(h.lockCalls.some(call => /release/.test(call.payload.action)), false);
    assert.equal(JSON.parse(h.auditEvents[0]).operation, "upload_creative_asset_unverified");
  });
}


test("creative asset upload accepts documented hash-only response and reports Meta-generated name honestly", async () => {
  const h = await harness({ creativeAssetResponse: publicUploadAsset, respond(call) {
    if (call.path === `act_${ACCOUNT}/adimages` && call.method === "POST") return { images: { [UPLOAD_ASSET_HASH]: { hash: UPLOAD_ASSET_HASH } } };
    return uploadAssetResponse(call);
  } });
  const result = toolPayload(await h.invoke("meta_upload_creative_asset", uploadAssetInput()));
  assert.equal(result.verified, true);
  assert.equal(result.meta_image_name, "Meta generated name");
  assert.equal(result.image_name, UPLOAD_ASSET_NAME);
  assert.equal(result.name_verification, "read_from_account_library");
});
