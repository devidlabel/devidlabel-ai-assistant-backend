import assert from "node:assert/strict";
import { build } from "esbuild";

const bundled = await build({
  entryPoints: ["src/amazon-readonly-handler.ts"],
  bundle: true,
  platform: "neutral",
  format: "esm",
  write: false,
  logLevel: "silent"
});
const moduleUrl = "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64");
const { handleAmazonReadonlyRequest } = await import(moduleUrl);
const originalFetch = globalThis.fetch;
const env = {
  ASSISTANT_ADMIN_TOKEN: "test-admin-token",
  AMAZON_SP_API_CLIENT_ID: "test-client-id",
  AMAZON_SP_API_CLIENT_SECRET: "test-client-secret",
  AMAZON_SP_API_REFRESH_TOKEN: "test-refresh-token"
};
const url = "https://worker.example/internal/amazon/marketplaces";
try {
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    if (String(input).includes("/auth/o2/token")) {
      assert.equal(init.method, "POST");
      const params = new URLSearchParams(init.body);
      assert.equal(params.get("grant_type"), "refresh_token");
      assert.equal(params.get("client_id"), env.AMAZON_SP_API_CLIENT_ID);
      return new Response(JSON.stringify({ access_token: "mock-access-token" }), { status: 200 });
    }
    assert.equal(String(input), "https://sellingpartnerapi-eu.amazon.com/sellers/v1/marketplaceParticipations");
    assert.equal(init.headers["x-amz-access-token"], "mock-access-token");
    return new Response(JSON.stringify({ payload: [{ marketplace: { id: "APJ6JRA9NG5V4" } }] }), { status: 200 });
  };
  const unauthorized = await handleAmazonReadonlyRequest(new Request(url), env);
  assert.equal(unauthorized.status, 401);
  assert.equal(calls, 0, "Unauthorized requests must never contact Amazon");
  const wrongMethod = await handleAmazonReadonlyRequest(new Request(url, { method: "POST" }), env);
  assert.equal(wrongMethod.status, 405);
  assert.equal(calls, 0);
  const allowed = await handleAmazonReadonlyRequest(new Request(url, { headers: { Authorization: "Bearer test-admin-token" } }), env);
  assert.equal(allowed.status, 200);
  const body = await allowed.json();
  assert.equal(body.ok, true);
  assert.equal(body.read_only, true);
  assert.equal(calls, 2);
  const missing = await handleAmazonReadonlyRequest(new Request(url, { headers: { Authorization: "Bearer test-admin-token" } }), { ASSISTANT_ADMIN_TOKEN: "test-admin-token" });
  assert.equal(missing.status, 502);
  assert.equal((await missing.json()).error, "amazon_credentials_missing");
  assert.equal(calls, 2);
  console.log("Amazon SP-API read-only route tests passed");
} finally {
  globalThis.fetch = originalFetch;
}
