import assert from "node:assert/strict";
import { runSneakerCatalogPilot } from "./amazon-sneakers-catalog-pilot.mjs";

const token = "private-test-bearer-never-disclose";
function makeEan(base) {
  const n = String(base).padStart(12, "0");
  const sum = [...n].reduce((total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1), 0);
  return n + ((10 - sum % 10) % 10);
}
const eans = Array.from({ length: 9 }, (_, i) => makeEan(805168921731 + i));
const rows = [
  { sku: "SNEAKER-A", barcode: eans[0], vendor: "Alpha", product_type: "Sneakers" },
  { sku: "SNEAKER-B", barcode: eans[1], vendor: "Beta", product_type: "Sneakers" },
  { sku: "SNEAKER-C", barcode: eans[2], vendor: "Gamma", product_type: "Sneakers" },
  { sku: "SNEAKER-D", barcode: eans[3], vendor: "Delta", product_type: "Sneakers" },
  { sku: "SNEAKER-E", barcode: eans[4], vendor: "Epsilon", product_type: "Sneakers" },
  { sku: "SNEAKER-BAD-EAN", barcode: "invalid", vendor: "Zeta", product_type: "Sneakers" },
  { sku: "SNEAKER-SHARED-ONE", barcode: eans[5], vendor: "Eta", product_type: "Sneakers" },
  { sku: "SNEAKER-SHARED-TWO", barcode: eans[5], vendor: "Theta", product_type: "Sneakers" },
  { sku: "SNEAKER-DUP", barcode: eans[6], vendor: "Iota", product_type: "Sneakers" },
  { sku: "SNEAKER-DUP", barcode: eans[7], vendor: "Iota", product_type: "Sneakers" },
  { sku: "EXISTING-IT", barcode: eans[8], vendor: "Alpha", product_type: "Sneakers" },
  { sku: "COAT-A", barcode: eans[8], vendor: "K-Way", product_type: "Giacche e cappotti" }
];
let auditCalls = 0, catalogCalls = 0, responseError = false, throttle = false;
async function auditFn({ bearer, onPrivateSnapshot }) {
  assert.equal(bearer, token);
  auditCalls++;
  onPrivateSnapshot({
    rows,
    amazonIndexes: {
      IT: new Map([["EXISTING-IT", "ACTIVE"]]),
      DE: new Map(), FR: new Map(), ES: new Map()
    }
  });
  return { complete: true, generated_at: "2026-10-17T16:00:00Z",
    shopify: { complete: true, eligible_variants: rows.length },
    amazon: { IT: { compare_ready: true }, DE: { compare_ready: true },
      FR: { compare_ready: true }, ES: { compare_ready: true } } };
}
async function fetchImpl(url, options) {
  catalogCalls++;
  assert.equal(options.method, "GET");
  assert.equal(options.headers.Authorization, "Bearer " + token);
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/internal/amazon/catalog-ean");
  const ean = parsed.searchParams.get("ean");
  const market = parsed.searchParams.get("marketplace");
  assert(["IT", "DE", "FR", "ES"].includes(market));
  assert(eans.includes(ean));
  if (throttle) return new Response(JSON.stringify({ ok: false, error: "amazon_catalog_http_429" }), { status: 502 });
  if (responseError) return new Response(JSON.stringify({ ok: false, error: "amazon_catalog_http_500" }), { status: 502 });
  const n = eans.indexOf(ean);
  const count = n === 0 ? 1 : n === 1 ? 0 : n === 2 ? 2 : 1;
  const candidates = Array.from({ length: count }, (_, i) =>
    ({ asin: "B0MOCK" + String(i).padStart(4, "0"), ean_confirmed: true }));
  return new Response(JSON.stringify({ ok: true, read_only: true, result: {
    marketplace: market, catalog_candidates: count, exact_ean_matches: count, candidates
  } }), { status: 200 });
}
const report = await runSneakerCatalogPilot({ bearer: token, auditFn, fetchImpl, delayMs: 0, limitPerMarket: 4 });
assert.equal(report.overall_complete, true);
assert.equal(report.read_only, true);
assert.equal(report.no_listing_writes, true);
assert.equal(report.counts_are_sample_only, true);
assert.equal(report.sneaker_eligible_nonduplicate_variants, 9);
assert.equal(report.sneaker_ambiguous_sku_variants, 2);
assert.equal(report.markets.IT.missing_sneaker_variants, 8);
assert.equal(report.markets.IT.missing_without_valid_ean, 1);
assert.equal(report.markets.IT.missing_with_ean_shared_across_shopify, 2);
assert.equal(report.markets.IT.candidates_for_safe_lookup, 5);
assert.equal(report.markets.IT.sampled, 4);
assert.equal(report.markets.IT.cases.NO_EXACT_EAN_MATCH_IN_RESPONSE, 1);
assert.equal(report.markets.IT.cases.MULTIPLE_EXACT_EAN_ASIN_MATCHES, 1);
assert.equal(report.markets.ES.sampled, 4);
assert.equal(catalogCalls, 16);
assert.equal(auditCalls, 1);
const payload = JSON.stringify(report);
for (const raw of [token, "SNEAKER-A", "SNEAKER-D", "COAT-A", ...eans]) {
  assert(!payload.includes(raw), "Pilot output must contain aggregates only");
}
throttle = true;
catalogCalls = 0;
const throttled = await runSneakerCatalogPilot({ bearer: token, auditFn, fetchImpl, delayMs: 0 });
assert.equal(throttled.overall_complete, false);
assert.equal(throttled.error_code, "amazon_pilot_catalog_throttled");
assert.equal(catalogCalls, 1);
assert.equal(throttled.markets.DE.status, "THROTTLED_OR_INTERRUPTED");
throttle = false;
responseError = true;
const errored = await runSneakerCatalogPilot({ bearer: token, auditFn, fetchImpl, delayMs: 0 });
assert.equal(errored.overall_complete, false);
assert.equal(errored.markets.IT.lookup_errors, 4);
assert.equal(errored.markets.IT.cases.LOOKUP_ERROR, 4);
responseError = false;
const missing = await runSneakerCatalogPilot({ bearer: "", auditFn, fetchImpl, delayMs: 0 });
assert.equal(missing.overall_complete, false);
assert.equal(missing.error_code, "amazon_pilot_bearer_missing");
console.log("Bounded Amazon sneaker EAN catalog matching pilot tests passed");
