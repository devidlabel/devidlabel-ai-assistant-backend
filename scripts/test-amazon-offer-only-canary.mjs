import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Offline synthetic SP-API only. No authentic provider endpoint is contacted.
const bundle = await build({
  entryPoints: ["src/mare-business-amazon-offer-only-canary.ts"],
  bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent",
});
const tempDir = await mkdtemp(join(tmpdir(), "amazon-offer-canary-"));
const bundlePath = join(tempDir, "bundle.mjs");
await writeFile(bundlePath, bundle.outputFiles[0].text);
const {
  prepareAmazonOfferOnlyCanary: prepare,
  executeAmazonOfferOnlyCanary: execute,
  buildAmazonOfferOnlyZeroQuantityBody: buildPayload,
} = await import(pathToFileURL(bundlePath).href);
await rm(tempDir, { recursive: true, force: true });
const input = {
  marketplace: "IT", sku: "SYNTHETIC_CANARY_01", ean: "2000000001234", asin: "B0TEST0001",
};
const time = Date.parse("2026-10-22T12:00:00.000Z");
const clock = () => time;
const iso = new Date(time).toISOString();
const seller = "A123456789";
const env = {
  AMAZON_SP_API_SELLER_ID: seller,
  AMAZON_SP_API_CLIENT_ID: "synthetic-id", AMAZON_SP_API_CLIENT_SECRET: "synthetic-secret",
  AMAZON_SP_API_REFRESH_TOKEN: "synthetic-refresh",
  AMAZON_OFFER_ONLY_LIVE_ENABLED: "true",
};
const preflight = (patch = {}) => ({
  ok: true, status: "REVIEW_REQUIRED", ...input,
  exact_ean_asin: true,
  seller_listing_absence_result: "NOT_FOUND_VERIFIED_BY_LISTINGS_API",
  seller_asin_search_result: "NO_SELLER_ASIN_IN_BOUNDED_SEARCH",
  seller_asin_search_is_not_final_absence_proof: true,
  listing_request_id: "SYNTHETIC_REQ_01234",
  restriction_count: 0,
  schema_product_type: "PRODUCT", schema_requirements: "LISTING_OFFER_ONLY",
  schema_version: "synthetic-v1", schema_checksum: "c3ludGhldGljLXRlc3QxMg==",
  shopify_currency: "EUR", shopify_stock_observed: 4, shopify_price_minor: 2599,
  product_variant_id: "gid://shopify/ProductVariant/123456",
  read_only: true, has_created_offer: false, live_listing_write_enabled: false,
  ...patch,
});
const authorization = (patch = {}) => ({
  source: "SERVER_VERIFIED_IMMUTABLE_REVIEW", verified: true,
  seller_id: seller, marketplace: input.marketplace, sku: input.sku,
  ean: input.ean, asin: input.asin,
  shopify_variant_id: "gid://shopify/ProductVariant/123456",
  schema_version: "synthetic-v1",
  schema_checksum: "c3ludGhldGljLXRlc3QxMg==",
  plan_reference: "APPROVAL-20261022-001", reviewed_at: iso,
  reviewer_reference: "AUDITOR-TEST-001",
  signed_review_digest_sha256: "a".repeat(64),
  brand_name: "Synthetic Brand",
  seller_central_brand_approval_reference: "SELLER-CENTRAL-SYNTH-001",
  seller_central_marketplace_verified: true,
  gpsr_document_digest_sha256: "b".repeat(64),
  manufacturer_evidence_reference: "MANUFACTURER-TEST-001",
  pt_definitions_reference: "PTD-TEST-001",
  amazon_validation_submission_reference: "VALIDATION-TEST-001",
  exact_identity_reviewed: true, brand_authorization_verified: true,
  gpsr_and_compliance_verified: true, schema_and_valid_preview_verified: true,
  price_policy_verified: true, approved_price_minor: 2599,
  order_and_tracking_pilot_ready: true,
  order_tracking_proof_reference: "ORDERS-TEST-001",
  commercial_price_review_reference: "PRICE-TEST-001",
  ...patch,
});
const isolation = (patch = {}) => ({
  source: "CHANNABLE_API_EXPORT_READBACK", verified: true,
  seller_id: seller, scope: "AMAZON_EU_OFFER_WRITERS",
  marketplace: input.marketplace, sku: input.sku,
  company_id: 99008, project_id: 328207,
  all_competing_writers_disabled: true,
  provider_export_inventory_complete: true,
  independently_checked_other_writers: true,
  other_live_writers_for_sku: 0,
  export_count: 1,
  exports: [{
    export_id: "SYNTHETIC-EXPORT-IT",
    marketplace: "IT", seller_sku_excluded: true,
    sku_exclusion_rule_reference: "RULE-SYNTHETIC-001",
    last_export_status: "SUCCESS", last_completed_at: iso
  }],
  evidence_reference: "CHANNABLE_PROOF_SYNTH_123",
  verified_at: iso,
  ...patch,
});
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
const prepared = (await prepare(input, env, { preflight: async () => preflight(), clock })).prepared_request;
assert.equal(prepared.shopify_variant_id, "gid://shopify/ProductVariant/123456");
assert.equal(prepared.shopify_price_minor, 2599);
assert.equal(prepared.prepared_at, iso);
const payload = buildPayload(input, 2599);
assert.equal(payload.productType, "PRODUCT");
assert.equal(payload.requirements, "LISTING_OFFER_ONLY");
assert.deepEqual(Object.keys(payload.attributes).sort(), [
  "condition_type", "fulfillment_availability", "merchant_suggested_asin", "purchasable_offer",
].sort());
assert.equal(payload.attributes.fulfillment_availability[0].quantity, 0);
assert.equal(payload.attributes.merchant_suggested_asin[0].value, input.asin);
assert.equal(payload.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax, 25.99);
assert.throws(() => buildPayload(input, -1), /price_policy_invalid/);
assert.throws(() => buildPayload(input, 0), /price_policy_invalid/);
assert.throws(() => buildPayload(input, 12.5), /price_policy_invalid/);
assert.throws(() => buildPayload({ ...input, asin: "WRONG" }, 2599), /invalid_request/);
await assert.rejects(() => prepare({ ...input, extra: "unsafe" }, env, { preflight: async () => preflight(), clock }), /invalid_request/);
await assert.rejects(() => prepare(input, env, { preflight: async () => preflight({ status: "BLOCKED_EXISTING_OFFER" }), clock }), /preflight_not_verified/);
await assert.rejects(() => prepare(input, env, { preflight: async () => preflight({ restriction_count: 1 }), clock }), /preflight_not_verified/);

let putCount = 0;
let claims = 0;
const stored = [];
const deps = (patch = {}) => ({
  preflight: async () => preflight(),
  clock, token: async () => "synthetic-access-token",
  verifyApprovedPlan: async () => authorization(),
  verifyWriterIsolation: async () => isolation(),
  atomicClaim: async (scope, planRef) => {
    claims++;
    assert.equal(scope, "offer-only-v1:" + seller + ":IT:" + input.sku);
    assert.equal(planRef, "APPROVAL-20261022-001");
    return { claimed: claims === 1, attempt_reference: "ATTEMPT-20261022-001" };
  },
  storeAttemptResult: async (id, status, evidence) => stored.push({ id, status, evidence }),
  fetch: async (url, opts) => {
    putCount++;
    assert.equal(new URL(url).hostname, "sellingpartnerapi-eu.amazon.com");
    assert.equal(new URL(url).searchParams.get("marketplaceIds"), "APJ6JRA9NG5V4");
    assert.equal(opts.method, "PUT");
    assert.equal(opts.headers["x-amz-access-token"], "synthetic-access-token");
    const sent = JSON.parse(opts.body);
    assert.equal(sent.attributes.fulfillment_availability[0].quantity, 0);
    assert.equal(sent.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax, 25.99);
    return json({ sku: input.sku, status: "ACCEPTED", submissionId: "SUBMISSION-001", issues: [] });
  },
  listingRead: async () => ({
    ok: true, marketplace: "IT", read_only: true,
    results: [{
      sku: input.sku, asin: input.asin, state: "PRESENT",
      identity_state: "VERIFIED", fulfillment_state: "VERIFIED",
      current_fbm_quantity: 0,
    }],
  }),
  ...patch,
});
const disabled = await execute(prepared, { ...env, AMAZON_OFFER_ONLY_LIVE_ENABLED: "false" }, deps());
assert.equal(disabled.status, "BLOCKED_LIVE_DISABLED");
assert.equal(putCount, 0);
await assert.rejects(() => execute(prepared, env, { preflight: async () => preflight(), clock }), /backend_controls_not_connected/);
await assert.rejects(() => execute(prepared, env, deps({ preflight: async () => preflight({ shopify_price_minor: 2598 }) })), /preflight_changed_since_prepare/);
await assert.rejects(() => execute(prepared, env, deps({ verifyApprovedPlan: async () => authorization({ brand_authorization_verified: false }) })), /approval_evidence_not_verified/);
await assert.rejects(() => execute(prepared, env, deps({ verifyApprovedPlan: async () => authorization({ price_policy_verified: false }) })), /approval_evidence_not_verified/);
await assert.rejects(() => execute(prepared, env, deps({ verifyWriterIsolation: async () => isolation({ all_competing_writers_disabled: false }) })), /writer_isolation_not_verified/);
await assert.rejects(() => execute(prepared, env, deps({ verifyWriterIsolation: async () => isolation({ verified_at: "2026-10-22T11:45:00.000Z" }) })), /writer_isolation_not_verified/);
await assert.rejects(() => execute(prepared, env, deps({ verifyApprovedPlan: async () => authorization({ seller_id: "A987654321" }) })), /approval_evidence_not_verified/);
await assert.rejects(() => execute(prepared, env, deps({ verifyApprovedPlan: async () => authorization({ asin: "B0OTHER001" }) })), /approval_evidence_not_verified/);
await assert.rejects(() => execute(prepared, env, deps({ verifyApprovedPlan: async () => authorization({ seller_central_brand_approval_reference: "" }) })), /approval_evidence_not_verified/);
await assert.rejects(() => execute(prepared, env, deps({ verifyApprovedPlan: async () => authorization({ gpsr_document_digest_sha256: null }) })), /approval_evidence_not_verified/);
await assert.rejects(() => execute(prepared, env, deps({ verifyApprovedPlan: async () => authorization({ source: "CALLER_ATTESTATION" }) })), /approval_evidence_not_verified/);
await assert.rejects(() => execute(prepared, env, deps({ verifyWriterIsolation: async () => isolation({ source: "CALLER_ATTESTATION" }) })), /writer_isolation_not_verified/);
await assert.rejects(() => execute(prepared, env, deps({ verifyWriterIsolation: async () => isolation({ company_id: 12345 }) })), /writer_isolation_not_verified/);
await assert.rejects(() => execute(prepared, env, deps({ verifyWriterIsolation: async () => isolation({ export_count: 0 }) })), /writer_isolation_not_verified/);
await assert.rejects(() => execute(prepared, env, deps({ verifyWriterIsolation: async () => isolation({ provider_export_inventory_complete: false }) })), /writer_isolation_not_verified/);
await assert.rejects(() => execute(prepared, env, deps({ verifyWriterIsolation: async () => isolation({ exports: [{...isolation().exports[0], seller_sku_excluded: false}] }) })), /writer_isolation_not_verified/);
await assert.rejects(() => execute(prepared, env, deps({ verifyWriterIsolation: async () => isolation({ other_live_writers_for_sku: 1 }) })), /writer_isolation_not_verified/);

await assert.rejects(() => execute({ ...prepared, prepared_at: "2026-10-22T11:00:00.000Z" }, env, deps()), /prepared_expired/);
assert.equal(putCount, 0);
const success = await execute(prepared, env, deps());
assert.equal(success.status, "OFFER_IDENTITY_QUANTITY_ZERO_VERIFIED");
assert.equal(success.ok, true);
assert.equal(success.buyable_proven, false);
assert.equal(success.retry_allowed, false);
assert.equal(putCount, 1);
assert.equal(claims, 1);
assert.equal(stored.length, 2);
await assert.rejects(() => execute(prepared, env, deps()), /idempotency_claim_unavailable_or_already_used/);
assert.equal(putCount, 1);

// A transport failure after the atomic claim is not safe to replay.
const uncertainStored = [];
const uncertain = await execute(prepared, env, deps({
  atomicClaim: async () => ({ claimed: true, attempt_reference: "ATTEMPT-UNKNOWN-002" }),
  storeAttemptResult: async (_id, status) => uncertainStored.push(status),
  fetch: async () => { putCount++; throw new Error("mock-connection-reset"); },
}));
assert.equal(uncertain.status, "TRANSPORT_OR_RESPONSE_UNCERTAIN");
assert.equal(uncertain.retry_allowed, false);
assert.equal(uncertainStored.length, 1);
assert.equal(putCount, 2);

const acceptedWithoutReadback = await execute(prepared, env, deps({
  atomicClaim: async () => ({ claimed: true, attempt_reference: "ATTEMPT-NOREAD-003" }),
  listingRead: async () => { throw new Error("mock-readback-timeout"); },
  storeAttemptResult: async () => {},
  fetch: async () => json({ sku: input.sku, status: "ACCEPTED", submissionId: "SUBMISSION-004" }),
}));
assert.equal(acceptedWithoutReadback.status, "ACCEPTED_PENDING_READBACK");
assert.equal(acceptedWithoutReadback.retry_allowed, false);
assert.equal(acceptedWithoutReadback.readback_verified, false);

const missingReceipt = await execute(prepared, env, deps({
  atomicClaim: async () => ({ claimed: true, attempt_reference: "ATTEMPT-BADSTORE-004" }),
  storeAttemptResult: async () => { throw new Error("mock-storage-failed"); },
  fetch: async () => json({ sku: input.sku, status: "ACCEPTED", submissionId: "SUBMISSION-005" }),
}));
assert.equal(missingReceipt.status, "RECEIPT_PERSISTENCE_UNKNOWN_RECONCILE_MANUALLY");
assert.equal(missingReceipt.retry_allowed, false);
assert.equal(JSON.stringify(missingReceipt).includes("synthetic-secret"), false);
console.log("amazon offer-only canary: synthetic guard, payload, idempotency and readback tests passed");