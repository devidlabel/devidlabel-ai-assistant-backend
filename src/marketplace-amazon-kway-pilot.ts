import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { previewAmazonGenericEanValidation } from "./marketplace-amazon-generic-ean-preview.js";
import { researchAmazonNewAsinProductType } from "./marketplace-amazon-new-asin-research.js";
import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";
import { readAmazonCatalogByEANBatch } from "./amazon-catalog-ean-batch.js";
import { readAmazonCatalogASINDetails } from "./mare-business-amazon-details.js";
import { readAmazonSellerAsinListings } from "./mare-business-amazon-seller-asin.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/** K-Way pilot: strict validated LISTING, zero FBM stock and no price. */
type Row = Record<string, unknown>;
type Market = keyof typeof AMAZON_EU_MARKETPLACES;
type Env = AmazonCredentials & MareBusinessShopifyEnv & {
  AMAZON_SP_API_SELLER_ID?: string;
  AMAZON_OFFER_PREVIEW_ENABLED?: string;
};
type Input = Readonly<{ marketplace: Market; sku: string; product_type: string;
  source_marketplace?: Market; source_asin?: string }>;
type Deps = {
  preview?: typeof previewAmazonGenericEanValidation;
  research?: typeof researchAmazonNewAsinProductType;
  seller?: typeof readAmazonSellerListingsDirect;
  catalog?: typeof readAmazonCatalogByEANBatch;
  details?: typeof readAmazonCatalogASINDetails;
  sellerAsin?: typeof readAmazonSellerAsinListings;
  token?: typeof getAmazonAccessToken;
  fetch?: typeof fetch;
};
const HOST = "https://sellingpartnerapi-eu.amazon.com";
const MARKET_TYPES = new Set(["COAT", "HAT", "SHIRT", "BACKPACK", "SWEATER", "SWEATSHIRT", "SCARF", "HANDBAG", "COSMETIC_CASE", "STORAGE_BAG", "TOTE_BAG", "DUFFEL_BAG", "WAIST_PACK"]);
const SKU = /^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const SELLER = /^[A-Z0-9]{8,30}$/;
const EAN = /^\d{13}$/;
const ASIN = /^[A-Z0-9]{10}$/;
const SUBMISSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const QUALIFICATION_CODES = new Set(["100632", "18299", "18304", "18669"]);
const ATTRS = new Set([
  "brand", "item_name", "externally_assigned_product_identifier",
  "model_name", "model_number", "part_number", "color", "country_of_origin", "target_gender",
  "product_description", "bullet_point", "apparel_size", "shirt_size",
  "fabric_type", "item_type_name", "department", "age_range_description",
  "care_instructions", "manufacturer", "outer", "headwear_size",
  "special_size_type", "batteries_required",
  "supplier_declared_dg_hz_regulation", "item_package_dimensions",
  "item_package_weight", "list_price", "style", "weave_type",
  "closure", "water_resistance_level", "material", "fit_type",
  "collar_style", "strap_type", "lining_description", "storage_volume",
  "item_depth_width_height", "number_of_compartments", "number_of_pockets", "size",
  "inner", "capacity", "size_info", "item_dimensions", "item_length_width_height", "compartment",
  "apparel_size", "shirt_size"
]);
function obj(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ?
    value as Row : {};
}
function validated(raw: unknown): Input {
  const a = obj(raw);
  const keys = Object.keys(a).sort().join("|");
  const expansion = keys === "marketplace|product_type|sku|source_asin|source_marketplace";
  if ((!expansion && keys !== "marketplace|product_type|sku") ||
      typeof a.marketplace !== "string" ||
      !Object.hasOwn(AMAZON_EU_MARKETPLACES, a.marketplace) ||
      typeof a.sku !== "string" || !SKU.test(a.sku) ||
      a.sku !== a.sku.trim() || !a.sku.startsWith("KWAY_") ||
      typeof a.product_type !== "string" ||
      !MARKET_TYPES.has(a.product_type) ||
      (expansion && (typeof a.source_marketplace !== "string" ||
        !Object.hasOwn(AMAZON_EU_MARKETPLACES, a.source_marketplace) ||
        a.source_marketplace === a.marketplace ||
        typeof a.source_asin !== "string" || !ASIN.test(a.source_asin))))
    throw new Error("kway_pilot_request_invalid");
  return Object.freeze({marketplace: a.marketplace as Market, sku: a.sku,
    product_type: a.product_type, ...(expansion ? {
      source_marketplace: a.source_marketplace as Market, source_asin: a.source_asin as string
    } : {})});
}
function blocked(x: Input, reason: string): Row {
  return { ok: false, status: "BLOCKED_KWAY_PILOT",
    marketplace: x.marketplace, sku: x.sku, reason,
    provider_write_attempted: false, asin_created_verified: false,
    marketplace_expansion_verified: false,
    buyable_verified: false, no_channable_changes: true };
}
function validEan(ean: string): boolean {
  if (!EAN.test(ean)) return false;
  let total = 0;
  for (let i = 0; i < 12; i++) total += +ean[i] * (i % 2 ? 3 : 1);
  return (10 - total % 10) % 10 === +ean[12];
}
export async function createKwayNewAsinPilot(
  raw: unknown, env: Env, deps: Deps = {}
): Promise<Row> {
  const input = validated(raw);
  const {marketplace, sku, product_type: productType} = input;
  const expanding = input.source_marketplace !== undefined;
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
  // Unlike the exploratory Refrigiwear flow, never attempt LIVE when PTD errors remain.
  if (preview.ok !== true || preview.status !== "VALIDATION_ONLY_REVIEW_REQUIRED" ||
      preview.marketplace !== marketplace || preview.sku !== sku ||
      preview.product_type !== productType ||
      preview.provider_validation_performed !== true ||
      preview.preview_only !== true || preview.provider_mutations !== 0 ||
      preview.product_created !== false || !captured ||
      !fullyValid)
    return {
      ...blocked(input, "amazon_validation_preview_not_accepted"),
      // Safe diagnostics only: Amazon messages can contain seller contact data.
      // Never expose raw issue bodies, emails, addresses or preview payload.
      amazon_preview_issues: Array.isArray(preview.issues) ?
        preview.issues.slice(0, 25).map(raw => {
          const issue = obj(raw);
          return {
            code: typeof issue.code === "string" &&
              /^[A-Za-z0-9._-]{1,64}$/.test(issue.code) ? issue.code : "UNKNOWN",
            attribute_names: (Array.isArray(issue.attribute_names) ?
              issue.attribute_names : Array.isArray(issue.attributeNames) ?
              issue.attributeNames : []).filter(name =>
                typeof name === "string" && /^[a-z_]{1,64}$/.test(name)).slice(0, 10)
          };
        }) : [],
      amazon_preview_status: preview.provider_validation_status === "INVALID" ?
        "INVALID" : "UNKNOWN"
    };

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
      shop.amazon_listing_brand !== "K-Way" || brand.value !== "K-Way" ||
      typeof shop.ean !== "string" || !validEan(shop.ean) ||
      ext.value !== shop.ean || ext.type !== "ean" ||
      ext.marketplace_id !== marketId ||
      typeof shop.product_title !== "string" ||
      !Number.isSafeInteger(shop.shopify_available) ||
      (shop.shopify_available as number) < 0)
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
    const listing = obj(rows[0]);
    if (check.ok !== true || rows.length !== 1 || listing.sku !== sku)
      return blocked(input, "seller_sku_present_or_unknown_in_eu");
    if (!expanding || other === marketplace) {
      if (listing.state !== "VERIFIED_ABSENT")
        return blocked(input, "seller_sku_present_or_unknown_in_eu");
    } else if (listing.state === "VERIFIED_ABSENT" && other !== input.source_marketplace) {
      continue;
    } else {
      if (listing.state !== "PRESENT" || listing.identity_state !== "VERIFIED" ||
          listing.asin !== input.source_asin || listing.product_type !== productType)
        return blocked(input, "expansion_source_or_eu_identity_mismatch");
      // A zero-stock / non-BUYABLE source can still identify a product. Known
      // qualification failures cannot be waived by an empty restrictions API.
      if (!Array.isArray(listing.issue_signals) || listing.issue_signals_truncated !== false ||
          listing.listing_issues_count !== listing.issue_signals.length)
        return blocked(input, "expansion_source_qualification_unknown");
      if (listing.issue_signals.map(obj).some(issue =>
          QUALIFICATION_CODES.has(String(issue.code)) || issue.severity === "UNVERIFIED"))
        return blocked(input, "expansion_source_qualification_blocked");
    }
  }

  if (expanding) {
    // Positive identity evidence is required; merely finding a SKU abroad is
    // not permission to reuse its ASIN. Target collisions stay fail-closed.
    if (!Array.isArray(research.available_schema_attribute_names) ||
        !research.available_schema_attribute_names.includes("merchant_suggested_asin"))
      return blocked(input, "expansion_asin_binding_not_in_target_schema");
    try {
      const catalog = obj(await (deps.catalog ?? readAmazonCatalogByEANBatch)(
        env, input.source_marketplace!, [shop.ean as string]));
      const identifiers = Array.isArray(catalog.identifiers) ? catalog.identifiers : [];
      const identifier = obj(identifiers[0]);
      if (catalog.read_only !== true || catalog.complete !== true ||
          catalog.marketplace !== input.source_marketplace ||
          catalog.marketplace_id !== AMAZON_EU_MARKETPLACES[input.source_marketplace!] ||
          catalog.identifiers_count !== 1 || identifiers.length !== 1 ||
          identifier.ean !== shop.ean || identifier.state !== "EXACT_ONE" ||
          identifier.exact_match_count !== 1 || !Array.isArray(identifier.asins) ||
          identifier.asins.length !== 1 || identifier.asins[0] !== input.source_asin)
        return blocked(input, "expansion_source_ean_asin_not_unique");
      const details = obj(await (deps.details ?? readAmazonCatalogASINDetails)(
        {marketplace: input.source_marketplace, asins: [input.source_asin]}, env));
      const rows = Array.isArray(details.results) ? details.results : [];
      const source = obj(rows[0]);
      if (details.ok !== true || details.read_only !== true ||
          details.marketplace !== input.source_marketplace || rows.length !== 1 ||
          source.state !== "READ_ONLY_DETAILS_COMPLETE" || source.asin !== input.source_asin ||
          source.brand !== "K-Way" || !Array.isArray(source.product_types) ||
          source.product_types.length !== 1 || source.product_types[0] !== productType)
        return blocked(input, "expansion_source_brand_or_type_mismatch");
      const collision = obj(await (deps.sellerAsin ?? readAmazonSellerAsinListings)(
        {marketplace, asins: [input.source_asin]}, env));
      const found = Array.isArray(collision.results) ? collision.results : [];
      const match = obj(found[0]);
      if (collision.ok !== true || collision.read_only !== true ||
          collision.marketplace !== marketplace || collision.complete_evidence !== true ||
          found.length !== 1 || match.asin !== input.source_asin ||
          match.state !== "NO_SELLER_ASIN_IN_BOUNDED_SEARCH" || match.query_complete !== true ||
          !Array.isArray(match.skus) || match.skus.length !== 0)
        return blocked(input, "expansion_target_asin_present_or_unknown");
    } catch {
      return blocked(input, "expansion_identity_read_unavailable");
    }
  }

  const liveBody = { ...payload, attributes: { ...attrs,
    ...(expanding ? {merchant_suggested_asin: [{
      value: input.source_asin, marketplace_id: marketId
    }]} : {}),
    fulfillment_availability: [{
      fulfillment_channel_code: "DEFAULT", quantity: 0,
      marketplace_id: marketId
    }]
  }};
  const token = await (deps.token ?? getAmazonAccessToken)(env);
  if (typeof token !== "string" || !token.trim() || token.length > 16384)
    return blocked(input, "amazon_access_token_unavailable");
  if (expanding) {
    const restrictionsUrl = new URL(HOST + "/listings/2021-08-01/restrictions");
    restrictionsUrl.searchParams.set("asin", input.source_asin!);
    restrictionsUrl.searchParams.set("sellerId", sellerId!);
    restrictionsUrl.searchParams.set("marketplaceIds", marketId);
    restrictionsUrl.searchParams.set("conditionType", "new_new");
    try {
      const response = await transport(restrictionsUrl.toString(), {
        method: "GET", redirect: "manual",
        headers: {"x-amz-access-token": token, Accept: "application/json"},
        signal: AbortSignal.timeout(20000)
      });
      if (response.status !== 200 ||
          !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) {
        void response.body?.cancel().catch(() => {});
        return blocked(input, "expansion_target_restrictions_unverified");
      }
      const text = await response.text();
      if (text.length > 128000) return blocked(input, "expansion_target_restrictions_unverified");
      const restrictions = obj(JSON.parse(text));
      if (!Array.isArray(restrictions.restrictions) || restrictions.restrictions.length !== 0 ||
          restrictions.errors !== undefined)
        return blocked(input, "expansion_target_restricted_or_unknown");
    } catch {
      return blocked(input, "expansion_target_restrictions_unverified");
    }
    // Empty restrictions are only one gate, never proof of brand approval or
    // BUYABLE status. The exact target payload must still pass live preview.
  }
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
        !/^application\/json(?:\s*;|$)/i.test(check.headers.get("content-type") || "")) {
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
        ...(["ERROR", "WARNING", "INFO"].includes(String(i.severity)) ? {severity: i.severity} : {}),
        attribute_names: Array.isArray(i.attributeNames) ?
          i.attributeNames.filter(x => typeof x === "string" &&
            /^[a-z_]{1,64}$/.test(x)).slice(0, 10) : []
      };
    }) : [];
  const previewIssues = safeIssues(exactPreview.issues);
  // Inspect the complete provider array before truncating safe diagnostics.
  // WARNING / INFO do not reject a VALID preview; malformed evidence, ERROR
  // and known qualification signals remain hard gates in both modes.
  const exactIssues = Array.isArray(exactPreview.issues) ? exactPreview.issues : null;
  const issuesVerified = exactIssues !== null && exactIssues.every(rawIssue => {
    const issue = obj(rawIssue);
    return typeof issue.code === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(issue.code) &&
      ["ERROR", "WARNING", "INFO"].includes(String(issue.severity)) &&
      (issue.attributeNames === undefined || (Array.isArray(issue.attributeNames) &&
        issue.attributeNames.every(name => typeof name === "string" && /^[a-z_]{1,64}$/.test(name))));
  });
  const blockingIssue = exactIssues?.some(rawIssue => {
    const issue = obj(rawIssue);
    return issue.severity === "ERROR" || QUALIFICATION_CODES.has(String(issue.code));
  });
  if (exactPreview.sku !== sku || exactPreview.status !== "VALID" ||
      !issuesVerified || blockingIssue) {
    return { ...blocked(input, "exact_zero_stock_preview_not_valid"),
      exact_preview_status: ["VALID", "INVALID"].includes(String(exactPreview.status)) ? exactPreview.status : "UNKNOWN",
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
    throw new Error("kway_live_submission_uncertain_never_retry");
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
    throw new Error("kway_live_ack_uncertain_never_retry");
  }
  if (ack.sku !== sku || typeof ack.submissionId !== "string" ||
      !SUBMISSION.test(ack.submissionId) ||
      !["ACCEPTED", "INVALID"].includes(String(ack.status)))
    throw new Error("kway_live_ack_untrusted_never_retry");
  if (ack.status !== "ACCEPTED")
    return { ok: false, status: expanding ? "AMAZON_REJECTED_MARKETPLACE_EXPANSION" : "AMAZON_REJECTED_NEW_ASIN",
      amazon_issues: safeIssues(ack.issues),
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
    typeof listing.asin === "string" && ASIN.test(listing.asin) &&
    (!expanding || (listing.asin === input.source_asin && listing.product_type === productType));
  return { ok: true,
    status: expanding ? (verified ? "MARKETPLACE_EXPANSION_VERIFIED" :
      "MARKETPLACE_EXPANSION_SUBMITTED_AWAITING_READBACK") :
      (verified ? "NEW_ASIN_SELLER_LISTING_VERIFIED" : "NEW_ASIN_SUBMITTED_AWAITING_READBACK"),
    marketplace, sku, ...(verified ? {asin: listing.asin} : {}),
    ...(expanding ? {source_marketplace: input.source_marketplace, source_asin: input.source_asin} : {}),
    submission_reference: ack.submissionId,
    exact_preview_status: "VALID", amazon_issues: previewIssues,
    asin_created_verified: verified && !expanding,
    marketplace_expansion_verified: verified && expanding, buyable_verified: false,
    provider_write_attempted: true, submitted_quantity: 0,
    no_channable_changes: true
  };
}
