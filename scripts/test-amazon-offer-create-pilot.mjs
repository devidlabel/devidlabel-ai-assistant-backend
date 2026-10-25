import assert from "node:assert/strict";
import { build } from "esbuild";

/** Offline regression: ALL Amazon, Shopify and token operations are synthetic. */
const compiled = await build({
  entryPoints: ["src/mare-business-amazon-offer-create-pilot.ts"],
  bundle: true, format: "esm", platform: "neutral",
  write: false, logLevel: "silent"
});
const { createAmazonOfferOnlyPilot: create } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64")
);
const item = Object.freeze({
  marketplace: "IT", sku: "SYNTHETIC_OFFER_001",
  ean: "2000000001234", asin: "B0TEST0001"
});
const env = {
  AMAZON_SP_API_SELLER_ID: "A123456789",
  AMAZON_OFFER_PREVIEW_ENABLED: "true",
  AMAZON_SP_API_CLIENT_ID: "synthetic",
  AMAZON_SP_API_CLIENT_SECRET: "synthetic",
  AMAZON_SP_API_REFRESH_TOKEN: "synthetic"
};
const makePreview = (patch = {}) => ({
  ok: true, status: "PREVIEW_REVIEW_REQUIRED", ...item,
  amazon_preview_status: "VALID", preview_only: true,
  validation_mode: "VALIDATION_PREVIEW", provider_validation_performed: true,
  provider_mutations: 0, offer_quantity_submitted: 0,
  issue_count: 0, issues_returned: true, preview_issues: [], ...patch
});
const makePreflight = (patch = {}) => ({
  ok: true, status: "REVIEW_REQUIRED", ...item,
  exact_ean_asin: true,
  seller_listing_absence_result: "NOT_FOUND_VERIFIED_BY_LISTINGS_API",
  seller_asin_search_result: "NO_SELLER_ASIN_IN_BOUNDED_SEARCH",
  seller_asin_search_is_not_final_absence_proof: true,
  restriction_count: 0, schema_product_type: "PRODUCT",
  schema_requirements: "LISTING_OFFER_ONLY",
  shopify_currency: "EUR", shopify_price_minor: 2599, shopify_stock_observed: 7,
  product_variant_id: "gid://shopify/ProductVariant/123456",
  read_only: true, has_created_offer: false, live_listing_write_enabled: false,
  ...patch
});
const json = (x, status = 200) => new Response(JSON.stringify(x), {
  status, headers: { "content-type": "application/json" }
});
function harness(config = {}) {
  const calls = [];
  const deps = {
    preview: async x => { calls.push("preview"); assert.deepEqual(x, item); return makePreview(config.preview); },
    preflight: async x => { calls.push("preflight"); assert.deepEqual(x, item); return makePreflight(config.preflight); },
    accessToken: async () => { calls.push("token"); return "test-access-token"; },
    fetch: async (rawUrl, init) => {
      calls.push("LIVE_PUT");
      const url = new URL(rawUrl);
      assert.equal(url.origin, "https://sellingpartnerapi-eu.amazon.com");
      assert.equal(url.pathname, "/listings/2021-08-01/items/A123456789/SYNTHETIC_OFFER_001");
      assert.equal(url.searchParams.get("marketplaceIds"), "APJ6JRA9NG5V4");
      assert.equal(url.searchParams.has("mode"), false);
      assert.equal(init.method, "PUT");
      assert.equal(init.redirect, "manual");
      assert.equal(init.headers["x-amz-access-token"], "test-access-token");
      const value = JSON.parse(init.body);
      assert.deepEqual(Object.keys(value.attributes).sort(), [
        "condition_type", "fulfillment_availability",
        "merchant_suggested_asin", "purchasable_offer"
      ]);
      assert.equal(value.productType, "PRODUCT");
      assert.equal(value.requirements, "LISTING_OFFER_ONLY");
      assert.equal(value.attributes.fulfillment_availability[0].quantity, 0);
      assert.equal(value.attributes.merchant_suggested_asin[0].value, item.asin);
      assert.equal(value.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax, 25.99);
      if (config.networkError) throw Error("synthetic network lost after PUT");
      return json(config.ack ?? {
        sku: item.sku, status: "ACCEPTED",
        submissionId: "SYNTHETIC_SUBMISSION", issues: []
      }, config.httpStatus ?? 200);
    },
    sellerReader: async x => {
      calls.push("readback");
      assert.deepEqual(x, { marketplace: item.marketplace, skus: [item.sku] });
      return config.readback ?? {
        ok: true,
        results: [{
          sku: item.sku, state: "PRESENT", identity_state: "VERIFIED",
          asin: item.asin, statuses: ["DISCOVERABLE"],
          fulfillment_state: "VERIFIED", current_fbm_quantity: 0
        }]
      };
    }
  };
  return { calls, run: () => create(item, config.env ?? env, deps) };
}
let checks = 0;
const run = async (f) => { await f(); checks++; };

await run(async () => {
  const h = harness();
  const r = await h.run();
  assert.equal(r.ok, true);
  assert.equal(r.status, "SELLER_OFFER_CREATED_VERIFIED");
  assert.equal(r.offer_created_verified, true);
  assert.equal(r.buyer_offer_buyable_verified, false);
  assert.equal(r.submitted_quantity, 0);
  assert.equal(r.channable_writer_unchanged, true);
  assert.deepEqual(h.calls, ["preview", "preflight", "token", "LIVE_PUT", "readback"]);
});
await run(async () => {
  const h = harness({ preview: { amazon_preview_status: "INVALID" } });
  const r = await h.run();
  assert.equal(r.status, "BLOCKED_CREATE");
  assert.deepEqual(h.calls, ["preview"]);
});
await run(async () => {
  const h = harness({ preflight: {
    status: "BLOCKED_EXISTING_OFFER",
    seller_listing_absence_result: "SELLER_SKU_PRESENT"
  } });
  const r = await h.run();
  assert.equal(r.status, "BLOCKED_CREATE");
  assert.deepEqual(h.calls, ["preview", "preflight"]);
});
await run(async () => {
  const h = harness({ preflight: { asin: "B0WRONG001" } });
  const r = await h.run();
  assert.equal(r.live_write_attempted, false);
  assert.deepEqual(h.calls, ["preview", "preflight"]);
});
await run(async () => {
  const h = harness({ ack: {
    sku: item.sku, status: "INVALID", submissionId: "SYNT_ISSUE",
    issues: [{ code: "90220", severity: "ERROR", message: "PRIVATE_NOT_RETURNED" }]
  } });
  const r = await h.run();
  assert.equal(r.status, "PROVIDER_REJECTED");
  assert.equal(r.offer_created_verified, false);
  assert.deepEqual(r.issue_codes, ["90220"]);
  assert.equal(JSON.stringify(r).includes("PRIVATE_NOT_RETURNED"), false);
  assert.deepEqual(h.calls, ["preview", "preflight", "token", "LIVE_PUT"]);
});
await run(async () => {
  const h = harness({ readback: {
    ok: true, results: [{ sku: item.sku, state: "VERIFIED_ABSENT" }]
  } });
  const r = await h.run();
  assert.equal(r.status, "SUBMITTED_AWAITING_SELLER_READBACK");
  assert.equal(r.offer_created_verified, false);
  assert.equal(r.live_write_attempted, true);
});
await run(async () => {
  const h = harness({ networkError: true });
  await assert.rejects(h.run(), /offer_pilot_submission_uncertain_reconcile_before_retry/);
  assert.equal(h.calls.includes("readback"), false);
});
await run(async () => {
  const h = harness({ env: { ...env, AMAZON_OFFER_PREVIEW_ENABLED: "false" } });
  const r = await h.run();
  assert.equal(r.status, "BLOCKED_CREATE");
  assert.equal(h.calls.length, 0);
});
await run(async () => {
  const h = harness();
  await assert.rejects(create({
    ...item, stock: 100
  }, env, {}), /amazon_offer_preview_invalid_input/);
  assert.equal(h.calls.length, 0);
});
await run(async () => {
  const h = harness({ httpStatus: 429 });
  const r = await h.run();
  assert.equal(r.live_write_attempted, true);
  assert.equal(r.submission_outcome_unknown, true);
  assert.equal(r.manual_reconciliation_required, true);
});
console.log(JSON.stringify({
  ok: true, checks, mode: "offline_mock_only",
  supports_publishing: true,
  no_positive_stock_writes: true,
  rejects_stale_identity_and_invalid_preview: true,
  readback_required_before_created_claim: true
}));
