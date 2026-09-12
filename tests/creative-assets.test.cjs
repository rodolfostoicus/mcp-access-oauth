"use strict";

// Exercise the real asset handler and Worker entrypoint with an in-memory
// manifest. These fixtures are never written to the production asset manifest.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { z } = require("zod");

const JPEG_PATH = "/creative-assets/brevar-offline-jpeg-a1b2c3.jpg";
const PNG_PATH = "/creative-assets/brevar-offline-png-d4e5f6.png";
const JPEG_BYTES = Buffer.from([255, 216, 255, 224, 17, 29, 255, 217]);
const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqwoAAAAASUVORK5CYII=", "base64");
const fixtureManifest = {
  [JPEG_PATH]: { mimeType: "image/jpeg", base64: JPEG_BYTES.toString("base64") },
  [PNG_PATH]: { mimeType: "image/png", base64: PNG_BYTES.toString("base64") },
};

const AHA_VERTICAL_ASSETS = [
  ["aha-acls-ritmo-stories-v1", "ecff9ec7929ee2a2590176f13f94f2ba041ed41aa010543aace90c101964db0d", 363350],
  ["aha-pals-avaliacao-stories-v1", "928962364e3ed8b7bb50dcc576a92e5f5123c7f7cd6297ccd4552d155fdb147a", 345258],
  ["aha-acls-conheca-stories-v1", "e1e1bcf01bacb44e27743c71b9e14f7bfb8103cb9ac8c2e44c0983728604e258", 391728],
  ["aha-pals-conheca-stories-v1", "35531c8ecae9945a9cba661cea660075776ae610730c87d0285038f5cb24aa38", 357274],
];

function loadModule(relativePath, moduleResolver) {
  const filename = path.resolve(__dirname, relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const exports = {};
  const module = { exports };
  vm.runInNewContext(compiled, {
    module, exports, require: moduleResolver,
    Request, Response, Headers, URL, URLSearchParams, Uint8Array, atob,
    fetch() { throw new Error("Asset tests must never access the network."); },
  }, { filename });
  return module.exports;
}

function loadAssetHandler(manifest = fixtureManifest) {
  return loadModule("../src/creative-assets.ts", (name) => {
    assert.equal(name, "./creative-manifest");
    return { CREATIVE_ASSETS: manifest };
  }).getCreativeAssetResponse;
}

function request(assetPath, method = "GET") {
  return new Request(`https://worker.example${assetPath}`, { method });
}

test("allowlisted raster GET responses preserve exact bytes and raster headers", async () => {
  const handler = loadAssetHandler();
  for (const [assetPath, bytes, mimeType] of [
    [JPEG_PATH, JPEG_BYTES, "image/jpeg"],
    [PNG_PATH, PNG_BYTES, "image/png"],
  ]) {
    const response = handler(request(assetPath));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), mimeType);
    assert.equal(response.headers.get("Content-Length"), String(bytes.length));
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
});

test("reviewed AHA vertical modules and immutable manifest entries preserve exact JPEG bytes", () => {
  const manifest = fs.readFileSync(path.resolve(__dirname, "../src/creative-manifest.ts"), "utf8");
  for (const [label, digest, expectedBytes] of AHA_VERTICAL_ASSETS) {
    const moduleSource = fs.readFileSync(path.resolve(__dirname, `../src/creative-data/${label}.ts`), "utf8");
    const encoded = moduleSource.match(/export default ("[A-Za-z0-9+/=]+");/);
    assert.ok(encoded, `${label} must export one base64 string`);
    const bytes = Buffer.from(JSON.parse(encoded[1]), "base64");
    assert.equal(bytes.length, expectedBytes);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.deepEqual([...bytes.subarray(-2)], [0xff, 0xd9]);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), digest);
    assert.match(manifest, new RegExp(`/creative-assets/${label}-${digest.slice(0, 16)}\\.jpg`));
  }
});

test("HEAD preserves GET metadata without a response body", async () => {
  const handler = loadAssetHandler();
  const getResponse = handler(request(JPEG_PATH));
  const headResponse = handler(request(JPEG_PATH, "HEAD"));
  assert.equal(headResponse.status, 200);
  assert.deepEqual(Array.from(headResponse.headers), Array.from(getResponse.headers));
  assert.equal((await headResponse.arrayBuffer()).byteLength, 0);
});

test("the exact pathname allowlist cannot proxy a URL or expose an unknown asset", async () => {
  const handler = loadAssetHandler();
  for (const assetPath of [
    "/creative-assets/missing.jpg",
    "/creative-assets/__proto__",
    "/creative-assets/constructor",
    "/creative-assets/https://private.example/file.jpg",
    "/creative-assets/%2E%2E%2Fprivate",
    `${JPEG_PATH}/extra`,
  ]) {
    const response = handler(request(assetPath));
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  const response = handler(request(`${JPEG_PATH}?url=https://private.example/file.jpg`));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), JPEG_BYTES);
});

test("asset routes reject all write methods without delegating or decoding", () => {
  const handler = loadAssetHandler({
    [JPEG_PATH]: { mimeType: "image/jpeg", get base64() { throw new Error("Do not decode writes."); } },
  });
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = handler(request(JPEG_PATH, method));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "GET, HEAD");
  }
});

test("corrupt or mismatched manifest bytes fail closed with a generic error", async () => {
  for (const asset of [
    { mimeType: "image/jpeg", base64: "not base64!" },
    { mimeType: "image/jpeg", base64: "" },
    { mimeType: "image/png", base64: JPEG_BYTES.toString("base64") },
    { mimeType: "image/jpeg", base64: PNG_BYTES.toString("base64") },
    { mimeType: "text/html", base64: Buffer.from("<script>private</script>").toString("base64") },
  ]) {
    const response = loadAssetHandler({ [JPEG_PATH]: asset })(request(JPEG_PATH));
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(await response.text(), "Creative asset unavailable.");
  }
});

test("the handler leaves every non-asset path to the existing application", () => {
  const handler = loadAssetHandler();
  for (const pathname of ["/", "/mcp", "/mcp-v2", "/authorize", "/token", "/register", "/creative-assets-other/a.jpg"]) {
    assert.equal(handler(request(pathname)), null);
  }
});

test("Worker serves only known art publicly and preserves OAuth and MCP routing", async () => {
  const oauthCalls = [];
  let oauthOptions;
  const handler = loadAssetHandler();
  class OAuthProvider {
    constructor(options) { oauthOptions = options; }
    fetch(originalRequest, env, ctx) {
      oauthCalls.push({ request: originalRequest, env, ctx });
      return new Response("OAuth owns this request.");
    }
  }
  class McpAgent {
    static serve(route) { return { route }; }
  }
  const worker = loadModule("../src/index.ts", (name) => {
    if (name === "./creative-assets") return { getCreativeAssetResponse: handler };
    if (name === "@cloudflare/workers-oauth-provider") return { __esModule: true, default: OAuthProvider };
    if (name === "@modelcontextprotocol/sdk/server/mcp.js") return { McpServer: class {} };
    if (name === "agents/mcp") return { McpAgent };
    if (name === "zod") return { z };
    if (name === "./access-handler") return { handleAccessRequest() { throw new Error("Unexpected authentication handler call."); } };
    throw new Error(`Unexpected import: ${name}`);
  }).default;
  const env = Object.freeze({ marker: "unchanged environment" });
  const ctx = Object.freeze({ marker: "unchanged context" });

  const imageResponse = await worker.fetch(request(JPEG_PATH), env, ctx);
  assert.equal(imageResponse.status, 200);
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), JPEG_BYTES);
  assert.equal((await worker.fetch(request("/creative-assets/missing.jpg"), env, ctx)).status, 404);
  assert.equal((await worker.fetch(request(JPEG_PATH, "POST"), env, ctx)).status, 405);
  assert.equal(oauthCalls.length, 0);

  for (const pathname of ["/mcp", "/authorize", "/token", "/register", "/.well-known/oauth-authorization-server"]) {
    const originalRequest = request(pathname, "POST");
    const response = await worker.fetch(originalRequest, env, ctx);
    assert.equal(await response.text(), "OAuth owns this request.");
    assert.equal(oauthCalls.at(-1).request, originalRequest);
    assert.equal(oauthCalls.at(-1).env, env);
    assert.equal(oauthCalls.at(-1).ctx, ctx);
  }
  const aliasRequest = new Request("https://worker.example/mcp-v2?session=test", {
    method: "POST", body: "untouched MCP body", headers: { "X-Test-Header": "unchanged" },
  });
  await worker.fetch(aliasRequest, env, ctx);
  const delegated = oauthCalls.at(-1).request;
  assert.equal(delegated.url, "https://worker.example/mcp?session=test");
  assert.equal(delegated.method, "POST");
  assert.equal(delegated.headers.get("X-Test-Header"), "unchanged");
  assert.equal(await delegated.text(), "untouched MCP body");
  assert.equal(oauthOptions.apiRoute, "/mcp");
  assert.equal(oauthOptions.authorizeEndpoint, "/authorize");
  assert.equal(oauthOptions.tokenEndpoint, "/token");
  assert.equal(oauthOptions.clientRegistrationEndpoint, "/register");
});
