import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";
import { readShopifyCatalogComplete } from "./mare-business-shopify-complete.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";
import type { AmazonCredentials } from "./amazon-auth.js";

type Row = Record<string, unknown>;
type Market = keyof typeof AMAZON_EU_MARKETPLACES;
type Env = AmazonCredentials & MareBusinessShopifyEnv & {
  AMAZON_SP_API_SELLER_ID?: string;
  [key: string]: unknown;
};

export type AmazonEuInventoryShadowDependencies = {
  readShopifyCatalog?: typeof readShopifyCatalogComplete;
  readAmazonListing?: typeof readAmazonSellerListingsDirect;
  clock?: () => number;
};

const MARKETS: readonly Market[] = ["IT", "DE", "FR", "ES"];
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const VARIANT_RE = /^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,24}$/;
const MAX_SKUS = 8;
const MAX_QUANTITY = 100_000;

function object(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function observedAt(clock: () => number): string {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime()))
    throw new Error("amazon_eu_inventory_shadow_invalid_clock");
  return new Date(value).toISOString();
}
function validate(raw: unknown): readonly string[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("amazon_eu_inventory_shadow_invalid_request");
  const row = raw as Row;
  if (Object.keys(row).length !== 1 || !Array.isArray(row.skus) ||
      row.skus.length < 1 || row.skus.length > MAX_SKUS)
    throw new Error("amazon_eu_inventory_shadow_invalid_request");
  const skus: string[] = [];
  for (const value of row.skus) {
    if (typeof value !== "string" || !SKU_RE.test(value) || value !== value.trim())
      throw new Error("amazon_eu_inventory_shadow_invalid_request");
    skus.push(value);
  }
  if (new Set(skus).size !== skus.length)
    throw new Error("amazon_eu_inventory_shadow_invalid_request");
  return Object.freeze(skus);
}

function inactiveDuplicateHasVerifiedZeroStock(variant: Row): boolean {
  if (variant.inventory_tracked !== true || variant.inventory_levels_complete !== true ||
      integer(variant.inventory_quantity) !== 0)
    return false;
  const levels = Array.isArray(variant.inventory_levels) ? variant.inventory_levels.map(object) : [];
  if (levels.length < 1 || levels.length > 100) return false;
  return levels.every(level => {
    const quantities = Array.isArray(level.quantities) ? level.quantities.map(object) : [];
    const seen = new Set<string>();
    for (const quantity of quantities) {
      const name = quantity.name;
      if (name !== "available" && name !== "committed" && name !== "on_hand") continue;
      if (seen.has(name) || integer(quantity.quantity) !== 0) return false;
      seen.add(name);
    }
    return seen.size === 3;
  });
}

function extractShopify(catalogRaw: unknown, sku: string): Row {
  const catalog = object(catalogRaw);
  if (catalog.ok !== true || catalog.truncated === true || catalog.complete_variant_pagination !== true)
    return { state: "UNKNOWN", reason: "shopify_catalog_incomplete" };
  const products = Array.isArray(catalog.products) ? catalog.products.map(object) : [];
  const matches: Array<{ product: Row; variant: Row }> = [];
  for (const product of products) {
    const variants = Array.isArray(product.variants) ? product.variants.map(object) : [];
    for (const variant of variants) if (variant.sku === sku) matches.push({ product, variant });
  }
  if (matches.length === 0)
    return { state: "UNKNOWN", reason: "shopify_sku_missing_or_duplicated" };
  const activeMatches = matches.filter(match => match.product.status === "ACTIVE");
  if (activeMatches.length !== 1) {
    return {
      state: "UNKNOWN",
      reason: activeMatches.length > 1 ? "shopify_multiple_active_sku_matches" : "shopify_no_active_sku_match",
      total_sku_matches: matches.length,
      active_sku_matches: activeMatches.length,
    };
  }
  const inactiveMatches = matches.filter(match => match.product.status !== "ACTIVE");
  if (!inactiveMatches.every(match => inactiveDuplicateHasVerifiedZeroStock(match.variant))) {
    return {
      state: "UNKNOWN",
      reason: "shopify_inactive_sku_inventory_unverified",
      total_sku_matches: matches.length,
      inactive_duplicate_count: inactiveMatches.length,
    };
  }
  const { product, variant } = activeMatches[0];
  if (product.status !== "ACTIVE" || variant.inventory_tracked !== true || variant.inventory_levels_complete !== true)
    return { state: "UNKNOWN", reason: "shopify_variant_not_sync_eligible" };
  const variantId = typeof variant.id === "string" && VARIANT_RE.test(variant.id) ? variant.id : null;
  if (!variantId) return { state: "UNKNOWN", reason: "shopify_variant_id_invalid" };
  const levels = Array.isArray(variant.inventory_levels) ? variant.inventory_levels.map(object) : [];
  if (levels.length < 1 || levels.length > 100)
    return { state: "UNKNOWN", reason: "shopify_inventory_levels_invalid" };
  let available = 0, committed = 0, onHand = 0;
  for (const level of levels) {
    const quantities = Array.isArray(level.quantities) ? level.quantities.map(object) : [];
    const byName = new Map<string, number>();
    for (const quantity of quantities) {
      if (typeof quantity.name !== "string") continue;
      const parsed = integer(quantity.quantity);
      if (parsed === null) return { state: "UNKNOWN", reason: "shopify_inventory_quantity_invalid" };
      byName.set(quantity.name, parsed);
    }
    const a = byName.get("available"), c = byName.get("committed"), o = byName.get("on_hand");
    if (a === undefined || c === undefined || o === undefined)
      return { state: "UNKNOWN", reason: "shopify_inventory_quantity_missing" };
    available += a; committed += c; onHand += o;
  }
  const scalar = integer(variant.inventory_quantity);
  if (scalar === null || scalar !== available || available > MAX_QUANTITY)
    return { state: "UNKNOWN", reason: "shopify_inventory_aggregate_mismatch" };
  return {
    state: "VERIFIED",
    variant_id: variantId,
    available,
    committed,
    on_hand: onHand,
    inactive_duplicate_count: inactiveMatches.length,
    source_unique_active_sku: true,
  };
}

function amazonProjection(raw: unknown, market: Market, sku: string): Row {
  const root = object(raw);
  if (root.ok !== true || root.marketplace !== market || root.provider_mutations !== 0 ||
      root.can_change_stock !== false || !Array.isArray(root.results))
    return { state: "UNKNOWN", reason: "amazon_observation_unverified" };
  const rows = root.results.map(object).filter(item => item.sku === sku);
  if (rows.length !== 1) return { state: "UNKNOWN", reason: "amazon_sku_observation_ambiguous" };
  const item = rows[0];
  const quantity = integer(item.current_fbm_quantity);
  const price = object(item.current_b2c_price);
  const amount = typeof price.amount === "string" ? price.amount : null;
  const currency = typeof price.currency_code === "string" ? price.currency_code : null;
  return {
    state: item.state,
    identity_state: item.identity_state,
    asin: typeof item.asin === "string" ? item.asin : null,
    product_type: typeof item.product_type === "string" ? item.product_type : null,
    statuses: Array.isArray(item.statuses) ? item.statuses : [],
    quantity_state: item.fulfillment_state,
    quantity: item.fulfillment_state === "VERIFIED" ? quantity : null,
    price_state: item.price_state,
    price: item.price_state === "VERIFIED" && amount && currency ? { amount, currency_code: currency } : null,
    observation_complete: item.observation_complete === true,
  };
}

export async function readAmazonEuInventoryShadow(
  rawInput: unknown,
  env: Env,
  dependencies: AmazonEuInventoryShadowDependencies = {},
): Promise<Row> {
  const skus = validate(rawInput);
  const clock = dependencies.clock ?? Date.now;
  const startedAt = observedAt(clock);
  const shopifyReader = dependencies.readShopifyCatalog ?? readShopifyCatalogComplete;
  const amazonReader = dependencies.readAmazonListing ?? readAmazonSellerListingsDirect;

  const shopifyBySku = new Map<string, Row>();
  for (const sku of skus) {
    try {
      const catalog = await shopifyReader({
        query: "sku:" + sku,
        max_products: 10,
        inline_limit: 10,
        include_csv: false,
        persist_artifacts: false,
      }, env);
      shopifyBySku.set(sku, extractShopify(catalog, sku));
    } catch {
      shopifyBySku.set(sku, { state: "UNKNOWN", reason: "shopify_read_failed" });
    }
  }

  const amazonByMarket = new Map<Market, Row>();
  for (const market of MARKETS) {
    try {
      amazonByMarket.set(market, object(await amazonReader({ marketplace: market, skus }, env)));
    } catch {
      amazonByMarket.set(market, {
        ok: false, marketplace: market, provider_mutations: 0, can_change_stock: false, results: [],
      });
    }
  }

  const results = skus.map(sku => {
    const shopify = shopifyBySku.get(sku) ?? { state: "UNKNOWN", reason: "shopify_observation_missing" };
    const markets: Record<string, Row> = {};
    const verifiedQuantities: number[] = [];
    const verifiedAsins: string[] = [];
    let matchingShopify = 0;
    for (const market of MARKETS) {
      const projection = amazonProjection(amazonByMarket.get(market), market, sku);
      markets[market] = projection;
      if (projection.quantity_state === "VERIFIED" && typeof projection.quantity === "number") {
        verifiedQuantities.push(projection.quantity);
        if (shopify.state === "VERIFIED" && projection.quantity === shopify.available) matchingShopify++;
      }
      if (projection.identity_state === "VERIFIED" && typeof projection.asin === "string")
        verifiedAsins.push(projection.asin);
    }
    const uniqueQuantities = [...new Set(verifiedQuantities)];
    const uniqueAsins = [...new Set(verifiedAsins)];
    return {
      sku,
      shopify,
      amazon: markets,
      verified_market_quantity_count: verifiedQuantities.length,
      unique_verified_market_quantities: uniqueQuantities,
      all_four_market_quantities_verified: verifiedQuantities.length === 4,
      all_verified_market_quantities_equal: verifiedQuantities.length > 0 && uniqueQuantities.length === 1,
      markets_matching_shopify_available: matchingShopify,
      all_four_markets_match_shopify_available: shopify.state === "VERIFIED" && matchingShopify === 4,
      verified_market_asin_count: verifiedAsins.length,
      unique_verified_asins: uniqueAsins,
      all_verified_markets_same_asin: verifiedAsins.length > 0 && uniqueAsins.length === 1,
      writer_ownership_proven: false,
    };
  });

  return {
    ok: true,
    source: "mare_amazon_eu_inventory_shadow",
    observed_at: observedAt(clock),
    observation_started_at: startedAt,
    requested_skus: skus.length,
    markets: [...MARKETS],
    results,
    read_only: true,
    provider_mutations: 0,
    can_change_inventory: false,
    can_change_price: false,
    can_publish: false,
    writer_ownership_proven: false,
    channable_ownership_transferred: false,
  };
}
