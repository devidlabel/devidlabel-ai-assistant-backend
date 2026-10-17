import assert from "node:assert/strict";
import { runSneakerBatchedEANPilot } from "./amazon-sneakers-batched-ean.mjs";
import { sampleDiverseByVendor } from "./amazon-sneakers-catalog-pilot.mjs";

const bearer = "mock-bearer-is-private";
function makeEAN(n) {
  const prefix = String(n).padStart(12, "0");
  const sum = [...prefix].reduce((s,d,i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return prefix + ((10 - sum % 10) % 10);
}
const rows = Array.from({ length: 20 }, (_, i) => ({
  sku: "SNEAKER-PRIVATE-" + i,
  barcode: makeEAN(805168921731 + i),
  vendor: "Brand " + String(i % 10).padStart(2, "0"),
  product_type: "Sneakers",
  inventory_quantity: 3
}));
async function auditFn({ bearer: pass, onPrivateSnapshot }) {
  assert.equal(pass, bearer);
  onPrivateSnapshot({ rows, amazonIndexes: {
    IT: new Map(), DE: new Map(), FR: new Map(), ES: new Map()
  } });
  return {
    complete: true, shopify: { complete: true, eligible_variants: 20 },
    generated_at: "2026-10-17T18:00:00Z",
    amazon: { IT: { compare_ready: true }, DE: { compare_ready: true },
      FR: { compare_ready: true }, ES: { compare_ready: true } }
  };
}
let calls = 0, failed = false, temporarilyUnavailable = 0;
async function fetchImpl(url, opts) {
  calls++;
  const parsed = new URL(String(url));
  assert.equal(parsed.pathname, "/internal/amazon/catalog-eans");
  assert.equal(opts.method, "GET");
  assert.equal(opts.headers.Authorization, "Bearer " + bearer);
  const marketplace = parsed.searchParams.get("marketplace");
  assert(["IT", "DE", "FR", "ES"].includes(marketplace));
  const eans = parsed.searchParams.get("eans").split(",");
  assert.equal(eans.length, 8);
  assert.equal(new Set(eans).size, 8);
  const previous = sampleDiverseByVendor(rows, 8).map(item => item.barcode);
  assert(eans.every(ean => !previous.includes(ean)), "Do not recheck first 8 sample EANs");
  if (temporarilyUnavailable > 0) {
    temporarilyUnavailable--;
    return new Response("Old Worker route not found", { status: 404 });
  }
  if (failed) return new Response(JSON.stringify({
    ok: false, error: "amazon_catalog_batch_http_429"
  }), { status: 502 });

  const states = ["EXACT_ONE","EXACT_MULTIPLE","NO_EXACT_MATCH","UNVERIFIED",
    "EXACT_ONE","NO_EXACT_MATCH","NO_EXACT_MATCH","UNVERIFIED"];
  const identifiers = eans.map((ean,i) => {
    const count = states[i] === "EXACT_ONE" ? 1 : states[i] === "EXACT_MULTIPLE" ? 2 : 0;
    return {
      ean, state: states[i], exact_match_count: count,
      asins: Array.from({ length: count }, (_, n) => "B00000000" + (n+1))
    };
  });
  return new Response(JSON.stringify({ ok: true, read_only: true, result: {
    read_only: true, complete: true, marketplace, pages_read: 2,
    identifiers_count: eans.length, identifiers
  } }), { status: 200 });
}
const report = await runSneakerBatchedEANPilot({
  bearer, auditFn, fetchImpl, delayMs: 0, sampleOffset: 8, batchSize: 8
});
assert.equal(report.read_only, true);
assert.equal(report.overall_complete, true);
assert.equal(report.audit_complete, true);
assert.equal(report.samples_are_not_catalog_total, true);
assert.equal(report.sneaker_eligible_nonduplicate_variants, 20);
assert.equal(calls, 4);
for (const market of ["IT","DE","FR","ES"]) {
  const entry = report.markets[market];
  assert.equal(entry.status, "SAMPLE_COMPLETE");
  assert.equal(entry.sampled, 8);
  assert.equal(entry.catalog_pages_read, 2);
  assert.deepEqual(entry.matching, {
    EXACT_ONE: 2, EXACT_MULTIPLE: 1, NO_EXACT_MATCH: 3, UNVERIFIED: 2
  });
  assert.equal(entry.candidates_for_safe_lookup, 20);
  assert.equal(entry.by_vendor.reduce((sum,v)=>sum+v.sampled,0),8);
}
const text = JSON.stringify(report);
for (const secret of [bearer, ...rows.map(r=>r.sku), ...rows.map(r=>r.barcode), "B000000001"]) {
  assert(!text.includes(secret), "No SKU/EAN/ASIN or token may be logged or persisted");
}
temporarilyUnavailable = 2;
calls = 0;
const recovered = await runSneakerBatchedEANPilot({
  bearer, auditFn, fetchImpl, delayMs: 0, endpointRetryMs: 0,
  sampleOffset: 8, batchSize: 8
});
assert.equal(recovered.overall_complete, true);
assert.equal(recovered.markets.IT.status, "SAMPLE_COMPLETE");
assert.equal(calls, 6, "Exactly two transient 404 responses should be retried");
temporarilyUnavailable = 30;
calls = 0;
const notDeployed = await runSneakerBatchedEANPilot({
  bearer, auditFn, fetchImpl, delayMs: 0, endpointRetryMs: 0
});
assert.equal(notDeployed.overall_complete, false);
assert.equal(notDeployed.markets.IT.http_status, 404);
assert.equal(notDeployed.markets.IT.error_code, "amazon_batch_pilot_endpoint_not_ready");
assert.equal(notDeployed.markets.IT.sampled, 0);
assert.equal(notDeployed.markets.IT.matching.NO_EXACT_MATCH, 0);
temporarilyUnavailable = 0;
failed = true;
calls = 0;
const throttled = await runSneakerBatchedEANPilot({
  bearer, auditFn, fetchImpl, delayMs: 0, sampleOffset: 8, batchSize: 8
});
assert.equal(throttled.overall_complete, false);
assert.equal(throttled.error_code, "amazon_batch_pilot_throttled");
assert.equal(throttled.markets.IT.status, "LOOKUP_UNVERIFIED");
assert.equal(throttled.markets.DE.status, "SKIPPED_AFTER_THROTTLE");
assert.equal(calls, 1);
assert.equal((await runSneakerBatchedEANPilot({ bearer: "", auditFn, fetchImpl })).overall_complete, false);
console.log("Amazon batched eight-EAN-per-market live pilot controls passed");
