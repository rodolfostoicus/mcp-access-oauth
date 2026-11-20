const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

// Load the Worker handler and its real approval utilities in the Node test runner.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-authorize-"));
after(() => fs.rmSync(directory, { recursive: true, force: true }));
for (const name of ["access-handler", "workers-oauth-utils"]) {
	const source = fs.readFileSync(path.join(__dirname, "..", "src", name + ".ts"), "utf8");
	const result = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	fs.writeFileSync(path.join(directory, name + ".js"), result.outputText);
}
const { handleAccessRequest } = require(path.join(directory, "access-handler.js"));
const redirectUri = "https://client.example/callback";
const request = new Request("https://issuer.example/authorize?client_id=sample-client");
const missingClient = "Invalid client. The clientId provided does not match to this client.";

function invoke(parseAuthRequest, lookupClient) {
	return handleAccessRequest(request, {
		OAUTH_PROVIDER: { parseAuthRequest, lookupClient },
		COOKIE_ENCRYPTION_KEY: "test-only",
	}, {});
}

test("a registered client still reaches the original consent screen", async () => {
	const response = await invoke(
		async () => ({ clientId: "sample-client", redirectUri, scope: [], state: "example" }),
		async (id) => {
			assert.equal(id, "sample-client");
			return { clientId: id, clientName: "Registered example", redirectUris: [redirectUri] };
		},
	);
	assert.equal(response.status, 200);
	assert.match(await response.text(), /Registered example/);
	assert.ok(response.headers.get("Set-Cookie"));
});

test("a missing registration returns an OAuth error directly to the browser", async () => {
	const response = await invoke(async () => { throw new Error(missingClient); });
	assert.equal(response.status, 400);
	assert.equal(response.headers.get("Location"), null);
	assert.equal(response.headers.get("Set-Cookie"), null);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
	const body = await response.json();
	assert.equal(body.error, "invalid_client");
	assert.match(body.error_description, /cadastro original/);
	assert.doesNotMatch(body.error_description, /sample-client|client\.example|clientId/);
});

for (const message of ["KV unavailable", "Invalid redirect URI."]) {
	test("other provider errors remain distinguishable: " + message, async () => {
		const error = new Error(message);
		await assert.rejects(invoke(async () => { throw error; }), (reason) => reason === error);
	});
}
