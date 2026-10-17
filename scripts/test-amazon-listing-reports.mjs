import assert from "node:assert/strict";
import { build } from "esbuild";
const bundled = await build({ entryPoints: ["src/amazon-readonly-handler.ts"], bundle: true, platform: "neutral", format: "esm", write: false, logLevel: "silent" });
const { handleAmazonReadonlyRequest } = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));
const env = { DAILY_PULSE_ACCESS_TOKEN: "admin", AMAZON_SP_API_CLIENT_ID: "id", AMAZON_SP_API_CLIENT_SECRET: "secret", AMAZON_SP_API_REFRESH_TOKEN: "refresh" };
const original = globalThis.fetch;
let calls = 0;
try {
  globalThis.fetch = async (url, init) => {
    calls++;
    if (String(url).includes("/auth/o2/token")) return new Response(JSON.stringify({ access_token: "access" }), { status: 200 });
    const parsed = new URL(String(url));
    assert.equal(parsed.pathname, "/reports/2021-06-30/reports");
    assert.equal(parsed.searchParams.get("reportTypes"), "GET_MERCHANT_LISTINGS_ALL_DATA");
    assert.equal(init.method, "GET");
    assert.equal(init.headers["x-amz-access-token"], "access");
    return new Response(JSON.stringify({ reports: [{ reportId: "123", reportType: "GET_MERCHANT_LISTINGS_ALL_DATA", processingStatus: "DONE", reportDocumentId: "private-doc" }] }), { status: 200 });
  };
  const base = "https://worker.example/internal/amazon/listing-reports?marketplace=";
  assert.equal((await handleAmazonReadonlyRequest(new Request(base + "IT"), env)).status, 401);
  assert.equal(calls, 0);
  const headers = { Authorization: "Bearer admin" };
  assert.equal((await handleAmazonReadonlyRequest(new Request(base + "XX", { headers }), env)).status, 400);
  assert.equal(calls, 0);
  for (const market of ["IT", "DE", "FR", "ES"]) {
    const response = await handleAmazonReadonlyRequest(new Request(base + market, { headers }), env);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(data.read_only, true);
    assert.equal(data.result.marketplace, market);
    assert.equal(data.result.reports[0].reportDocumentAvailable, true);
    assert.equal(JSON.stringify(data).includes("private-doc"), false);
  }
  assert.equal(calls, 8);
  console.log("Amazon listing report metadata read-only tests passed");
} finally { globalThis.fetch = original; }
