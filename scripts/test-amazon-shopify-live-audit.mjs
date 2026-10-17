import assert from "node:assert/strict";
import { auditShopifyAgainstAmazon } from "./amazon-shopify-live-audit.mjs";

const bearer = "mock-only-private-admin-secret";
const markets = ["IT", "DE", "FR", "ES"];
async function amazonReader(market, index) {
  if (market === "IT") { index.set("SN-001", "ACTIVE"); index.set("DUP", "INACTIVE"); }
  if (market === "DE") { index.set("SN-001", "INACTIVE"); }
  if (market === "FR") { index.set("SN-001", "ACTIVE"); }
  const safe = market !== "FR";
  return { ok: true, safe_for_missing_sku_classification: safe,
    unique_skus: index.size, duplicate_sku_rows: 0, active: market === "IT" ? 1 : 0,
    inactive: market === "DE" ? 1 : 0, report_created_at: "2026-10-17T15:00:00Z",
    error_code: null };
}
const chunks = [
  { ok: true, read_only: true, source: "shopify_live", sort_key: "ID",
    products_scanned: 2, variants_scanned: 4, eligible_count: 3,
    excluded: { p448: 1, not_active: 0, no_stock: 0, blank_sku: 0 },
    has_more: true, next_cursor: "CUR2",
    eligible_variants: [
      { sku: "SN-001", vendor: "Nike", product_type: "Sneakers", inventory_quantity: 3,
        product_id: "p1", variant_id: "v1" },
      { sku: "DUP", vendor: "Nike", product_type: "Sneakers", inventory_quantity: 1,
        product_id: "p2", variant_id: "v2" },
      { sku: "sn-001", vendor: "K-Way", product_type: "Giubbotti", inventory_quantity: 2,
        product_id: "p3", variant_id: "v3" }
    ] },
  { ok: true, read_only: true, source: "shopify_live", sort_key: "ID",
    products_scanned: 1, variants_scanned: 1, eligible_count: 1,
    excluded: { p448: 0, not_active: 0, no_stock: 0, blank_sku: 0 },
    has_more: false, next_cursor: null,
    eligible_variants: [
      { sku: "DUP", vendor: "Nike", product_type: "Sneakers", inventory_quantity: 3,
        product_id: "p4", variant_id: "v4" }
    ] }
];
let pagesCalled = 0;
async function shopifyFetch(url, options) {
  assert.equal(options.method, "GET");
  assert.equal(options.headers.Authorization, "Bearer " + bearer);
  const cursor = new URL(url).searchParams.get("after");
  assert.equal(cursor, pagesCalled === 0 ? null : "CUR2");
  return new Response(JSON.stringify(chunks[pagesCalled++]), { status: 200 });
}
const result = await auditShopifyAgainstAmazon({ bearer, amazonReader, shopifyFetch });
assert.equal(result.read_only, true);
assert.equal(result.complete, false, "FR is unverified so never mark all-country comparison complete");
assert.equal(result.shopify.complete, true);
assert.equal(result.shopify.pages_scanned, 2);
assert.equal(result.shopify.eligible_variants, 4);
assert.equal(result.shopify.eligible_unique_skus, 3);
assert.equal(result.shopify.ambiguous_duplicate_variant_rows, 2);
assert.equal(result.shopify.excluded.p448, 1);
assert.equal(result.amazon.FR.compare_ready, false);
assert.equal(result.results.markets.IT.PRESENT_ACTIVE, 1);
assert.equal(result.results.markets.DE.PRESENT_INACTIVE, 1);
assert.equal(result.results.markets.IT.NOT_FOUND_IN_AMAZON_REPORT, 1);
assert.equal(result.results.markets.FR.UNVERIFIED, 2);
assert.equal(result.results.markets.ES.NOT_FOUND_IN_AMAZON_REPORT, 2);
assert.equal(result.results.markets.IT.DUPLICATE_SHOPIFY_SKU, 2);
assert.equal(result.results.by_category.find(x => x.label === "Sneakers").eligible_variants, 3);
assert.equal(pagesCalled, 2);
const serialized = JSON.stringify(result);
for (const secret of [bearer, "SN-001", "sn-001", "DUP"]) {
  assert(!serialized.includes(secret), "Never persist authentication or raw seller SKUs");
}
console.log("Amazon vs Shopify four-market aggregate reconciliation tests passed");
