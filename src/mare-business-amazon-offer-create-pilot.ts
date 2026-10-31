import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { readAmazonOfferOnlyPreflight } from "./mare-business-amazon-offer-preflight.js";
import {
  previewAmazonOfferOnlyZeroQuantity,
  validateAmazonOfferPreviewRequest,
  type AmazonOfferPreviewInput,
  type AmazonOfferPreviewEnv
} from "./mare-business-amazon-offer-preview.js";
import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/**
 * A SINGLE offer-only CREATE pilot for an existing, independently matched ASIN.
 * This is NOT a full catalog creator and NOT a Channable inventory handoff.
 * A real Amazon PUT may be sent, with initial FBM quantity fixed to ZERO.
 * There is no stock update, catalog-data edit, retry, bulk path or scheduler.
 *
 * The MARE caller MUST use a separate live-write immutable plan with explicit
 * execution confirmation; no user-supplied payload, price, stock or URL.
 */
type Row = Record<string, unknown>;
type Env = AmazonCredentials & AmazonOfferPreviewEnv & MareBusinessShopifyEnv;
type Market = keyof typeof AMAZON_EU_MARKETPLACES;
export type PilotDependencies = {
  preview?: typeof previewAmazonOfferOnlyZeroQuantity;
  preflight?: typeof readAmazonOfferOnlyPreflight;
  sellerReader?: typeof readAmazonSellerListingsDirect;
  accessToken?: typeof getAmazonAccessToken;
  fetch?: typeof fetch;
};

const HOST = "https://sellingpartnerapi-eu.amazon.com";
const SELLER_RE = /^[A-Z0-9]{8,30}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const ISSUE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,89}$/;
const MAX_JSON = 64_000;
const TIMEOUT_MS = 20_000;

function asRow(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function same(value: Row, input: AmazonOfferPreviewInput): boolean {
  return value.marketplace === input.marketplace && value.sku === input.sku &&
    value.ean === input.ean && value.asin === input.asin;
}
function blocked(input: AmazonOfferPreviewInput, reason: string): Row {
  return {
    ok: false, status: "BLOCKED_CREATE", reason,
    marketplace: input.marketplace, sku: input.sku, asin: input.asin,
    offer_created_verified: false, live_write_attempted: false,
    buyer_offer_buyable_verified: false, channable_writer_unchanged: true
  };
}
function verifiedPreview(preview: Row, input: AmazonOfferPreviewInput): boolean {
  return same(preview, input) && preview.ok === true &&
    preview.status === "PREVIEW_REVIEW_REQUIRED" &&
    preview.amazon_preview_status === "VALID" &&
    preview.preview_only === true &&
    preview.validation_mode === "VALIDATION_PREVIEW" &&
    preview.provider_validation_performed === true &&
    preview.provider_mutations === 0 && preview.offer_quantity_submitted === 0 &&
    preview.issue_count === 0 && preview.issues_returned === true &&
    Array.isArray(preview.preview_issues) && preview.preview_issues.length === 0;
}
function verifiedPreflight(pre: Row, input: AmazonOfferPreviewInput): boolean {
  return same(pre, input) && pre.ok === true && pre.status === "REVIEW_REQUIRED" &&
    pre.exact_ean_asin === true &&
    pre.seller_listing_absence_result === "NOT_FOUND_VERIFIED_BY_LISTINGS_API" &&
    pre.seller_asin_search_result === "NO_SELLER_ASIN_IN_BOUNDED_SEARCH" &&
    pre.seller_asin_search_is_not_final_absence_proof === true &&
    pre.restriction_count === 0 && pre.schema_product_type === "PRODUCT" &&
    pre.schema_requirements === "LISTING_OFFER_ONLY" &&
    pre.shopify_currency === "EUR" &&
    Number.isSafeInteger(pre.shopify_price_minor) &&
    (pre.shopify_price_minor as number) > 0 &&
    (pre.shopify_price_minor as number) <= 100_000_000 &&
    Number.isSafeInteger(pre.shopify_stock_observed) &&
    ((pre.shopify_stock_observed as number) > 0 ||
     (pre.shopify_stock_observed === 0 && input.sku.startsWith("RFR_") &&
      pre.amazon_brand_expected === "Refrigiwear")) &&
    pre.read_only === true && pre.has_created_offer === false &&
    pre.live_listing_write_enabled === false &&
    typeof pre.product_variant_id === "string" &&
    /^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,24}$/.test(pre.product_variant_id);
}
async function limitedJson(response: Response): Promise<Row> {
  const contentType = response.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new Error("offer_pilot_response_type_unknown");
  const bytes = response.headers.get("content-length");
  if (bytes && /^\d+$/.test(bytes) && Number(bytes) > MAX_JSON)
    throw new Error("offer_pilot_response_too_large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("offer_pilot_response_body_missing");
  let total = 0;
  const pieces: Uint8Array[] = [];
  try {
    while (true) {
      const piece = await reader.read();
      if (piece.done) break;
      total += piece.value.byteLength;
      if (total > MAX_JSON) throw new Error("offer_pilot_response_too_large");
      pieces.push(piece.value);
    }
  } finally { reader.releaseLock(); }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) { combined.set(piece, offset); offset += piece.byteLength; }
  try { return asRow(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined))); }
  catch { throw new Error("offer_pilot_response_json_unknown"); }
}
function issueCodes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("offer_pilot_issues_unexpected");
  const codes: string[] = [];
  for (const raw of value) {
    const issue = asRow(raw);
    if (typeof issue.code !== "string" || !ISSUE_RE.test(issue.code))
      throw new Error("offer_pilot_issues_unexpected");
    codes.push(issue.code);
  }
  return [...new Set(codes)];
}

export async function createAmazonOfferOnlyPilot(
  rawInput: unknown,
  env: Env,
  deps: PilotDependencies = {}
): Promise<Row> {
  const input = validateAmazonOfferPreviewRequest(rawInput);
  const sellerId = env.AMAZON_SP_API_SELLER_ID;
  if (env.AMAZON_OFFER_PREVIEW_ENABLED !== "true" ||
      typeof sellerId !== "string" || !SELLER_RE.test(sellerId))
    return blocked(input, "pilot_configuration_not_ready");

  // Last provider validation must be a real VALID, error-free Amazon preview.
  const preview = asRow(await (deps.preview ?? previewAmazonOfferOnlyZeroQuantity)(input, env));
  if (!verifiedPreview(preview, input))
    return blocked(input, "amazon_validation_preview_not_valid");

  // Fresh evidence immediately before real PUT; a competing seller SKU or ASIN
  // now present blocks execution. No caller-supplied claims or price/stock.
  const pre = asRow(await (deps.preflight ?? readAmazonOfferOnlyPreflight)(input, env));
  if (!verifiedPreflight(pre, input))
    return blocked(input, "fresh_preflight_not_verified");

  const marketId = AMAZON_EU_MARKETPLACES[input.marketplace as Market];
  const amount = (pre.shopify_price_minor as number) / 100;
  const payload = {
    productType: "PRODUCT", requirements: "LISTING_OFFER_ONLY",
    attributes: {
      merchant_suggested_asin: [{ value: input.asin, marketplace_id: marketId }],
      condition_type: [{ value: "new_new", marketplace_id: marketId }],
      fulfillment_availability: [{
        fulfillment_channel_code: "DEFAULT", quantity: 0, marketplace_id: marketId
      }],
      purchasable_offer: [{
        currency: "EUR", our_price: [{ schedule: [{ value_with_tax: amount }] }],
        marketplace_id: marketId
      }]
    }
  };

  const token = await (deps.accessToken ?? getAmazonAccessToken)(env);
  if (typeof token !== "string" || !token || token.length > 16_384 ||
      /[\u0000-\u0020\u007f]/.test(token))
    throw new Error("offer_pilot_authentication_failed");
  const url = new URL(HOST + "/listings/2021-08-01/items/" +
    encodeURIComponent(sellerId) + "/" + encodeURIComponent(input.sku));
  url.searchParams.set("marketplaceIds", marketId);
  // Production submission omits mode. Amazon accepts only VALIDATION_PREVIEW as an explicit mode.
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(url.toString(), {
      method: "PUT",
      headers: {
        "x-amz-access-token": token,
        "Content-Type": "application/json", Accept: "application/json"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual"
    });
  } catch {
    // The request may have reached Amazon. Do NOT automatically retry.
    throw new Error("offer_pilot_submission_uncertain_reconcile_before_retry");
  }

  if (response.status !== 200) {
    void response.body?.cancel().catch(() => {});
    return {
      ...blocked(input, "amazon_http_" + response.status),
      live_write_attempted: true, submission_outcome_unknown: true,
      manual_reconciliation_required: true
    };
  }

  let ack: Row;
  try { ack = await limitedJson(response); }
  catch {
    throw new Error("offer_pilot_response_uncertain_reconcile_before_retry");
  }
  if (ack.sku !== input.sku || typeof ack.submissionId !== "string" ||
      !REF_RE.test(ack.submissionId) ||
      (ack.status !== "ACCEPTED" && ack.status !== "INVALID")) {
    throw new Error("offer_pilot_ack_uncertain_reconcile_before_retry");
  }
  const codes = issueCodes(ack.issues ?? []);
  if (ack.status === "INVALID" || codes.length > 0) {
    return {
      ok: false, status: "PROVIDER_REJECTED", marketplace: input.marketplace,
      sku: input.sku, asin: input.asin, submission_reference: ack.submissionId,
      issue_codes: codes, submitted_quantity: 0,
      offer_created_verified: false, buyer_offer_buyable_verified: false,
      live_write_attempted: true, channable_writer_unchanged: true
    };
  }

  // A successful submission is not proof of creation: read the seller listing.
  let observed: Row = {};
  try {
    observed = asRow(await (deps.sellerReader ?? readAmazonSellerListingsDirect)(
      { marketplace: input.marketplace, skus: [input.sku] }, env));
  } catch { /* Eventual consistency and transient read failures are expected. */ }
  const items = Array.isArray(observed.results) ? observed.results : [];
  const entry = asRow(items[0]);
  const confirmed = observed.ok === true && items.length === 1 &&
    entry.sku === input.sku && entry.state === "PRESENT" &&
    entry.identity_state === "VERIFIED" && entry.asin === input.asin;

  return {
    ok: true,
    status: confirmed ? "SELLER_OFFER_CREATED_VERIFIED" : "SUBMITTED_AWAITING_SELLER_READBACK",
    marketplace: input.marketplace, sku: input.sku, asin: input.asin,
    submitted_quantity: 0, submission_reference: ack.submissionId,
    issue_codes: codes, offer_created_verified: confirmed,
    buyer_offer_buyable_verified: false, // quantity 0 cannot establish saleability
    live_write_attempted: true, channable_writer_unchanged: true,
    next_step: confirmed
      ? "CHANNABLE_PRICE_STOCK_HANDOFF_THEN_BUYABLE_READBACK"
      : "RECONCILE_AMAZON_LISTING_BEFORE_ANY_RETRY_OR_STOCK_HANDOFF"
  };
}
