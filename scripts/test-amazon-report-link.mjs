import assert from "node:assert/strict";
import { build } from "esbuild";

const bundled = await build({
  entryPoints: ["src/amazon-readonly-handler.ts"], bundle: true,
  platform: "neutral", format: "esm", write: false, logLevel: "silent"
});
const { handleAmazonReadonlyRequest } = await import(
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64")
);
const originalFetch = globalThis.fetch;
const env = {
  DAILY_PULSE_ACCESS_TOKEN: "admin",
  AMAZON_SP_API_CLIENT_ID: "id", AMAZON_SP_API_CLIENT_SECRET: "secret", AMAZON_SP_API_REFRESH_TOKEN: "refresh"
};
const url = "https://worker.example/internal/amazon/report-link?marketplace=IT";
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
    assert(!target.includes("s3.amazonaws.com"), "Worker must never download Amazon S3 documents");
    assert.equal(init.method, "GET");
    assert.equal(init.headers["x-amz-access-token"], "access");
    if (target.includes("/reports/2021-06-30/reports")) {
      return new Response(JSON.stringify({ reports: [{
        reportType: "GET_MERCHANT_LISTINGS_ALL_DATA", processingStatus: "DONE",
        reportDocumentId: "private-id", createdTime: "2026-10-17T10:00:00Z"
      }] }), { status: 200 });
    }
    assert(target.includes("/reports/2021-06-30/documents/"));
    return new Response(JSON.stringify({
      url: invalidHost
        ? "https://untrusted.example/private"
        : "https://secure-bucket.s3.amazonaws.com/path?X-Amz-Signature=secret-location",
      compressionAlgorithm: "GZIP"
    }), { status: 200 });
  };
  const unauthorized = await handleAmazonReadonlyRequest(new Request(url), env);
  assert.equal(unauthorized.status, 401);
  assert.equal(calls, 0);
  const headers = { Authorization: "Bearer admin" };
  assert.equal((await handleAmazonReadonlyRequest(new Request(url.replace("=IT","=XX"), { headers }), env)).status, 400);
  assert.equal(calls, 0);
  const response = await handleAmazonReadonlyRequest(new Request(url, { headers }), env);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("X-Amazon-Report-Marketplace"), "IT");
  assert.equal(response.headers.get("X-Amazon-Report-Compression"), "GZIP");
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert(response.headers.get("Location").startsWith("https://secure-bucket.s3.amazonaws.com/path"));
  assert.equal(await response.text(), "");
  assert.equal(calls, 3);
  invalidHost = true;
  const bad = await handleAmazonReadonlyRequest(new Request(url, { headers }), env);
  assert.equal(bad.status, 502);
  const error = await bad.json();
  assert.equal(error.error, "amazon_link_host_invalid");
  assert(!JSON.stringify(error).includes("secret-location"));
  console.log("Amazon report S3 redirect endpoint guard tests passed");
} finally { globalThis.fetch = originalFetch; }
