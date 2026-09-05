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
      return new Response(JSON.stringify(override.body ?? override), {
        status: override.httpStatus ?? 200,
        headers: { "Content-Type": "application/json" },
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
      body = { id: `act_${ACCOUNT}`, name: "Offline account" };
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
      throw new Error(`Unexpected module in offline test: ${name}`);
    },
    fetch: mockFetch,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    Error,
    console: { log(value) { auditEvents.push(value); } },
  };
  vm.runInNewContext(compiled, context, { filename: sourcePath });
  const agent = new moduleObject.exports.MyMCP();
  agent.env = {
    META_ACCESS_TOKEN: "OFFLINE_TEST_ONLY_NOT_A_CREDENTIAL",
    META_AD_ACCOUNT_ID: ACCOUNT,
    META_API_VERSION: "v26.0",
    META_WRITE_ENABLED: "true",
    OAUTH_KV: {
      async get(...args) { kvReads.push(args); return null; },
      async put(...args) { kvWrites.push(args); },
    },
  };
  await agent.init();
  return {
    calls, kvWrites, kvReads, auditEvents, metadata: agent.server.metadata,
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
    destination_type: "WEBSITE",
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
  toolPayload(await h.invoke("meta_create_adset_draft", adsetInput({
    promoted_object: { page_id: PAGE }, destination_type: undefined,
  })));
  const { params } = postCalls(h)[0];
  assert.equal(params.destination_type, "WEBSITE");
  assert.equal(params.optimization_goal, "LINK_CLICKS");
  assert.deepEqual(params.promoted_object, { page_id: PAGE });
  assert.equal(params.status, "PAUSED");
  assert.equal(h.kvWrites.length, 0);
});

test("lead-generation path is unchanged and does not acquire WhatsApp routing", async () => {
  const h = await harness({ campaign: { ...campaignFixture, objective: "OUTCOME_LEADS" } });
  toolPayload(await h.invoke("meta_create_adset_draft", adsetInput({
    promoted_object: { page_id: PAGE }, destination_type: undefined,
    optimization_goal: "LEAD_GENERATION",
  })));
  const { params } = postCalls(h)[0];
  assert.equal(params.optimization_goal, "LEAD_GENERATION");
  assert.equal(Object.hasOwn(params, "destination_type"), false);
  assert.deepEqual(params.promoted_object, { page_id: PAGE });
  assert.equal(params.status, "PAUSED");
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

test("Page WhatsApp diagnostics are read-only and report connector version", async () => {
  const h = await harness();
  const result = toolPayload(await h.invoke("meta_get_token_permissions"));
  assert.equal(result.connector_version, "2.2.4");
  assert.equal(h.metadata.version, "2.2.4");
  assert.equal(result.ready_for_reads, true);
  assert.equal(result.ready_for_writes, true);
  assert.equal(result.write_switch_enabled, true);
  assert.ok(Array.isArray(result.page_whatsapp_diagnostics));
  const page = result.page_whatsapp_diagnostics.find(item => item.page_id === PAGE);
  assert.ok(page, "diagnostics should explicitly identify the inspected Page");
  assert.equal(page.whatsapp_number, PHONE);
  assert.equal(page.has_whatsapp_number, true);
  assert.equal(page.has_whatsapp_business_number, true);
  assert.equal(postCalls(h).length, 0);
  assert.equal(h.kvWrites.length, 0);
});

test("Page and WABA diagnostic failures preserve baseline permissions and identity", async () => {
  const h = await harness({
    respond(call) {
      if (call.path === PAGE || call.path === `act_${ACCOUNT}`) {
        return { httpStatus: 400, body: { error: { code: 100, message: "Offline unsupported diagnostic field" } } };
      }
    },
  });
  const result = toolPayload(await h.invoke("meta_get_token_permissions"));
  assert.equal(result.ready_for_reads, true);
  assert.equal(result.ready_for_writes, true);
  assert.equal(result.token_subject.id, "900005");
  assert.equal(result.accessible_pages[0].id, PAGE);
  assert.equal(result.permissions.length, 2);
  const page = result.page_whatsapp_diagnostics.find(item => item.page_id === PAGE);
  assert.ok(page);
  assert.match(page.diagnostic_error, /Offline unsupported diagnostic field/);
  assert.match(result.whatsapp_assets.whatsapp_asset_error, /Offline unsupported diagnostic field/);
  assert.equal(postCalls(h).length, 0);
  assert.equal(h.kvWrites.length, 0);
});

test("account reads remain single-request by default and omit unrequested targeting diagnostics", async () => {
  const h = await harness();
  const result = toolPayload(await h.invoke("meta_get_ad_account"));
  assert.equal(result.account.id, `act_${ACCOUNT}`);
  assert.equal(result.connector_version, "2.2.4");
  assert.equal(Object.hasOwn(result, "work_position_search"), false);
  assert.equal(Object.hasOwn(result, "work_position_validation"), false);
  assert.equal(Object.hasOwn(result, "audience_inventory"), false);
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
  assert.equal(result.connector_version, "2.2.4");
  assert.match(result.work_position_search[0].diagnostic_error, /Offline targeting diagnostic failure/);
  assert.match(result.work_position_validation.diagnostic_error, /Offline targeting diagnostic failure/);
  assert.equal(postCalls(h).length, 0);
  assert.equal(h.kvWrites.length, 0);
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
    assert.equal(result.connector_version, "2.2.4");
    assert.equal(result.audience_inventory.kind, kind);
    assert.match(result.audience_inventory.diagnostic_error, /Offline audience inventory failure/);
    assert.equal(Object.hasOwn(result.audience_inventory, "audiences"), false);
    assert.equal(postCalls(h).length, 0);
    assert.equal(h.kvWrites.length, 0);
  }
});
