import assert from "node:assert/strict";
import { runFullKWayCoatsEAN } from "./amazon-kway-coats-full-ean.mjs";

const bearer = "private-test-access-token";
const makeEAN = value => {
  const prefix = String(value).padStart(12, "0");
  const sum = [...prefix].reduce((s,d,i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return prefix + ((10 - sum % 10) % 10);
};
const rows = Array.from({ length: 20 }, (_, i) => ({
  sku: "FULL-PRIVATE-" + String(i).padStart(3, "0"),
  barcode: makeEAN(805168921730 + i),
  vendor: "K-Way", product_type: "Giacche e cappotti",
  inventory_quantity: 2
}));
rows.push({ sku: "INVALID-EAN-SKU", barcode: "NOT_AN_EAN",
  vendor: "K-Way", product_type: "Giacche e cappotti" });
rows.push({ sku: "SHARED-EAN-SECOND", barcode: rows[0].barcode,
  vendor: "K-Way", product_type: "Giacche e cappotti" });
rows.push({ sku: "DUPLICATE-SKU", barcode: makeEAN(805168921780),
  vendor: "K-Way", product_type: "Giacche e cappotti" });
rows.push({ sku: "DUPLICATE-SKU", barcode: makeEAN(805168921781),
  vendor: "K-Way", product_type: "Giacche e cappotti" });
rows.push({ sku: "OTHER-BRAND-COAT", barcode: makeEAN(805168921789),
  vendor: "Ecoalf", product_type: "Giacche e cappotti" });
rows.push({ sku: "KWAY-SNEAKER", barcode: makeEAN(805168921790),
  vendor: "K-Way", product_type: "Sneakers" });
let lookups = 0, forceThrottle = false;

async function auditFn({ bearer: auth, onPrivateSnapshot }) {
  assert.equal(auth, bearer);
  onPrivateSnapshot({ rows, amazonIndexes: {
    IT: new Map(), DE: new Map(), FR: new Map(), ES: new Map()
  } });
  return {
    complete: true, generated_at: "2026-10-17T19:00:00Z",
    shopify: { complete: true, eligible_variants: rows.length },
    amazon: Object.fromEntries(["IT","DE","FR","ES"].map(m => [m, { compare_ready: true }]))
  };
}
async function lookup({ market, selected, bearer: secret }) {
  lookups++;
  assert.equal(secret, bearer);
  assert(["IT","DE","FR","ES"].includes(market));
  assert(selected.length <= 8 && selected.length >= 1);
  if (forceThrottle) {
    return { ok: false, http_status: 502, error_code: "amazon_catalog_batch_http_429" };
  }
  const states = selected.map((_, i) => i === 0 ? "EXACT_ONE" : "NO_EXACT_MATCH");
  return { ok: true, http_status: 200, pages_read: 1,
    entries: selected.map((row,i) => ({ ean: row.barcode, state: states[i] })) };
}
const report = await runFullKWayCoatsEAN({ bearer, auditFn, lookup, delayMs: 0 });
assert.equal(report.read_only, true);
assert.equal(report.no_listing_writes, true);
assert.equal(report.audit_complete, true);
assert.equal(report.overall_complete, true);
assert.equal(report.results_are_full_snapshot, true);
assert.equal(report.kway_coat_duplicate_sku_variants_quarantined, 2);
assert.equal(report.kway_coat_eligible_nonduplicate_variants, 22);
assert.equal(lookups, 12);
for (const market of ["IT", "DE", "FR", "ES"]) {
  const x = report.markets[market];
  assert.equal(x.status, "COMPLETE");
  assert.equal(x.missing_kway_coat_variants, 22);
  assert.equal(x.missing_with_valid_ean, 21);
  assert.equal(x.missing_without_valid_ean, 1);
  assert.equal(x.duplicate_ean_rows_quarantined, 2);
  assert.equal(x.eligible_eans_to_search, 19);
  assert.equal(x.sampled_eans, 19);
  assert.equal(x.groups_planned, 3);
  assert.equal(x.groups_completed, 3);
  assert.equal(x.matching.EXACT_ONE, 3);
  assert.equal(x.matching.NO_EXACT_MATCH, 16);
  assert.equal(x.by_vendor.reduce((s,v)=>s+v.searched,0), 19);
}
const output = JSON.stringify(report);
for (const unsafe of [bearer, ...rows.map(x=>x.sku), ...rows.map(x=>x.barcode)]) {
  if (unsafe === "NOT_AN_EAN") continue;
  assert(!output.includes(unsafe), "No SKU/EAN/bearer may persist");
}
forceThrottle = true;lookups = 0;
const incomplete = await runFullKWayCoatsEAN({
  bearer, auditFn, lookup, delayMs: 0
});
assert.equal(incomplete.overall_complete, false);
assert.equal(incomplete.results_are_full_snapshot, false);
assert.equal(incomplete.error_code, "amazon_kway_coat_full_scan_throttled");
assert.equal(incomplete.markets.IT.status, "PARTIAL");
assert.equal(incomplete.markets.DE.status, "SKIPPED_AFTER_THROTTLE");
assert.equal(incomplete.markets.IT.sampled_eans, 0);
assert.equal(lookups, 1);
const noToken = await runFullKWayCoatsEAN({ bearer: "", auditFn, lookup });
assert.equal(noToken.overall_complete, false);
assert.equal(noToken.error_code, "amazon_kway_coat_full_scan_bearer_missing");
console.log("Amazon full 4-market K-Way COAT EAN catalog reconciliation tests passed");
