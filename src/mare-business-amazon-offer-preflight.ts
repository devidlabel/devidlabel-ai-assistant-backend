import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { readAmazonExactMatchCandidates } from "./mare-business-amazon-matching.js";
import { readAmazonCatalogASINDetails } from "./mare-business-amazon-details.js";
import { readAmazonSellerAsinListings } from "./mare-business-amazon-seller-asin.js";
import { readShopifyCatalogComplete } from "./mare-business-shopify-complete.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/**
 * Fail-closed, read-only inspection of a prospective OFFER-ONLY Amazon listing.
 * This file deliberately contains NO Listings Items PUT/PATCH, feed submission,
 * inventory mutation or approval input. REVIEW_REQUIRED never authorizes writes.
 */
type Row = Record<string, unknown>;
type Market = keyof typeof AMAZON_EU_MARKETPLACES;
type Env = AmazonCredentials & MareBusinessShopifyEnv & { AMAZON_SP_API_SELLER_ID?: string };
type ShopifyReader = typeof readShopifyCatalogComplete;
type MatchReader = typeof readAmazonExactMatchCandidates;
type DetailReader = typeof readAmazonCatalogASINDetails;
const HOST = "https://sellingpartnerapi-eu.amazon.com";
const MARKETS = AMAZON_EU_MARKETPLACES;
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const EAN_RE = /^\d{13}$/;
const ASIN_RE = /^[A-Z0-9]{10}$/;
const SELLER_RE = /^[A-Z0-9]{8,30}$/;
const MONEY_RE = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/;

function obj(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Row : {};
}
function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function checkEAN(code: string): boolean {
  if (!EAN_RE.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - sum % 10) % 10 === Number(code[12]);
}
function blocked(marketplace: Market, sku: string, asin: string, status: string, reason: string): Row {
  return {
    ok: false, marketplace, sku, asin, status, blocker: reason,
    read_only: true, has_created_offer: false, live_listing_write_enabled: false
  };
}
function allVariants(rows: unknown[]): Array<{ product: Row; variant: Row }> {
  const out: Array<{ product: Row; variant: Row }> = [];
  for (const item of rows) {
    const product = obj(item);
    if (!Array.isArray(product.variants)) throw new Error("amazon_offer_preflight_shopify_variants_missing");
    for (const raw of product.variants) out.push({ product, variant: obj(raw) });
  }
  return out;
}
function verifiedShopifyResult(data: unknown): Row {
  const result = obj(data);
  if (result.ok !== true || result.truncated !== false ||
      result.complete_variant_pagination !== true ||
      !Array.isArray(result.products) ||
      !Number.isSafeInteger(result.product_count) ||
      result.product_count !== result.products.length ||
      result.product_count > 50 ||
      result.inline_product_count !== result.product_count) {
    throw new Error("amazon_offer_preflight_shopify_incomplete");
  }
  return result;
}
function normalizeOption(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/[\s_-]+/g," ");
}
function selectedOption(variant: Row, name: RegExp): string {
  if (!Array.isArray(variant.selected_options)) return "";
  const match = variant.selected_options.map(obj).find(x => name.test(string(x.name)));
  return string(match?.value);
}

type AmazonRead = { status: number; body: Row; requestId: string | null; validJson: boolean };
async function amazonGet(path: string, token: string): Promise<AmazonRead> {
  let response: Response;
  try {
    response = await fetch(HOST + path, {
      method: "GET",
      headers: { "x-amz-access-token": token, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
      redirect: "error"
    });
  } catch { throw new Error("amazon_offer_preflight_network_error"); }
  const requestId = string(response.headers.get("x-amzn-requestid") ||
    response.headers.get("x-amzn-request-id")).slice(0,128) || null;
  if (response.status === 404) {
    if (!(response.headers.get("content-type") || "").toLowerCase().includes("application/json"))
      return { status: 404, body: {}, requestId, validJson: false };
    try {
      const parsed = obj(await response.json());
      return { status: 404, body: parsed, requestId, validJson: true };
    } catch { return { status: 404, body: {}, requestId, validJson: false }; }
  }
  if (!response.ok) throw new Error("amazon_offer_preflight_http_" + response.status);
  try { return { status: response.status, body: obj(await response.json()), requestId, validJson: true }; }
  catch { throw new Error("amazon_offer_preflight_invalid_json"); }
}
function verifiedNotFound(result: AmazonRead): boolean {
  if (result.status !== 404 || !result.validJson || !result.requestId) return false;
  const errors = result.body.errors;
  return Array.isArray(errors) && errors.length === 1 &&
    ["NOT_FOUND", "NotFound"].includes(string(obj(errors[0]).code));
}
function definitionValidated(definition: Row, marketplaceId: string): {version:string;checksum:string} | null {
  const schema = obj(definition.schema);
  const schemaLink = obj(schema.link);
  const version = obj(definition.productTypeVersion);
  const link = string(schemaLink.resource);
  let schemaUrl: URL;
  try { schemaUrl = new URL(link); } catch { return null; }
  if (schemaUrl.protocol !== "https:" || schemaUrl.username || schemaUrl.password) return null;
  if (definition.productType !== "PRODUCT" ||
      definition.requirements !== "LISTING_OFFER_ONLY" ||
      definition.requirementsEnforced !== "ENFORCED" ||
      !Array.isArray(definition.marketplaceIds) ||
      definition.marketplaceIds.length !== 1 ||
      definition.marketplaceIds[0] !== marketplaceId ||
      schemaLink.verb !== "GET" || !string(schema.checksum) ||
      !string(version.version) || version.latest !== true) return null;
  return { version: string(version.version), checksum: string(schema.checksum) };
}

/** Caller cannot claim a reviewed product, writer ownership or permission to publish. */
export async function readAmazonOfferOnlyPreflight(
  input: Row, env: Env,
  shopifyReader: ShopifyReader = readShopifyCatalogComplete,
  matchReader: MatchReader = readAmazonExactMatchCandidates,
  detailReader: DetailReader = readAmazonCatalogASINDetails,
  sellerAsinReader: typeof readAmazonSellerAsinListings = readAmazonSellerAsinListings
): Promise<Row> {
  const market = string(input.marketplace);
  const sku = string(input.sku);
  const ean = string(input.ean);
  const asin = string(input.asin);
  if (!Object.hasOwn(MARKETS, market) || !SKU_RE.test(sku) ||
      sku !== input.sku || !checkEAN(ean) || !ASIN_RE.test(asin) ||
      Object.keys(input).some(k => !["marketplace", "sku", "ean", "asin"].includes(k))) {
    throw new Error("amazon_offer_preflight_invalid_request");
  }
  const marketplace = market as Market;
  const marketplaceId = MARKETS[marketplace];
  const sellerId = string(env.AMAZON_SP_API_SELLER_ID);
  if (!SELLER_RE.test(sellerId)) {
    return blocked(marketplace, sku, asin, "BLOCKED_CONFIG", "amazon_seller_id_not_configured");
  }

  // Product search defaults to active-only: explicitly include every Shopify
  // status so draft/archived/unlisted duplicate SKU identities are not hidden.
  const search = (key: "sku"|"barcode", value: string) => ({
    query: key + ':"' + value + '" status:active,draft,archived,unlisted',
    max_products: 50,
    inline_limit: 50,
    include_csv: false,
    persist_artifacts: false,
    stable_order: true
  });
  const bySku = verifiedShopifyResult(
    await shopifyReader(search("sku", sku), env));
  const skuMatches = allVariants(bySku.products as unknown[]).filter(row => row.variant.sku === sku);
  if (skuMatches.length !== 1) {
    return blocked(marketplace, sku, asin, "BLOCKED_SHOPIFY_IDENTITY", "sku_missing_or_duplicated");
  }
  const { product, variant } = skuMatches[0];
  const barcodeMatches = verifiedShopifyResult(
    await shopifyReader(search("barcode", ean), env));
  const eanMatches = allVariants(barcodeMatches.products as unknown[])
    .filter(row => row.variant.barcode === ean);
  if (eanMatches.length !== 1 || !string(variant.id) ||
      eanMatches[0].variant.id !== variant.id) {
    return blocked(marketplace, sku, asin, "BLOCKED_SHOPIFY_IDENTITY", "ean_missing_or_duplicated");
  }

  const stock = variant.inventory_quantity;
  const price = variant.price;
  const vendor = string(product.vendor);
  if (product.status !== "ACTIVE" || vendor.toLowerCase() === "p448" ||
      typeof stock !== "number" || !Number.isSafeInteger(stock) || stock <= 0 ||
      typeof price !== "string" || !MONEY_RE.test(price) || Number(price) <= 0 ||
      variant.barcode !== ean || variant.inventory_tracked !== true ||
      variant.inventory_levels_complete !== true ||
      !Array.isArray(variant.inventory_levels) || variant.inventory_levels.length === 0) {
    return blocked(marketplace, sku, asin, "BLOCKED_SHOPIFY_ELIGIBILITY",
      "status_stock_price_inventory_or_ean_invalid");
  }

  const matched = obj(await matchReader({
    marketplace, identifier_type: "EAN", identifiers: [ean]
  }, env));
  const result = obj(matched.result);
  const identities = Array.isArray(result.identifiers) ? result.identifiers : [];
  const identity = obj(identities[0]);
  if (matched.ok !== true || result.complete !== true ||
      result.marketplace !== marketplace || identities.length !== 1 ||
      identity.ean !== ean || identity.state !== "EXACT_ONE" ||
      !Array.isArray(identity.asins) || identity.asins.length !== 1 ||
      identity.asins[0] !== asin) {
    return blocked(marketplace, sku, asin, "BLOCKED_CATALOG_MATCH", "ean_not_univocally_matched_to_asin");
  }

  const details = obj(await detailReader({ marketplace, asins: [asin] }, env));
  const item = obj(Array.isArray(details.results) ? details.results[0] : null);
  if (details.ok !== true || details.marketplace !== marketplace ||
      item.state !== "READ_ONLY_DETAILS_COMPLETE" || item.asin !== asin ||
      !vendor || !string(item.brand) ||
      normalizeOption(string(item.brand)) !== normalizeOption(vendor) ||
      !Array.isArray(item.product_types) || item.product_types.length === 0) {
    return blocked(marketplace, sku, asin, "BLOCKED_CATALOG_ATTRIBUTES", "brand_asin_or_product_type_mismatch");
  }
  // EAN equality does NOT establish a compatible commercial product.
  // Observed case: a Shopify "Pochette e Borselli" item has an Amazon
  // productType "LABEL". Do not validate a bag offer against a label page.
  // This intentionally only blocks *known clearly incompatible* types;
  // other product types remain REVIEW_REQUIRED for manual schema checks.
  const shopifyProductType=string(product.product_type).toLocaleLowerCase();
  const fashionAccessory=/pochette|borsell|borsa|borse|handbag|backpack|zain|wallet|portafogli/i
    .test(shopifyProductType);
  const catalogTypes=(item.product_types as unknown[])
    .map(x=>string(x).toLocaleUpperCase()).filter(Boolean);
  const clearlyNonAccessory=new Set(["LABEL","STICKER","GIFT_CARD","SHIPPING_LABEL"]);
  if(fashionAccessory && catalogTypes.length>0 &&
      catalogTypes.every(x=>clearlyNonAccessory.has(x))) {
    return blocked(marketplace,sku,asin,"BLOCKED_CATALOG_ATTRIBUTES",
      "amazon_product_type_incompatible_with_shopify_category");
  }
  const classification = string(item.item_classification).toLocaleUpperCase();
  if (classification.includes("PARENT")) {
    return blocked(marketplace, sku, asin, "BLOCKED_CATALOG_ATTRIBUTES", "parent_asin_not_sellable_variant");
  }
  const desiredColor = selectedOption(variant, /^(color|colour|colore)$/i);
  const desiredSize = selectedOption(variant, /^(size|taglia)$/i);
  if ((desiredColor && string(item.color) &&
       normalizeOption(desiredColor) !== normalizeOption(string(item.color))) ||
      (desiredSize && string(item.size) &&
       normalizeOption(desiredSize) !== normalizeOption(string(item.size)))) {
    return blocked(marketplace, sku, asin, "BLOCKED_CATALOG_ATTRIBUTES", "variant_attributes_mismatch");
  }

  const token = await getAmazonAccessToken(env);
  const listingPath = "/listings/2021-08-01/items/" + encodeURIComponent(sellerId) +
    "/" + encodeURIComponent(sku) + "?marketplaceIds=" + encodeURIComponent(marketplaceId) +
    "&includedData=summaries,issues";
  const listing = await amazonGet(listingPath, token);
  if (listing.status === 200) {
    return blocked(marketplace, sku, asin, "BLOCKED_EXISTING_OFFER", "seller_sku_already_exists");
  }
  if (!verifiedNotFound(listing)) {
    return blocked(marketplace, sku, asin, "BLOCKED_LISTING_STATUS_UNKNOWN",
      "seller_sku_absence_not_verified");
  }

  // A missing seller SKU is not enough: Channable may already own the same
  // ASIN with a different SKU. Search the SELLER's complete ASIN listing
  // before any preview readiness classification. No non-absence is presumed.
  const sellerAsin = obj(await sellerAsinReader({
    marketplace,asins:[asin]
  },env));
  const sellerAsinRows=Array.isArray(sellerAsin.results)?sellerAsin.results:[];
  const sellerAsinItem=obj(sellerAsinRows[0]);
  if(sellerAsin.ok!==true||
      sellerAsin.source!=="amazon_sp_api_search_listings_items_by_asin"||
      sellerAsin.marketplace!==marketplace||
      sellerAsin.read_only!==true||
      sellerAsinRows.length!==1||
      sellerAsinItem.asin!==asin||
      sellerAsinItem.query_complete!==true||
      sellerAsin.can_create_offer!==false||
      sellerAsin.no_provider_writes!==true) {
    return blocked(marketplace,sku,asin,"BLOCKED_LISTING_STATUS_UNKNOWN",
      "seller_asin_search_incomplete_or_unverified");
  }
  if(sellerAsinItem.state==="SELLER_ASIN_LISTING_FOUND") {
    return blocked(marketplace,sku,asin,"BLOCKED_EXISTING_OFFER",
      "seller_has_asin_under_other_sku");
  }
  if(sellerAsinItem.state!=="NO_SELLER_ASIN_IN_BOUNDED_SEARCH"||
      !Array.isArray(sellerAsinItem.skus)||sellerAsinItem.skus.length!==0) {
    return blocked(marketplace,sku,asin,"BLOCKED_LISTING_STATUS_UNKNOWN",
      "seller_asin_absence_not_supported_by_search");
  }

  const restrictionsQuery = new URLSearchParams({
    asin, sellerId, marketplaceIds: marketplaceId, conditionType: "new_new"
  });
  const restricted = await amazonGet(
    "/listings/2021-08-01/restrictions?" + restrictionsQuery.toString(), token);
  if (restricted.status !== 200 || !Array.isArray(restricted.body.restrictions)) {
    return blocked(marketplace, sku, asin, "BLOCKED_RESTRICTIONS_UNKNOWN", "amazon_restrictions_unverified");
  }
  if (restricted.body.restrictions.length > 0) {
    return blocked(marketplace, sku, asin, "BLOCKED_LISTING_RESTRICTIONS", "amazon_restrictions_present");
  }

  // PRODUCT is an offer-only option, not permission to create product facts.
  // The specific catalog type and every variation attribute remain under review.
  const definitionsQuery = new URLSearchParams({
    marketplaceIds: marketplaceId,
    sellerId,
    requirements: "LISTING_OFFER_ONLY",
    requirementsEnforced: "ENFORCED"
  });
  const definition = await amazonGet(
    "/definitions/2020-09-01/productTypes/PRODUCT?" + definitionsQuery.toString(), token);
  const metadata = definition.status === 200
    ? definitionValidated(definition.body, marketplaceId) : null;
  if (!metadata) {
    return blocked(marketplace, sku, asin, "BLOCKED_PRODUCT_TYPE",
      "offer_only_definition_unverified");
  }
  return {
    ok: true, marketplace, sku, ean, asin,
    status: "REVIEW_REQUIRED",
    exact_ean_asin: true,
    seller_listing_absence_result: "NOT_FOUND_VERIFIED_BY_LISTINGS_API",
    seller_asin_search_result: "NO_SELLER_ASIN_IN_BOUNDED_SEARCH",
    seller_asin_search_is_not_final_absence_proof: true,
    listing_request_id: listing.requestId,
    restriction_count: 0,
    schema_requirements: "LISTING_OFFER_ONLY",
    schema_product_type: "PRODUCT",
    schema_version: metadata.version,
    schema_checksum: metadata.checksum,
    shopify_stock_observed: stock,
    shopify_price_minor: Number(price.split(".")[0])*100 + Number((price.split(".")[1] || "").padEnd(2,"0")),
    shopify_currency: "EUR",
    product_variant_id: variant.id,
    review_required: [
      "seller_identity_and_listing_known_positive_control",
      "seller_asin_independent_absence_and_channable_writer_proof",
      "catalog_color_size_model_and_child_asin",
      "offer_attributes_gpsr_product_type_schema",
      "live_order_stock_budget",
      "channable_writer_ownership"
    ],
    next_step: "HUMAN_REVIEW_THEN_PROVIDER_VALIDATION_PREVIEW",
    read_only: true, has_created_offer: false, live_listing_write_enabled: false
  };
}
