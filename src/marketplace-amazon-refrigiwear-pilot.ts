import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { previewAmazonGenericEanValidation } from "./marketplace-amazon-generic-ean-preview.js";
import { researchAmazonNewAsinProductType } from "./marketplace-amazon-new-asin-research.js";
import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/** Refrigiwear pilot: exact preview payload, zero FBM stock and no price. */
type Row = Record<string, unknown>;
type Market = keyof typeof AMAZON_EU_MARKETPLACES;
type Env = AmazonCredentials & MareBusinessShopifyEnv & {
  AMAZON_SP_API_SELLER_ID?: string;
  AMAZON_OFFER_PREVIEW_ENABLED?: string;
};
type Input = { marketplace: Market; sku: string; product_type: string;
  allow_known_missing_attributes: boolean };
type Deps = {
  preview?: typeof previewAmazonGenericEanValidation;
  research?: typeof researchAmazonNewAsinProductType;
  seller?: typeof readAmazonSellerListingsDirect;
  token?: typeof getAmazonAccessToken;
  fetch?: typeof fetch;
};
const HOST = "https://sellingpartnerapi-eu.amazon.com";
const MARKET_TYPES = new Set(["COAT", "HAT", "SHIRT", "BACKPACK", "SWEATER", "SWEATSHIRT", "SCARF"]);
const SKU = /^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const SELLER = /^[A-Z0-9]{8,30}$/;
const EAN = /^\d{13}$/;
const ASIN = /^[A-Z0-9]{10}$/;
const SUBMISSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ATTRS = new Set([
  "brand", "item_name", "externally_assigned_product_identifier",
  "model_name", "color", "country_of_origin", "target_gender",
  "product_description", "bullet_point", "apparel_size", "shirt_size",
  "fabric_type", "item_type_name", "department", "age_range_description",
  "care_instructions", "manufacturer", "outer", "headwear_size",
  "special_size_type", "batteries_required",
  "supplier_declared_dg_hz_regulation", "item_package_dimensions",
  "item_package_weight", "list_price", "style", "weave_type",
  "closure", "water_resistance_level", "material", "fit_type",
  "collar_style", "strap_type", "lining_description", "storage_volume",
  "item_depth_width_height", "number_of_compartments", "size",
  "apparel_size", "shirt_size"
]);
function obj(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ?
    value as Row : {};
}
function validated(raw: unknown): Input {
  const a = obj(raw);
  if (Object.keys(a).sort().join("|") !==
      "allow_known_missing_attributes|marketplace|product_type|sku" ||
      typeof a.marketplace !== "string" ||
      !Object.hasOwn(AMAZON_EU_MARKETPLACES, a.marketplace) ||
      typeof a.sku !== "string" || !SKU.test(a.sku) ||
      a.sku !== a.sku.trim() ||
      typeof a.product_type !== "string" ||
      !MARKET_TYPES.has(a.product_type) ||
      typeof a.allow_known_missing_attributes !== "boolean")
    throw new Error("refrigiwear_pilot_request_invalid");
  return a as Input;
}
function blocked(x: Input, reason: string): Row {
  return { ok: false, status: "BLOCKED_REFRIGIWEAR_PILOT",
    marketplace: x.marketplace, sku: x.sku, reason,
    provider_write_attempted: false, asin_created_verified: false,
    buyable_verified: false, no_channable_changes: true };
}
function validEan(ean: string): boolean {
  if (!EAN.test(ean)) return false;
  let total = 0;
  for (let i = 0; i < 12; i++) total += +ean[i] * (i % 2 ? 3 : 1);
  return (10 - total % 10) % 10 === +ean[12];
}
export async function createRefrigiwearNewAsinPilot(
  raw: unknown, env: Env, deps: Deps = {}
): Promise<Row> {
  const input = validated(raw);
  const {marketplace, sku, product_type: productType} = input;
  const sellerId = env.AMAZON_SP_API_SELLER_ID;
  if (!SELLER.test(sellerId || "") || env.AMAZON_OFFER_PREVIEW_ENABLED !== "true")
    return blocked(input, "seller_or_validation_preview_disabled");
  const marketId = AMAZON_EU_MARKETPLACES[marketplace];
  const transport = deps.fetch ?? fetch;
  let captured: Row | null = null;
  const captureTransport: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    if (captured || target.origin !== HOST ||
        target.pathname !== "/listings/2021-08-01/items/" +
          encodeURIComponent(sellerId!) + "/" + encodeURIComponent(sku) ||
        target.searchParams.get("mode") !== "VALIDATION_PREVIEW" ||
        target.searchParams.get("marketplaceIds") !== marketId ||
        init?.method !== "PUT" || typeof init.body !== "string")
      throw new Error("refrigiwear_preview_capture_untrusted");
    captured = obj(JSON.parse(init.body));
    return transport(url, init);
  };
  const preview = obj(await (deps.preview ?? previewAmazonGenericEanValidation)(
    { marketplace, sku, product_type: productType }, env,
    { fetch: captureTransport }
  ));
  const errors = Array.isArray(preview.issues) ?
    preview.issues.map(obj).filter(issue => issue.severity === "ERROR") : [];
  const fullyValid = preview.provider_validation_status === "VALID" &&
    errors.length === 0;
  const trialOfMissingOnly = input.allow_known_missing_attributes &&
    preview.provider_validation_status === "INVALID" && errors.length > 0 &&
    errors.every(issue => issue.code === "90220");
  if (preview.ok !== true || preview.status !== "VALIDATION_ONLY_REVIEW_REQUIRED" ||
      preview.marketplace !== marketplace || preview.sku !== sku ||
      preview.product_type !== productType ||
      preview.provider_validation_performed !== true ||
      preview.preview_only !== true || preview.provider_mutations !== 0 ||
      preview.product_created !== false || !captured ||
      (!fullyValid && !trialOfMissingOnly))
    return blocked(input, "amazon_validation_preview_not_accepted");

  const payload = obj(captured);
  const attrs = obj(payload.attributes);
  if (payload.productType !== productType ||
      payload.requirements !== "LISTING" ||
      Object.keys(payload).sort().join("|") !==
        "attributes|productType|requirements" ||
      Object.keys(attrs).some(key => !ATTRS.has(key)))
    return blocked(input, "preview_payload_not_allowlisted");

  const research = obj(await (deps.research ?? researchAmazonNewAsinProductType)(
    {marketplace, sku, product_type: productType}, env));
  const shop = obj(research.shopify);
  const brand = Array.isArray(attrs.brand) ? obj(attrs.brand[0]) : {};
  const ext = Array.isArray(attrs.externally_assigned_product_identifier) ?
    obj(attrs.externally_assigned_product_identifier[0]) : {};
  if (research.ok !== true ||
      research.status !== "REQUIREMENTS_REVIEW_REQUIRED" ||
      research.marketplace !== marketplace || research.sku !== sku ||
      research.product_type !== productType ||
      research.seller_listing_state !== "VERIFIED_ABSENT" ||
      research.ean_match_state !== "NO_EXACT_MATCH" ||
      research.read_only !== true || research.provider_mutations !== 0 ||
      shop.amazon_listing_brand !== brand.value ||
      typeof shop.ean !== "string" || !validEan(shop.ean) ||
      ext.value !== shop.ean || ext.type !== "ean" ||
      ext.marketplace_id !== marketId ||
      typeof shop.product_title !== "string" ||
      !Number.isSafeInteger(shop.shopify_available) ||
      (shop.shopify_available as number) <= 0)
    return blocked(input, "fresh_catalog_or_shopify_identity_changed");

  for (const other of ["IT", "DE", "FR", "ES"] as const) {
    let check: Row;
    try {
      check = obj(await (deps.seller ?? readAmazonSellerListingsDirect)(
        {marketplace: other, skus: [sku]}, env));
    } catch {
      return blocked(input, "other_marketplace_identity_unknown");
    }
    const rows = Array.isArray(check.results) ? check.results : [];
    if (check.ok !== true || rows.length !== 1 ||
        obj(rows[0]).sku !== sku || obj(rows[0]).state !== "VERIFIED_ABSENT")
      return blocked(input, "seller_sku_present_or_unknown_in_eu");
  }

  const liveBody = { ...payload, attributes: { ...attrs,
    fulfillment_availability: [{
      fulfillment_channel_code: "DEFAULT", quantity: 0,
      marketplace_id: marketId
    }]
  }};
  const token = await (deps.token ?? getAmazonAccessToken)(env);
  if (typeof token !== "string" || !token.trim() || token.length > 16384)
    return blocked(input, "amazon_access_token_unavailable");
  const target = new URL(HOST + "/listings/2021-08-01/items/" +
    encodeURIComponent(sellerId!) + "/" + encodeURIComponent(sku));
  target.searchParams.set("marketplaceIds", marketId);
  // Validate the EXACT submission body (including zero stock) before the live PUT.
  const validationUrl = new URL(target);
  validationUrl.searchParams.set("mode", "VALIDATION_PREVIEW");
  let exactPreview: Row;
  try {
    const check = await transport(validationUrl.toString(), {
      method: "PUT", redirect: "manual",
      headers: {
        "x-amz-access-token": token,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(liveBody),
      signal: AbortSignal.timeout(20000)
    });
    if (check.status !== 200 ||
        !/^application\\/json(?:\\s*;|$)/i.test(check.headers.get("content-type") || "")) {
      void check.body?.cancel().catch(() => {});
      return blocked(input, "exact_zero_stock_preview_http_invalid");
    }
    const payloadText = await check.text();
    if (payloadText.length > 128000) return blocked(input, "exact_zero_stock_preview_too_large");
    exactPreview = obj(JSON.parse(payloadText));
  } catch {
    return blocked(input, "exact_zero_stock_preview_unavailable");
  }
  const safeIssues = (value: unknown) =>
    Array.isArray(value) ? value.slice(0, 25).map(rawIssue => {
      const i = obj(rawIssue);
      return {
        code: typeof i.code === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(i.code) ?
          i.code : "UNKNOWN",
        attribute_names: Array.isArray(i.attributeNames) ?
          i.attributeNames.filter(x => typeof x === "string" &&
            /^[a-z_]{1,64}$/.test(x)).slice(0, 10) : []
      };
    }) : [];
  const previewIssues = safeIssues(exactPreview.issues);
  if (exactPreview.sku !== sku || exactPreview.status !== "VALID" ||
      previewIssues.length > 0) {
    return { ...blocked(input, "exact_zero_stock_preview_not_valid"),
      exact_preview_status: exactPreview.status === "INVALID" ? "INVALID" : "UNKNOWN",
      amazon_issues: previewIssues };
  }
  let response: Response;
  try {
    response = await transport(target.toString(), {
      method: "PUT", redirect: "manual",
      headers: {
        "x-amz-access-token": token,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(liveBody),
      signal: AbortSignal.timeout(20000)
    });
  } catch {
    throw new Error("refrigiwear_live_submission_uncertain_never_retry");
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => {});
    return { ok: false, status: "AMAZON_HTTP_REJECTED_OR_UNKNOWN",
      marketplace, sku, http_status: response.status,
      provider_write_attempted: true, asin_created_verified: false,
      buyable_verified: false, no_automatic_retry: true,
      no_channable_changes: true };
  }
  let ack: Row;
  try {
    const text = await response.text();
    if (text.length > 128000) throw new Error("ack_too_large");
    ack = obj(JSON.parse(text));
  } catch {
    throw new Error("refrigiwear_live_ack_uncertain_never_retry");
  }
  if (ack.sku !== sku || typeof ack.submissionId !== "string" ||
      !SUBMISSION.test(ack.submissionId) ||
      !["ACCEPTED", "INVALID"].includes(String(ack.status)))
    throw new Error("refrigiwear_live_ack_untrusted_never_retry");
  if (ack.status !== "ACCEPTED")
    return { ok: false, status: "AMAZON_REJECTED_NEW_ASIN",
      marketplace, sku, submission_reference: ack.submissionId,
      preview_was_valid: fullyValid, provider_write_attempted: true,
      asin_created_verified: false, buyable_verified: false,
      no_channable_changes: true };
  let readback: Row = {};
  try {
    readback = obj(await (deps.seller ?? readAmazonSellerListingsDirect)(
      {marketplace, skus: [sku]}, env));
  } catch { /* eventual consistency; do not assert success */ }
  const rows = Array.isArray(readback.results) ? readback.results : [];
  const listing = obj(rows[0]);
  const verified = readback.ok === true && rows.length === 1 &&
    listing.sku === sku && listing.state === "PRESENT" &&
    listing.identity_state === "VERIFIED" &&
    typeof listing.asin === "string" && ASIN.test(listing.asin);
  return { ok: true,
    status: verified ? "NEW_ASIN_SELLER_LISTING_VERIFIED" :
      "NEW_ASIN_SUBMITTED_AWAITING_READBACK",
    marketplace, sku, ...(verified ? {asin: listing.asin} : {}),
    submission_reference: ack.submissionId,
    asin_created_verified: verified, buyable_verified: false,
    provider_write_attempted: true, submitted_quantity: 0,
    no_channable_changes: true
  };
}
