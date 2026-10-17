import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/amazon-readonly-handler.ts"],
  bundle: true, platform: "neutral", format: "esm", write: false, logLevel: "silent"
});
const { handleAmazonReadonlyRequest } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const originalFetch = globalThis.fetch;
const env = { DAILY_PULSE_ACCESS_TOKEN: "admin",
  AMAZON_SP_API_CLIENT_ID: "id", AMAZON_SP_API_CLIENT_SECRET: "secret", AMAZON_SP_API_REFRESH_TOKEN: "refresh" };
const url = "https://worker.example/internal/amazon/report-stream?marketplace=IT";
let calls = 0;
let invalidHost = false;
try {
  globalThis.fetch = async (input, init = {}) => {
    calls++;
    const target = String(input);
    if (target.includes("/auth/o2/token")) {
      assert.equal(init.method, "POST");
      return new Response(JSON.stringify({ access_token: "access" }), { status: 200 });
    }
    if (target.includes("/reports/2021-06-30/reports")) {
      assert.equal(init.method, "GET");
      assert.equal(init.headers["x-amz-access-token"], "access");
      return new Response(JSON.stringify({ reports: [{
        reportType: "GET_MERCHANT_LISTINGS_ALL_DATA",
        processingStatus: "DONE", reportDocumentId: "private-report-id",
        createdTime: "2026-10-17T10:00:00Z"
      }] }), { status: 200 });
    }
    if (target.includes("/reports/2021-06-30/documents/")) {
      return new Response(JSON.stringify({
        url: invalidHost ? "https://evil.example/private" : "https://seller.s3.amazonaws.com/data?signature=private",
        compressionAlgorithm: "GZIP"
      }), { status: 200 });
    }
    assert(target.startsWith("https://seller.s3.amazonaws.com/data"));
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert(!init.headers?.["x-amz-access-token"]);
    assert(!init.headers?.Authorization);
    return new Response("fake-compressed-bytes", { status: 200, headers: { "content-length": "21" } });
  };
  assert.equal((await handleAmazonReadonlyRequest(new Request(url), env)).status, 401);
  assert.equal(calls, 0);
  assert.equal((await handleAmazonReadonlyRequest(new Request(url.replace("=IT", "=XX"), env && { headers: { Authorization: "Bearer admin" } }), env)).status, 400);
  assert.equal(calls, 0);
  const result = await handleAmazonReadonlyRequest(new Request(url, { headers: { Authorization: "Bearer admin" } }), env);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("X-Amazon-Report-Marketplace"), "IT");
  assert.equal(result.headers.get("X-Amazon-Report-Compression"), "GZIP");
  assert.equal(result.headers.get("Cache-Control"), "private, no-store");
  assert.equal(await result.text(), "fake-compressed-bytes");
  assert(![...result.headers].some(([_, value]) => value.includes("private-report-id") || value.includes("signature=")));
  invalidHost = true;
  const rejected = await handleAmazonReadonlyRequest(new Request(url, { headers: { Authorization: "Bearer admin" } }), env);
  assert.equal(rejected.status, 502);
  assert.equal((await rejected.json()).error, "amazon_stream_document_host_invalid");
  console.log("Amazon full report streaming guard tests passed");
} finally { globalThis.fetch = originalFetch; }
