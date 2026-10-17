import assert from "node:assert/strict";
import { probeAmazonCatalogEAN } from "./amazon-catalog-ean-smoke.mjs";

const token = "private-admin-bearer-mock";
const ean = "8051689217366";
const sku = "PRIVATE-EXACT-SKU";
let calls = 0;
async function fakeFetch(target, init) {
  calls++;
  assert.equal(init.method, "GET");
  assert.equal(init.headers.Authorization, "Bearer " + token);
  const url = new URL(String(target));
  if (url.pathname.endsWith("/shopify-eligible-page")) {
    return new Response(JSON.stringify({ ok: true, read_only: true, has_more: false,
      eligible_variants: [{ sku, barcode: ean, vendor: "K-Way",
        product_type: "Giacche e cappotti", inventory_quantity: 2 }] }), { status: 200 });
  }
  assert.equal(url.pathname, "/internal/amazon/catalog-ean");
  assert.equal(url.searchParams.get("ean"), ean);
  assert(["IT","DE","FR","ES"].includes(url.searchParams.get("marketplace")));
  return new Response(JSON.stringify({ ok: true, read_only: true,
    result: { catalog_candidates: 1, exact_ean_matches: 1 } }), { status: 200 });
}
const r = await probeAmazonCatalogEAN({ token, fetchImpl: fakeFetch, delayMs: 0 });
assert.equal(r.complete, true);
assert.equal(r.valid_ean_checksum, true);
assert.equal(r.sample_category, "Giacche e cappotti");
assert.equal(r.sample_vendor, "K-Way");
assert.equal(Object.keys(r.markets).length, 4);
assert.equal(r.markets.IT.catalog_candidates, 1);
assert.equal(r.markets.ES.exact_ean_matches, 1);
assert.equal(calls, 5);
const receipt = JSON.stringify(r);
assert(!receipt.includes(sku));
assert(!receipt.includes(ean));
assert(!receipt.includes(token));
console.log("Amazon EAN catalog four-market sanitized live probe tests passed");
