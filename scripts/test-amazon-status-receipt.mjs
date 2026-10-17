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
    if (String(url).startsWith("https://seller-reports.s3.amazonaws.com/")) {
      assert.equal(init.headers.Authorization, undefined, "Never forward the Worker bearer to S3");
      assert.equal(init.redirect, "error");
      const market = new URL(String(url)).pathname.split("/")[1];
      const data = ["seller-sku\tstatus", ...Array.from({ length: 125 }, (_, i) =>
        "SKU-" + market + "-" + i + "\t" + (i < 120 ? "Active" : "Inactive")), ""].join("\n");
      return new Response(data, { status: 200, headers: { "content-length": String(Buffer.byteLength(data)) } });
    }
    assert.equal(init.headers.Authorization, "Bearer " + secret);
    if (String(url).endsWith("/marketplaces")) {
      return new Response(JSON.stringify({
        ok: true, read_only: true,
        result: { payload: ids.map(id => ({ marketplace: { id } })) }
      }), { status: 200 });
    }
    if (String(url).includes("/report-link?marketplace=")) {
      assert.equal(init.redirect, "manual");
      const market = new URL(String(url)).searchParams.get("marketplace");
      return new Response(null, { status: 307, headers: {
        Location: "https://seller-reports.s3.amazonaws.com/" + market + "/report?X-Amz-Signature=do-not-log",
        "X-Amazon-Report-Marketplace": market,
        "X-Amazon-Report-Type": "GET_MERCHANT_LISTINGS_ALL_DATA",
        "X-Amazon-Report-Compression": "NONE",
        "X-Amazon-Report-Created-At": new Date().toISOString()
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
    assert.equal(receipt.reports[market].metadata_check_skipped, true);
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
