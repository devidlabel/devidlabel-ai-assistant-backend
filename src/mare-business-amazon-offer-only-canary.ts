import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { readAmazonOfferOnlyPreflight } from "./mare-business-amazon-offer-preflight.js";
import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/**
 * Amazon OFFER_ONLY zero-quantity canary - isolated implementation, NOT wired
 * into M.A.R.E. capabilities, schedulers, routes, or production deploy.
 *
 * This code is intentionally unusable for a live PUT without THREE independent
 * server-owned services: immutable approval validation, fresh Channable writer
 * isolation evidence, and an atomic persistent write claim / receipt journal.
 * Supplying a string saying "approved" is not an authorization.
 */
type Row = Record<string, unknown>;
type Market = keyof typeof AMAZON_EU_MARKETPLACES;
type Env = AmazonCredentials & MareBusinessShopifyEnv & {
  AMAZON_SP_API_SELLER_ID?: string;
  AMAZON_OFFER_ONLY_LIVE_ENABLED?: string;
};
export type AmazonOfferOnlyInput = Readonly<{
  marketplace: Market; sku: string; ean: string; asin: string;
}>;
export type AmazonOfferOnlyPrepared = AmazonOfferOnlyInput & Readonly<{
  prepared_at: string;
  shopify_variant_id: string;
  shopify_price_minor: number;
  schema_version: string;
  schema_checksum: string;
}>;
export type AmazonOfferOnlyAuthorization = Readonly<{
  verified: true;
  plan_reference: string;
  reviewed_at: string;
  exact_identity_reviewed: true;
  brand_authorization_verified: true;
  gpsr_and_compliance_verified: true;
  schema_and_valid_preview_verified: true;
  price_policy_verified: true;
  approved_price_minor: number;
  order_and_tracking_pilot_ready: true;
}>;
export type AmazonOfferWriterIsolation = Readonly<{
  verified: true;
  scope: "AMAZON_EU_OFFER_WRITERS";
  marketplace: Market;
  sku: string;
  all_competing_writers_disabled: true;
  evidence_reference: string;
  verified_at: string;
}>;
export type AmazonOfferOnlyClaim = Readonly<{
  claimed: true; attempt_reference: string;
}>;
export type AmazonOfferOnlyDependencies = {
  preflight?: typeof readAmazonOfferOnlyPreflight;
  listingRead?: typeof readAmazonSellerListingsDirect;
  token?: typeof getAmazonAccessToken;
  fetch?: typeof fetch;
  clock?: () => number;
  // These MUST be injected by trusted backend services. No production
  // implementation is provided until writer isolation and approvals are live.
  verifyApprovedPlan?: (request: AmazonOfferOnlyPrepared) => Promise<AmazonOfferOnlyAuthorization>;
  verifyWriterIsolation?: (request: AmazonOfferOnlyPrepared) => Promise<AmazonOfferWriterIsolation>;
  atomicClaim?: (scope: string, planReference: string) => Promise<AmazonOfferOnlyClaim>;
  storeAttemptResult?: (attemptReference: string, status: string, evidence: Row) => Promise<void>;
};
const HOST = "https://sellingpartnerapi-eu.amazon.com";
const SKU = /^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const ASIN = /^[A-Z0-9]{10}$/;
const EAN = /^\d{13}$/;
const SELLER = /^[A-Z0-9]{8,30}$/;
const REF = /^[A-Za-z0-9._:-]{8,180}$/;
const HASH = /^[A-Za-z0-9+/]{20,128}={0,2}$/;
const MAX_AGE_MS = 15 * 60 * 1000;
const ISOLATION_AGE_MS = 5 * 60 * 1000;
const MAX_PRICE_MINOR = 100_000_000;
const MAX_RESPONSE_BYTES = 64_000;
const PREPARED_KEYS = ["asin", "ean", "marketplace", "prepared_at", "schema_checksum", "schema_version", "shopify_price_minor", "shopify_variant_id", "sku"];
function dict(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function validEAN(value: string): boolean {
  if (!EAN.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(value[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - sum % 10) % 10 === Number(value[12]);
}
function fail(code: string): never { throw new Error("amazon_offer_only_canary_" + code); }
function validTime(value: unknown, clock: () => number, maxAge: number): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value), current = clock();
  return Number.isSafeInteger(current) && Number.isFinite(timestamp) && timestamp <= current && current - timestamp <= maxAge;
}
function validate(raw: unknown): AmazonOfferOnlyInput {
  const v = dict(raw);
  if (Object.keys(v).sort().join(",") !== "asin,ean,marketplace,sku" ||
      !Object.hasOwn(AMAZON_EU_MARKETPLACES, v.marketplace as string) ||
      typeof v.sku !== "string" || !SKU.test(v.sku) || v.sku !== v.sku.trim() ||
      typeof v.asin !== "string" || !ASIN.test(v.asin) ||
      typeof v.ean !== "string" || !validEAN(v.ean)) fail("invalid_request");
  return Object.freeze({ marketplace: v.marketplace as Market, sku: v.sku, ean: v.ean, asin: v.asin });
}
function validatePrepared(raw: unknown): AmazonOfferOnlyPrepared {
  const v = dict(raw);
  if (Object.keys(v).sort().join(",") !== PREPARED_KEYS.join(",")) fail("invalid_prepared");
  const input = validate({ marketplace: v.marketplace, sku: v.sku, ean: v.ean, asin: v.asin });
  if (typeof v.prepared_at !== "string" ||
      typeof v.shopify_variant_id !== "string" ||
      !/^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,24}$/.test(v.shopify_variant_id) ||
      typeof v.shopify_price_minor !== "number" ||
      !Number.isSafeInteger(v.shopify_price_minor) ||
      v.shopify_price_minor <= 0 || v.shopify_price_minor > MAX_PRICE_MINOR ||
      typeof v.schema_version !== "string" || !REF.test(v.schema_version) ||
      typeof v.schema_checksum !== "string" || !HASH.test(v.schema_checksum))
    fail("invalid_prepared");
  return Object.freeze({
    ...input, prepared_at: v.prepared_at, shopify_variant_id: v.shopify_variant_id,
    shopify_price_minor: v.shopify_price_minor, schema_version: v.schema_version,
    schema_checksum: v.schema_checksum
  });
}
function snapshot(raw: unknown, request: AmazonOfferOnlyInput): Omit<AmazonOfferOnlyPrepared, keyof AmazonOfferOnlyInput | "prepared_at"> {
  const p = dict(raw);
  const expected = {
    ok: true, status: "REVIEW_REQUIRED",
    marketplace: request.marketplace, sku: request.sku, ean: request.ean, asin: request.asin,
    exact_ean_asin: true,
    seller_listing_absence_result: "NOT_FOUND_VERIFIED_BY_LISTINGS_API",
    seller_asin_search_result: "NO_SELLER_ASIN_IN_BOUNDED_SEARCH",
    seller_asin_search_is_not_final_absence_proof: true,
    restriction_count: 0, schema_product_type: "PRODUCT",
    schema_requirements: "LISTING_OFFER_ONLY",
    shopify_currency: "EUR",
    read_only: true, has_created_offer: false, live_listing_write_enabled: false,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (p[key] !== value) fail("preflight_not_verified");
  }
  if (!REF.test(String(p.listing_request_id || "")) ||
      !REF.test(String(p.schema_version || "")) ||
      !HASH.test(String(p.schema_checksum || "")) ||
      !/^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,24}$/.test(String(p.product_variant_id || "")) ||
      typeof p.shopify_price_minor !== "number" || !Number.isSafeInteger(p.shopify_price_minor) ||
      p.shopify_price_minor <= 0 || p.shopify_price_minor > MAX_PRICE_MINOR ||
      !Number.isSafeInteger(p.shopify_stock_observed) || (p.shopify_stock_observed as number) <= 0)
    fail("preflight_metadata_unverified");
  return {
    shopify_variant_id: p.product_variant_id as string,
    shopify_price_minor: p.shopify_price_minor,
    schema_version: p.schema_version as string,
    schema_checksum: p.schema_checksum as string,
  };
}
async function freshPreflight(input: AmazonOfferOnlyInput, env: Env, deps: AmazonOfferOnlyDependencies) {
  return snapshot(await (deps.preflight ?? readAmazonOfferOnlyPreflight)(input, env), input);
}
export async function prepareAmazonOfferOnlyCanary(
  raw: unknown, env: Env, deps: AmazonOfferOnlyDependencies = {},
): Promise<{ prepared_request: AmazonOfferOnlyPrepared; summary: Row }> {
  const input = validate(raw);
  const clock = deps.clock ?? Date.now;
  const metadata = await freshPreflight(input, env, deps);
  const prepared_request = validatePrepared({
    ...input, ...metadata, prepared_at: new Date(clock()).toISOString()
  });
  return {
    prepared_request,
    summary: {
      status: "PREPARED_OFFLINE_REVIEW_ONLY", marketplace: input.marketplace,
      sku: input.sku, asin: input.asin, provider_mutations: 0,
      quantity_if_approved: 0, approval_required: true, channable_unchanged: true,
      preview_not_authorization: true,
    }
  };
}
/** Fixed schema: caller cannot supply arbitrary Amazon attributes, price or stock. */
export function buildAmazonOfferOnlyZeroQuantityBody(
  input: AmazonOfferOnlyInput, approvedPriceMinor: number,
): Row {
  const request = validate(input);
  if (!Number.isSafeInteger(approvedPriceMinor) || approvedPriceMinor <= 0 ||
      approvedPriceMinor > MAX_PRICE_MINOR) fail("price_policy_invalid");
  const marketplace_id = AMAZON_EU_MARKETPLACES[request.marketplace];
  return {
    productType: "PRODUCT", requirements: "LISTING_OFFER_ONLY",
    attributes: {
      condition_type: [{ value: "new_new", marketplace_id }],
      merchant_suggested_asin: [{ value: request.asin, marketplace_id }],
      purchasable_offer: [{
        currency: "EUR", audience: "ALL", marketplace_id,
        our_price: [{ schedule: [{ value_with_tax: approvedPriceMinor / 100 }] }],
      }],
      fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 0 }],
    }
  };
}
function verifiedAuthorization(
  a: AmazonOfferOnlyAuthorization, p: AmazonOfferOnlyPrepared, clock: () => number,
): boolean {
  return a.verified === true && REF.test(a.plan_reference) &&
    validTime(a.reviewed_at, clock, MAX_AGE_MS) &&
    a.exact_identity_reviewed === true && a.brand_authorization_verified === true &&
    a.gpsr_and_compliance_verified === true && a.schema_and_valid_preview_verified === true &&
    a.price_policy_verified === true && a.order_and_tracking_pilot_ready === true &&
    typeof a.approved_price_minor === "number" &&
    Number.isSafeInteger(a.approved_price_minor) &&
    a.approved_price_minor > 0 && a.approved_price_minor <= MAX_PRICE_MINOR &&
    a.approved_price_minor === p.shopify_price_minor;
}
function verifiedIsolation(
  proof: AmazonOfferWriterIsolation, p: AmazonOfferOnlyPrepared, clock: () => number,
): boolean {
  return proof.verified === true && proof.scope === "AMAZON_EU_OFFER_WRITERS" &&
    proof.marketplace === p.marketplace && proof.sku === p.sku &&
    proof.all_competing_writers_disabled === true &&
    REF.test(proof.evidence_reference) &&
    validTime(proof.verified_at, clock, ISOLATION_AGE_MS);
}
async function safeJson(response: Response): Promise<Row> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || ""))
    fail("response_mime_unknown");
  if (!response.body) fail("response_body_missing");
  let count = 0;
  const parts: Uint8Array[] = [];
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      count += next.value.byteLength;
      if (count > MAX_RESPONSE_BYTES) fail("response_too_large");
      parts.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const merged = new Uint8Array(count);
  let offset = 0;
  for (const part of parts) { merged.set(part, offset); offset += part.length; }
  let json: unknown;
  try { json = JSON.parse(new TextDecoder().decode(merged)); }
  catch { fail("response_invalid_json"); }
  return dict(json);
}
export async function executeAmazonOfferOnlyCanary(
  rawPrepared: unknown, env: Env, deps: AmazonOfferOnlyDependencies = {},
): Promise<Row> {
  const prepared = validatePrepared(rawPrepared);
  // Off by default even when other Amazon preview and stock capabilities run.
  if (env.AMAZON_OFFER_ONLY_LIVE_ENABLED !== "true")
    return { ok: false, status: "BLOCKED_LIVE_DISABLED", provider_mutations: 0 };
  const clock = deps.clock ?? Date.now;
  if (!validTime(prepared.prepared_at, clock, MAX_AGE_MS)) fail("prepared_expired");
  if (!deps.verifyApprovedPlan || !deps.verifyWriterIsolation ||
      !deps.atomicClaim || !deps.storeAttemptResult)
    fail("backend_controls_not_connected");
  const seller = env.AMAZON_SP_API_SELLER_ID;
  if (typeof seller !== "string" || !SELLER.test(seller)) fail("seller_identity_unknown");
  // Recheck SP-API / Shopify evidence immediately before any authorization
  // or claim; no stored or user-provided preflight can stand in for it.
  const fresh = await freshPreflight(prepared, env, deps);
  if (fresh.shopify_variant_id !== prepared.shopify_variant_id ||
      fresh.shopify_price_minor !== prepared.shopify_price_minor ||
      fresh.schema_version !== prepared.schema_version ||
      fresh.schema_checksum !== prepared.schema_checksum)
    fail("preflight_changed_since_prepare");
  const authorization = await deps.verifyApprovedPlan(prepared);
  if (!verifiedAuthorization(authorization, prepared, clock))
    fail("approval_evidence_not_verified");
  const isolation = await deps.verifyWriterIsolation(prepared);
  if (!verifiedIsolation(isolation, prepared, clock))
    fail("writer_isolation_not_verified");
  const token = await (deps.token ?? getAmazonAccessToken)(env);
  if (typeof token !== "string" || token.length < 4 || token.length > 16384 ||
      /[\u0000-\u0020\u007f]/.test(token)) fail("authentication_invalid");
  const scope = "offer-only-v1:" + seller + ":" + prepared.marketplace + ":" + prepared.sku;
  // Claim must be atomic, persist BEFORE the first byte of PUT, and forbid
  // reuse even after 429, timeout, malformed response or crashed readback.
  const claim = await deps.atomicClaim(scope, authorization.plan_reference);
  if (claim.claimed !== true || !REF.test(claim.attempt_reference))
    fail("idempotency_claim_unavailable_or_already_used");
  const attempt = claim.attempt_reference;
  const url = new URL(HOST + "/listings/2021-08-01/items/" +
    encodeURIComponent(seller) + "/" + encodeURIComponent(prepared.sku));
  url.searchParams.set("marketplaceIds", AMAZON_EU_MARKETPLACES[prepared.marketplace]);
  const body = buildAmazonOfferOnlyZeroQuantityBody(prepared, authorization.approved_price_minor);
  let outcome = "SUBMISSION_OUTCOME_UNKNOWN";
  const evidence: Row = {
    marketplace: prepared.marketplace, sku: prepared.sku, asin: prepared.asin,
    attempt_reference: attempt, provider_mutations_possible: 1,
    quantity_requested: 0, automatic_retry_allowed: false,
  };
  let response: Response | null = null;
  try {
    response = await (deps.fetch ?? fetch)(url.toString(), {
      method: "PUT", headers: {
        "x-amz-access-token": token, "Content-Type": "application/json", Accept: "application/json",
      }, body: JSON.stringify(body),
      redirect: "manual", signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 200) {
      const result = await safeJson(response);
      if (result.sku === prepared.sku && result.status === "ACCEPTED" &&
          typeof result.submissionId === "string" && REF.test(result.submissionId)) {
        outcome = "ACCEPTED_PENDING_READBACK";
        evidence.submission_reference = result.submissionId;
      } else {
        outcome = "NOT_CONFIRMED_BY_PROVIDER";
      }
    } else {
      outcome = "HTTP_" + response.status + "_UNKNOWN_EFFECT";
      void response.body?.cancel().catch(() => {});
    }
  } catch {
    outcome = "TRANSPORT_OR_RESPONSE_UNCERTAIN";
  }
  // A response only means Amazon understood the request; not buyable, and
  // not even necessarily created until identity is independently read back.
  try { await deps.storeAttemptResult(attempt, outcome, evidence); }
  catch {
    return { ok: false, status: "RECEIPT_PERSISTENCE_UNKNOWN_RECONCILE_MANUALLY",
      ...evidence, provider_mutations: "UNKNOWN", retry_allowed: false };
  }
  if (outcome !== "ACCEPTED_PENDING_READBACK")
    return { ok: false, status: outcome, ...evidence, provider_mutations: "UNKNOWN", retry_allowed: false };
  let verified = false;
  try {
    const observed = dict(await (deps.listingRead ?? readAmazonSellerListingsDirect)({
      marketplace: prepared.marketplace, skus: [prepared.sku],
    }, env));
    const items = Array.isArray(observed.results) ? observed.results : [];
    const row = dict(items[0]);
    verified = observed.ok === true && observed.marketplace === prepared.marketplace &&
      observed.read_only === true && items.length === 1 &&
      row.sku === prepared.sku && row.state === "PRESENT" &&
      row.identity_state === "VERIFIED" && row.asin === prepared.asin &&
      row.fulfillment_state === "VERIFIED" && row.current_fbm_quantity === 0;
  } catch { /* Readback may lag; NEVER submit a second PUT. */ }
  const status = verified ? "OFFER_IDENTITY_QUANTITY_ZERO_VERIFIED" : "ACCEPTED_PENDING_READBACK";
  try { await deps.storeAttemptResult(attempt, status, { ...evidence, readback_verified: verified }); }
  catch { return { ok: false, status: "READBACK_RECEIPT_UNKNOWN_RECONCILE_MANUALLY",
    ...evidence, provider_mutations: 1, retry_allowed: false }; }
  return { ok: verified, status, ...evidence, provider_mutations: 1,
    readback_verified: verified, buyable_proven: false, retry_allowed: false };
}
