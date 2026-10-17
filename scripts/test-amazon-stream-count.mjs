import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { summarizeAmazonReportStream } from "./amazon-stream-count.mjs";

const bearer = "mock-secret-never-in-report";
const raw = "seller-sku\tstatus\nA-1\tActive\nA-2\tInactive\n";
function mock(data, compression, old = false) {
  return async (url, init) => {
    assert(String(url).endsWith("/report-stream?marketplace=IT"));
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, "Bearer " + bearer);
    return new Response(data, { status: 200, headers: {
      "X-Amazon-Report-Marketplace": "IT",
      "X-Amazon-Report-Type": "GET_MERCHANT_LISTINGS_ALL_DATA",
      "X-Amazon-Report-Compression": compression,
      "X-Amazon-Report-Raw-Length": String(data.byteLength ?? Buffer.byteLength(data)),
      "X-Amazon-Report-Created-At": new Date(Date.now() - (old ? 72 : 1) * 3600000).toISOString()
    } });
  };
}
const plain = await summarizeAmazonReportStream("IT", bearer, mock(raw, "NONE"));
assert.equal(plain.ok, true);
assert.equal(plain.unique_skus, 2);
assert.equal(plain.active, 1);
assert.equal(plain.inactive, 1);
assert.equal(plain.safe_for_missing_sku_classification, true);
const compressed = gzipSync(raw);
const gzip = await summarizeAmazonReportStream("IT", bearer, mock(compressed, "GZIP"));
assert.equal(gzip.ok, true);
assert.equal(gzip.unique_skus, 2);
assert.equal(gzip.compression_verified, true);
const stale = await summarizeAmazonReportStream("IT", bearer, mock(raw, "NONE", true));
assert.equal(stale.ok, true);
assert.equal(stale.safe_for_missing_sku_classification, false);
const duplicates = await summarizeAmazonReportStream("IT", bearer, mock("seller-sku\tstatus\nA-1\tActive\nA-1\tInactive\n", "NONE"));
assert.equal(duplicates.duplicate_sku_rows, 1);
assert.equal(duplicates.safe_for_missing_sku_classification, false);
const invalid = await summarizeAmazonReportStream("XX", bearer, mock(raw, "NONE"));
assert.equal(invalid.ok, false);
assert.equal(invalid.error_code, "amazon_stream_invalid_marketplace");
const networkFailure = await summarizeAmazonReportStream("IT", bearer, async () => {
  throw new Error("Sensitive signed URL: https://example.com?X-Amz-Signature=private");
});
assert.equal(networkFailure.ok, false);
assert.equal(networkFailure.error_code, "amazon_stream_analysis_error");
for (const item of [plain, gzip, stale, duplicates, invalid, networkFailure]) {
  assert(!JSON.stringify(item).includes(bearer));
  assert(!JSON.stringify(item).includes("X-Amz-Signature"));
  assert(!JSON.stringify(item).includes("A-1"));
}
console.log("Amazon GitHub streaming SKU aggregate tests passed");
