import assert from "node:assert/strict";
import { runFullBackpacksUPC } from "./amazon-backpacks-full-upc.mjs";

const bearer = "private-test-access-token";
const makeUPC = value => {
  const prefix = String(value).padStart(11, "0");
  const sum = [...prefix].reduce((s,d,i) => s + Number(d) * (i % 2 ? 1 : 3), 0);
  return prefix + ((10 - sum % 10) % 10);
};
const rows = Array.from({ length: 20 }, (_, i) => ({
  sku: "FULL-PRIVATE-" + String(i).padStart(3, "0"),
  barcode: makeUPC(80516892173 + i),
  vendor: i % 2 === 0 ? "Sprayground" : "K-Way", product_type: "Zaini",
  inventory_quantity: 2
}));
rows.push({ sku: "INVALID-UPC-SKU", barcode: "NOT_AN_UPC",
  vendor: "Sprayground", product_type: "Zaini" });
rows.push({ sku: "SHARED-UPC-SECOND", barcode: rows[0].barcode,
  vendor: "Sprayground", product_type: "Zaini" });
rows.push({ sku: "DUPLICATE-SKU", barcode: makeUPC(80516892230),
  vendor: "Sprayground", product_type: "Zaini" });
rows.push({ sku: "DUPLICATE-SKU", barcode: makeUPC(80516892231),
  vendor: "Sprayground", product_type: "Zaini" });
rows.push({ sku: "OTHER-BRAND-COAT", barcode: makeUPC(80516892239),
  vendor: "Ecoalf", product_type: "Giacche e cappotti" });
rows.push({ sku: "KWAY-SNEAKER", barcode: makeUPC(80516892240),
  vendor: "Sprayground", product_type: "Sneakers" });
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
    entries: selected.map((row,i) => ({ upc: row.barcode, state: states[i] })) };
}
const report = await runFullBackpacksUPC({ bearer, auditFn, lookup, delayMs: 0 });
assert.equal(report.read_only, true);
assert.equal(report.no_listing_writes, true);
assert.equal(report.audit_complete, true);
assert.equal(report.overall_complete, true);
assert.equal(report.results_are_full_snapshot, true);
assert.equal(report.backpack_duplicate_sku_variants_quarantined, 2);
assert.equal(report.backpack_eligible_nonduplicate_variants, 22);
assert.equal(lookups, 12);
for (const market of ["IT", "DE", "FR", "ES"]) {
  const x = report.markets[market];
  assert.equal(x.status, "COMPLETE");
  assert.equal(x.missing_backpack_variants, 22);
  assert.equal(x.missing_with_valid_upc, 21);
  assert.equal(x.missing_without_valid_upc, 1);
  assert.equal(x.duplicate_upc_rows_quarantined, 2);
  assert.equal(x.eligible_upcs_to_search, 19);
  assert.equal(x.sampled_upcs, 19);
  assert.equal(x.groups_planned, 3);
  assert.equal(x.groups_completed, 3);
  assert.equal(x.matching.EXACT_ONE, 3);
  assert.equal(x.matching.NO_EXACT_MATCH, 16);
  assert.equal(x.by_vendor.reduce((s,v)=>s+v.searched,0), 19);
}
const output = JSON.stringify(report);
for (const unsafe of [bearer, ...rows.map(x=>x.sku), ...rows.map(x=>x.barcode)]) {
  if (unsafe === "NOT_AN_UPC") continue;
  assert(!output.includes(unsafe), "No SKU/UPC/bearer may persist");
}
forceThrottle = true;lookups = 0;
const incomplete = await runFullBackpacksUPC({
  bearer, auditFn, lookup, delayMs: 0
});
assert.equal(incomplete.overall_complete, false);
assert.equal(incomplete.results_are_full_snapshot, false);
assert.equal(incomplete.error_code, "amazon_backpack_full_upc_throttled");
assert.equal(incomplete.markets.IT.status, "PARTIAL");
assert.equal(incomplete.markets.DE.status, "SKIPPED_AFTER_THROTTLE");
assert.equal(incomplete.markets.IT.sampled_upcs, 0);
assert.equal(lookups, 1);
const noToken = await runFullBackpacksUPC({ bearer: "", auditFn, lookup });
assert.equal(noToken.overall_complete, false);
assert.equal(noToken.error_code, "amazon_backpack_full_upc_bearer_missing");
console.log("Amazon full 4-market Zaini UPC catalog reconciliation tests passed");
