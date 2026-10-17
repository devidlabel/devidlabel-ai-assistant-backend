import assert from "node:assert/strict";
import { runStage4Sneakers } from "./amazon-sneakers-stage4.mjs";
import { sampleDiverseByVendor } from "./amazon-sneakers-catalog-pilot.mjs";

const bearer = "strictly-private-test-token";
const makeEAN = base => {
  const digits = String(base).padStart(12, "0");
  const sum = [...digits].reduce((s,d,i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return digits + ((10 - sum % 10) % 10);
};
const rows = Array.from({ length: 45 }, (_, i) => ({
  sku: "SECRET-SKU-" + String(i).padStart(3, "0"),
  barcode: makeEAN(805168921730 + i), product_type: "Sneakers",
  vendor: "Brand " + String(i % 10).padStart(2,"0"),
  inventory_quantity: 2
}));
async function auditFn({ bearer: auth, onPrivateSnapshot }) {
  assert.equal(auth, bearer);
  onPrivateSnapshot({ rows, amazonIndexes: {
    IT: new Map(), DE: new Map(), FR: new Map(), ES: new Map()
  } });
  return {
    complete: true, generated_at: "2026-10-17T17:00:00Z",
    shopify: { complete: true, eligible_variants: 45 },
    amazon: Object.fromEntries(["IT","DE","FR","ES"].map(m => [m, { compare_ready: true }]))
  };
}
let called = 0, simulateThrottle = false;
async function lookup({ market, selected, bearer: secret, endpointRetryMs }) {
  called++;
  assert.equal(secret, bearer);
  assert(["IT","DE","FR","ES"].includes(market));
  assert.equal(selected.length, 8);
  assert.equal(endpointRetryMs, 5000);
  const first16 = new Set(sampleDiverseByVendor(rows, 16).map(row => row.barcode));
  assert(selected.every(row => !first16.has(row.barcode)));
  if (simulateThrottle) return { ok: false, http_status: 502, error_code: "amazon_catalog_batch_http_429" };
  const states = ["EXACT_ONE", "EXACT_ONE", "EXACT_MULTIPLE",
    "NO_EXACT_MATCH","NO_EXACT_MATCH","NO_EXACT_MATCH","NO_EXACT_MATCH","NO_EXACT_MATCH"];
  return {
    ok: true, http_status: 200, pages_read: 2,
    entries: selected.map((row,i) => ({ ean: row.barcode, state: states[i] }))
  };
}
const report = await runStage4Sneakers({ bearer, auditFn, lookup, delayMs: 0 });
assert.equal(report.read_only, true);
assert.equal(report.no_listing_writes, true);
assert.equal(report.audit_complete, true);
assert.equal(report.overall_complete, true);
assert.equal(report.start_offset, 16);
assert.equal(report.target_per_market, 24);
assert.equal(called, 12, "Four markets with three eight-EAN batches each");
for (const market of ["IT","DE","FR","ES"]) {
  const info = report.markets[market];
  assert.equal(info.status, "COMPLETE");
  assert.equal(info.planned, 24);
  assert.equal(info.sampled, 24);
  assert.equal(info.groups_completed, 3);
  assert.equal(info.catalog_pages_read, 6);
  assert.equal(info.matching.EXACT_ONE, 6);
  assert.equal(info.matching.EXACT_MULTIPLE, 3);
  assert.equal(info.matching.NO_EXACT_MATCH, 15);
  assert.equal(info.by_vendor.reduce((sum,item) => sum + item.sampled,0),24);
}
const published = JSON.stringify(report);
for (const secret of [bearer, ...rows.map(r=>r.sku), ...rows.map(r=>r.barcode)]) {
  assert(!published.includes(secret), "No SKU/EAN/token may appear in receipt");
}
simulateThrottle = true;called = 0;
const stopped = await runStage4Sneakers({ bearer, auditFn, lookup, delayMs: 0 });
assert.equal(stopped.overall_complete, false);
assert.equal(stopped.error_code, "amazon_sneakers_stage4_throttled");
assert.equal(called, 1);
assert.equal(stopped.markets.IT.status, "PARTIAL");
assert.equal(stopped.markets.DE.status, "SKIPPED_AFTER_THROTTLE");
assert.equal(stopped.markets.IT.matching.NO_EXACT_MATCH, 0);
const noBearer = await runStage4Sneakers({ bearer: "", auditFn, lookup, delayMs: 0 });
assert.equal(noBearer.audit_complete, false);
assert.equal(noBearer.error_code, "amazon_sneakers_stage4_bearer_missing");
console.log("Amazon sneakers stage4 24-EAN per-market batch and throttle tests passed");
