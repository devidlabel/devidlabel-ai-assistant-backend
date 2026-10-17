import assert from "node:assert/strict";
import fs from "node:fs";
const secret = "test-only-admin-secret";
process.env.DAILY_PULSE_ACCESS_TOKEN = secret;
const original = globalThis.fetch;
const ids = ["APJ6JRA9NG5V4", "A1PA6795UKMFR9", "A13V1IB3VIYZZH", "A1RKKUPIHCS9HS"];
let calls = 0;
try {
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, "Bearer " + secret);
    if (String(url).endsWith("/marketplaces")) {
      return new Response(JSON.stringify({
        ok: true, read_only: true,
        result: { payload: ids.map(id => ({ marketplace: { id } })) }
      }), { status: 200 });
    }
    if (String(url).includes("/report-stream?marketplace=")) {
      const market = new URL(String(url)).searchParams.get("marketplace");
      const data = ["seller-sku\\tstatus", ...Array.from({ length: 125 }, (_, i) =>
        "SKU-" + market + "-" + i + "\\t" + (i < 120 ? "Active" : "Inactive")), ""].join("\\n");
      return new Response(data, { status: 200, headers: {
        "X-Amazon-Report-Marketplace": market,
        "X-Amazon-Report-Type": "GET_MERCHANT_LISTINGS_ALL_DATA",
        "X-Amazon-Report-Compression": "NONE",
        "X-Amazon-Report-Created-At": new Date().toISOString(),
        "X-Amazon-Report-Raw-Length": String(Buffer.byteLength(data))
      } });
    }
    assert(String(url).includes("/listing-reports?marketplace="));
    return new Response(JSON.stringify({
      ok: true, read_only: true,
      result: { reports: [{ processingStatus: "DONE", reportDocumentAvailable: true }], has_more: false }
    }), { status: 200 });
  };
  await import("./amazon-status-receipt.mjs");
  const json = fs.readFileSync("/tmp/amazon-eu-status-receipt.json", "utf8");
  const receipt = JSON.parse(json);
  assert.equal(receipt.complete, true);
  assert.equal(receipt.no_listing_writes, true);
  assert.equal(receipt.marketplaces.account_marketplace_count, 4);
  for (const market of ["IT", "DE", "FR", "ES"]) {
    assert.equal(receipt.reports[market].ok, true);
    assert.equal(receipt.reports[market].done_documents_available, 1);
    assert.equal(receipt.listing_summaries[market].unique_skus, 125);
    assert.equal(receipt.listing_summaries[market].active, 120);
    assert.equal(receipt.listing_summaries[market].safe_for_missing_sku_classification, true);
  }
  assert.equal(calls, 9);
  assert(!json.includes(secret), "Never leak the bearer token into receipt");
  console.log("Amazon sanitized status receipt tests passed");
} finally {
  globalThis.fetch = original;
}
