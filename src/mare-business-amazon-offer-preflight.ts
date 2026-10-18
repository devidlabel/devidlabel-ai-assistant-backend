import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { readAmazonExactMatchCandidates } from "./mare-business-amazon-matching.js";
import { readAmazonCatalogASINDetails } from "./mare-business-amazon-details.js";
import { readShopifyCatalog, type MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/**
 * READ-ONLY pilot gate for a new offer on an existing Amazon ASIN.
 * Deliberately no putListingsItem, feed submission, or quantity/price mutation.
 * All network requests to Amazon in this module are GET (except the LWA token).
 * If any data source is incomplete/unavailable, stop; never interpret a timeout as MISSING.
 */
type Row = Record<string, unknown>;
type Market = keyof typeof AMAZON_EU_MARKETPLACES;
type Env = AmazonCredentials & MareBusinessShopifyEnv & { AMAZON_SP_API_SELLER_ID?: string };
type ShopifyReader = typeof readShopifyCatalog;
type MatchReader = typeof readAmazonExactMatchCandidates;
type DetailReader = typeof readAmazonCatalogASINDetails;
const HOST = "https://sellingpartnerapi-eu.amazon.com";
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const EAN_RE = /^\d{13}$/;
const ASIN_RE = /^[A-Z0-9]{10}$/;
const SELLER_RE = /^[A-Z0-9]{8,30}$/;

function obj(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Row : {};
}
function gtinCheckDigit(code: string): boolean {
  if (!EAN_RE.test(code)) return false;
  let sum = 0;
  for (let i = code.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3)
    sum += Number(code[i]) * weight;
  return (10 - sum % 10) % 10 === Number(code[code.length - 1]);
}
function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
async function amazonGet(path: string, token: string): Promise<{ status: number; body: Row }> {
  let res: Response;
  try {
    res = await fetch(HOST + path, {
      method: "GET",
      headers: { "x-amz-access-token": token, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
  } catch { throw new Error("amazon_offer_preflight_network_error"); }
  if (res.status === 404) return { status: 404, body: {} };
  if (!res.ok) throw new Error("amazon_offer_preflight_http_" + res.status);
  try { return { status: res.status, body: obj(await res.json()) }; }
  catch { throw new Error("amazon_offer_preflight_invalid_json"); }
}

/** No write capability is reachable through this function. */
export async function readAmazonOfferOnlyPreflight(
  input: Row, env: Env,
  shopifyReader: ShopifyReader = readShopifyCatalog,
  matchReader: MatchReader = readAmazonExactMatchCandidates,
  detailReader: DetailReader = readAmazonCatalogASINDetails,
): Promise<Row> {
  const market = string(input.marketplace);
  const sku = string(input.sku);
  const ean = string(input.ean);
  const asin = string(input.asin);
  if (!Object.hasOwn(AMAZON_EU_MARKETPLACES, market) ||
      !SKU_RE.test(sku) || sku !== input.sku ||
      !gtinCheckDigit(ean) || !ASIN_RE.test(asin) ||
      Object.keys(input).some(k => !["marketplace", "sku", "ean", "asin"].includes(k))) {
    throw new Error("amazon_offer_preflight_invalid_request");
  }
  const marketplace = market as Market;
  const marketplaceId = AMAZON_EU_MARKETPLACES[marketplace];
  const sellerId = string(env.AMAZON_SP_API_SELLER_ID);
  if (!SELLER_RE.test(sellerId)) return {
    ok: false, marketplace, sku, asin, status: "BLOCKED_CONFIG",
    blocker: "amazon_seller_id_not_configured", read_only: true, has_created_offer: false,
  };

  // Shopify is the sole identity and stock source. Reject duplicates, drafts, missing EAN,
  // truncated pages, zero stock, or stale/incomplete related data.
  const shopify = obj(await shopifyReader({
    query: 'sku:"' + sku + '"',
    max_products: 50,
    inline_limit: 50,
    include_csv: false,
  }, env));
  if (shopify.ok !== true || shopify.truncated !== false ||
      !Array.isArray(shopify.products) ||
      shopify.products.length > 50 ||
      shopify.complete_variant_pagination !== true) {
    throw new Error("amazon_offer_preflight_shopify_incomplete");
  }
  const matches: Array<{ product: Row; variant: Row }> = [];
  for (const productRaw of shopify.products) {
    const product = obj(productRaw);
    for (const raw of Array.isArray(product.variants) ? product.variants : []) {
      const variant = obj(raw);
      if (variant.sku === sku) matches.push({ product, variant });
    }
  }
  if (matches.length !== 1) return {
    ok: false, marketplace, sku, asin, status: "BLOCKED_SHOPIFY_IDENTITY",
    blocker: "sku_missing_or_duplicated", read_only: true, has_created_offer: false,
  };
  const { product, variant } = matches[0];
  const stock = Number(variant.inventory_quantity);
  const price = Number(variant.price);
  const vendor = string(product.vendor);
  if (product.status !== "ACTIVE" ||
      vendor.toLowerCase() === "p448" ||
      !Number.isInteger(stock) || stock <= 0 ||
      !Number.isFinite(price) || price <= 0 ||
      variant.barcode !== ean || variant.inventory_tracked !== true ||
      variant.inventory_levels_complete !== true) {
    return {
      ok: false, marketplace, sku, asin, status: "BLOCKED_SHOPIFY_ELIGIBILITY",
      blocker: "status_stock_price_or_ean_mismatch", read_only: true, has_created_offer: false,
    };
  }

  const matched = obj(await matchReader({
    marketplace, identifier_type: "EAN", identifiers: [ean],
  }, env));
  const look = obj(matched.result);
  const ids = Array.isArray(look.identifiers) ? look.identifiers : [];
  const entry = obj(ids[0]);
  if (matched.ok !== true || look.complete !== true || ids.length !== 1 ||
      entry.ean !== ean || entry.state !== "EXACT_ONE" ||
      !Array.isArray(entry.asins) || entry.asins.length !== 1 ||
      entry.asins[0] !== asin) {
    return {
      ok: false, marketplace, sku, asin, status: "BLOCKED_CATALOG_MATCH",
      blocker: "ean_not_univocally_matched_to_asin", read_only: true, has_created_offer: false,
    };
  }
  const details = obj(await detailReader({ marketplace, asins: [asin] }, env));
  const item = obj(Array.isArray(details.results) ? details.results[0] : null);
  if (details.ok !== true || item.state !== "READ_ONLY_DETAILS_COMPLETE" ||
      item.asin !== asin || !string(item.brand) ||
      string(item.brand).toLocaleLowerCase() !== vendor.toLocaleLowerCase()) {
    return {
      ok: false, marketplace, sku, asin, status: "BLOCKED_CATALOG_ATTRIBUTES",
      blocker: "brand_or_asin_mismatch", read_only: true, has_created_offer: false,
    };
  }

  const token = await getAmazonAccessToken(env);
  const listingPath = "/listings/2021-08-01/items/" + encodeURIComponent(sellerId) +
    "/" + encodeURIComponent(sku) + "?marketplaceIds=" + encodeURIComponent(marketplaceId) +
    "&includedData=summaries,issues";
  const listing = await amazonGet(listingPath, token);
  if (listing.status === 200) return {
    ok: false, marketplace, sku, asin, status: "BLOCKED_EXISTING_OFFER",
    blocker: "seller_sku_already_exists", read_only: true, has_created_offer: false,
  };
  if (listing.status !== 404) throw new Error("amazon_offer_preflight_listing_uncertain");

  const restrictionQuery = new URLSearchParams({
    asin, sellerId, marketplaceIds: marketplaceId, conditionType: "new_new",
  });
  const restricted = await amazonGet(
    "/listings/2021-08-01/restrictions?" + restrictionQuery.toString(), token);
  if (restricted.status !== 200 || !Array.isArray(restricted.body.restrictions))
    throw new Error("amazon_offer_preflight_restrictions_unverified");
  if (restricted.body.restrictions.length > 0) return {
    ok: false, marketplace, sku, asin, status: "BLOCKED_LISTING_RESTRICTIONS",
    blocker: "amazon_restrictions_present", restrictions_count: restricted.body.restrictions.length,
    read_only: true, has_created_offer: false,
  };

  const definitionsQuery = new URLSearchParams({
    marketplaceIds: marketplaceId,
    sellerId,
    requirements: "LISTING_OFFER_ONLY",
    requirementsEnforced: "ENFORCED",
  });
  const definitions = await amazonGet(
    "/definitions/2020-09-01/productTypes/PRODUCT?" + definitionsQuery.toString(), token);
  if (definitions.status !== 200 || definitions.body.productType !== "PRODUCT" ||
      !string(obj(obj(definitions.body.schema).link).resource)) {
    throw new Error("amazon_offer_preflight_product_type_unverified");
  }

  return {
    ok: true, marketplace, sku, ean, asin,
    status: "CANDIDATE_FOR_VALIDATION_PREVIEW",
    seller_listing_absent: true, exact_ean_asin: true, brand_verified: true,
    amazon_restrictions_count: 0, product_type: "PRODUCT",
    requirements: "LISTING_OFFER_ONLY",
    product_type_version: string(definitions.body.productTypeVersion) || null,
    shopify_stock_observed: stock,
    // Seller orders, reservations, item issues/GPSR, attributes, SKU ownership and
    // live price/stock write permissions have NOT been validated yet.
    must_review_attributes_and_gpsr: true,
    must_validate_seller_order_ledger: true,
    must_verify_channable_writer_handoff: true,
    next_step: "BUILD_AND_VALIDATE_OFFER_ONLY_PAYLOAD",
    read_only: true, has_created_offer: false, live_listing_write_enabled: false,
  };
}
