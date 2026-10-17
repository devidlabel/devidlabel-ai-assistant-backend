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
  AMAZON_SP_API_CLIENT_ID: "id",
  AMAZON_SP_API_CLIENT_SECRET: "client-secret",
  AMAZON_SP_API_REFRESH_TOKEN: "refresh"
};
const base = "https://worker.example/internal/amazon/listing-report-summary?marketplace=";
let calls = 0;
let stale = false;
let duplicate = false;
try {
  globalThis.fetch = async (input, init = {}) => {
    calls++;
    const url = String(input);
    if (url.includes("/auth/o2/token")) {
      assert.equal(init.method, "POST");
      return new Response(JSON.stringify({ access_token: "amazon-access" }), { status: 200 });
    }
    if (url.includes("/reports/2021-06-30/reports")) {
      assert.equal(init.method, "GET");
      assert.equal(init.headers["x-amz-access-token"], "amazon-access");
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("marketplaceIds"), "APJ6JRA9NG5V4");
      assert.equal(parsed.searchParams.get("reportTypes"), "GET_MERCHANT_LISTINGS_ALL_DATA");
      return new Response(JSON.stringify({ reports: [{
        reportId: "report-1",
        reportType: "GET_MERCHANT_LISTINGS_ALL_DATA",
        processingStatus: "DONE",
        reportDocumentId: "private-document-id",
        createdTime: new Date(Date.now() - (stale ? 72 : 1) * 3600000).toISOString()
      }] }), { status: 200 });
    }
    if (url.includes("/reports/2021-06-30/documents/")) {
      assert.equal(init.headers["x-amz-access-token"], "amazon-access");
      return new Response(JSON.stringify({
        url: "https://seller-reports.s3.amazonaws.com/real-report?X-Amz-Signature=do-not-log"
      }), { status: 200 });
    }
    assert(url.startsWith("https://seller-reports.s3.amazonaws.com/real-report"));
    assert(!init.headers?.Authorization, "No worker bearer token sent to S3");
    assert(!init.headers?.["x-amz-access-token"], "No Amazon token sent to S3");
    const lines = [
      "seller-sku\tstatus\tasin1",
      "SN-001\tActive\tB0001",
      "SN-002\tInactive\tB0002",
      (duplicate ? "SN-001" : "SN-003") + "\tActive\tB0003",
      ""
    ].join("\n");
    return new Response(lines, { status: 200 });
  };
  const denied = await handleAmazonReadonlyRequest(new Request(base + "IT"), env);
  assert.equal(denied.status, 401);
  assert.equal(calls, 0);
  const headers = { Authorization: "Bearer admin" };
  assert.equal((await handleAmazonReadonlyRequest(new Request(base + "XX", { headers }), env)).status, 400);
  assert.equal(calls, 0);
  const ok = await handleAmazonReadonlyRequest(new Request(base + "IT", { headers }), env);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.read_only, true);
  assert.equal(body.result.rows, 3);
  assert.equal(body.result.unique_skus, 3);
  assert.equal(body.result.active, 2);
  assert.equal(body.result.inactive, 1);
  assert.equal(body.result.snapshot_complete, true);
  assert.equal(body.result.safe_for_missing_sku_classification, true);
  assert(!JSON.stringify(body).includes("private-document-id"));
  assert(!JSON.stringify(body).includes("X-Amz-Signature"));
  assert(!JSON.stringify(body).includes("SN-001"), "Do not expose raw offer SKUs in summary");
  stale = true;
  const oldReport = await handleAmazonReadonlyRequest(new Request(base + "IT", { headers }), env);
  assert.equal((await oldReport.json()).result.safe_for_missing_sku_classification, false);
  stale = false;
  duplicate = true;
  const duplicateReport = await handleAmazonReadonlyRequest(new Request(base + "IT", { headers }), env);
  assert.equal((await duplicateReport.json()).result.safe_for_missing_sku_classification, false);
  console.log("Amazon full listing report summary read-only tests passed");
} finally { globalThis.fetch = originalFetch; }
