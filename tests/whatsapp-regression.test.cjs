"use strict";

// Offline integration tests: execute the real TypeScript tool handlers while
// replacing every network request and KV operation with in-memory fixtures.
// No production credentials, Cloudflare calls, or Meta writes are possible.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
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
  const calls = [];
  const kvWrites = [];
  const kvReads = [];
  const lockCalls = [];
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
      if (name === "./creative-assets") return { getCreativeAssetResponse() { return null; } };
      throw new Error(`Unexpected module in offline test: ${name}`);
    },
    fetch: mockFetch,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    Error,
    setTimeout,
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
              : { body: { active: call.payload.action === "acquire", acquired: call.payload.action === "acquire", released: call.payload.action === "release", expires_at: "2099-01-01T00:00:00.000Z" } });
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
  if (options.useGate) {
    const gate = new moduleObject.exports.MetaApiGate({}, agent.env);
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
                error: [metaError.message, metaError.type && `type=${metaError.type}`, metaError.code !== undefined && `code=${metaError.code}`]
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
    calls, kvWrites, kvReads, lockCalls, auditEvents, metadata: agent.server.metadata,
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
  assert.equal(result.connector_version, "2.3.1");
  assert.equal(h.metadata.version, "2.3.1");
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
  assert.equal(result.connector_version, "2.3.1");
  assert.equal(h.metadata.version, "2.3.1");
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

test("account reads remain single-request by default and omit unrequested targeting diagnostics", async () => {
  const h = await harness();
  const result = toolPayload(await h.invoke("meta_get_ad_account"));
  assert.equal(result.account.id, `act_${ACCOUNT}`);
  assert.equal(result.connector_version, "2.3.1");
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
  assert.equal(result.connector_version, "2.3.1");
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
    assert.equal(result.connector_version, "2.3.1");
    assert.equal(result.audience_inventory.kind, kind);
    assert.match(result.audience_inventory.diagnostic_error, /Offline audience inventory failure/);
    assert.equal(Object.hasOwn(result.audience_inventory, "audiences"), false);
    assert.equal(postCalls(h).length, 0);
    assert.equal(h.kvWrites.length, 0);
  }
});

test("ad inventory exposes auditable creative fields through owned read-only edges", async () => {
  const ads = [{
    id: "900007", name: "Offline auditable ad", adset_id: ADSET, campaign_id: CAMPAIGN,
    status: "PAUSED", effective_status: "PAUSED",
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
    assert.equal(adsRead.params.fields, "id,name,adset_id,campaign_id,status,effective_status,creative{id,name,object_story_spec,image_hash,thumbnail_url},created_time,updated_time");
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
