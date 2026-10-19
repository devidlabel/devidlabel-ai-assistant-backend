import { readAmazonEuInventoryShadow } from "./marketplace-amazon-eu-inventory-shadow.js";
import { readShopifyCatalogComplete } from "./mare-business-shopify-complete.js";
import { readAmazonExactMatchCandidates } from "./mare-business-amazon-matching.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";
import type { AmazonCredentials } from "./amazon-auth.js";

/**
 * Private, zero-write SKU/market classifier. No catalog absence inference from
 * a missing EAN hit, no offer creation eligibility, and no Channable handoff.
 * Counts are snapshots only, never feed a mutation path.
 */
type Row = Record<string, unknown>;
type Market = "IT" | "DE" | "FR" | "ES";
type Env = AmazonCredentials & MareBusinessShopifyEnv & { AMAZON_SP_API_SELLER_ID?: string };
export type SneakerStateClassifierDependencies = {
  readShadow?: typeof readAmazonEuInventoryShadow;
  readShopify?: typeof readShopifyCatalogComplete;
  readMatch?: typeof readAmazonExactMatchCandidates;
  clock?: () => number;
};
const MARKETS: readonly Market[] = ["IT", "DE", "FR", "ES"];
const SKU = /^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const ASIN = /^[A-Z0-9]{10}$/;
const EAN = /^\d{13}$/;
const MAX_SKUS = 8;

function obj(v: unknown): Row {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
}
function parse(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("amazon_sneaker_classify_invalid_request");
  const input = raw as Row;
  if (Object.keys(input).length !== 1 || !Array.isArray(input.skus) ||
      input.skus.length < 1 || input.skus.length > MAX_SKUS ||
      !input.skus.every(v => typeof v === "string" && SKU.test(v) && v.trim() === v) ||
      new Set(input.skus).size !== input.skus.length)
    throw new Error("amazon_sneaker_classify_invalid_request");
  return input.skus as string[];
}
function validEAN(v: unknown): v is string {
  if (typeof v !== "string" || !EAN.test(v)) return false;
  const sum = [...v.slice(0, 12)].reduce((acc, digit, i) => acc + Number(digit) * (i % 2 ? 3 : 1), 0);
  return (10 - sum % 10) % 10 === Number(v[12]);
}
function completeCatalog(raw: unknown): boolean {
  const c = obj(raw);
  return c.ok === true && c.truncated !== true && c.complete_variant_pagination === true &&
    Array.isArray(c.products) && Number.isSafeInteger(c.product_count) &&
    typeof c.product_count === "number" && c.product_count <= 50 &&
    c.product_count === c.inline_product_count;
}
function lookupVariant(catalog: unknown, sku: string, variantId: unknown): Row | null {
  if (!completeCatalog(catalog) || typeof variantId !== "string") return null;
  const found: Row[] = [];
  for (const productRaw of obj(catalog).products as unknown[]) {
    const product = obj(productRaw);
    if (product.status !== "ACTIVE" || !Array.isArray(product.variants)) continue;
    for (const variantRaw of product.variants) {
      const v = obj(variantRaw);
      if (v.sku === sku) found.push(v);
    }
  }
  return found.length === 1 && found[0].id === variantId ? found[0] : null;
}
function barcodeUnique(catalog: unknown, ean: string, variantId: unknown): boolean {
  if (!completeCatalog(catalog) || typeof variantId !== "string") return false;
  let seen = 0;
  for (const productRaw of obj(catalog).products as unknown[]) {
    const product = obj(productRaw);
    if (!Array.isArray(product.variants)) return false;
    for (const variantRaw of product.variants) {
      const v = obj(variantRaw);
      if (v.barcode === ean) {
        seen++;
        if (v.id !== variantId) return false;
      }
    }
  }
  return seen === 1;
}
function exactMatch(root: unknown, marketplace: Market, requested: string[]): Map<string, Row> | null {
  const v = obj(root), result = obj(v.result);
  if (v.ok !== true || v.read_only !== true || v.has_created_offer !== false ||
      result.complete !== true || result.marketplace !== marketplace ||
      !Array.isArray(result.identifiers) || result.identifiers.length !== requested.length)
    return null;
  const map = new Map<string, Row>();
  for (const raw of result.identifiers) {
    const x = obj(raw);
    if (typeof x.ean !== "string" || !requested.includes(x.ean) || map.has(x.ean) ||
        !Array.isArray(x.asins) || typeof x.exact_match_count !== "number") return null;
    if (x.state === "EXACT_ONE") {
      if (x.exact_match_count !== 1 || x.asins.length !== 1 || !ASIN.test(String(x.asins[0]))) return null;
    } else if (x.state === "NO_EXACT_MATCH") {
      if (x.exact_match_count !== 0 || x.asins.length !== 0) return null;
    } else {
      // Ambiguous EAN -> unknown, never permission for product creation.
      map.set(x.ean, {state:"AMBIGUOUS"}); continue;
    }
    map.set(x.ean, x);
  }
  return map.size === requested.length ? map : null;
}
export async function classifyAmazonSneakerSkuStates(
  request: unknown, env: Env, dependencies: SneakerStateClassifierDependencies = {},
): Promise<Row> {
  const skus = parse(request);
  const at = new Date((dependencies.clock ?? Date.now)()).toISOString();
  let shadow: Row;
  try { shadow = obj(await (dependencies.readShadow ?? readAmazonEuInventoryShadow)({skus}, env)); }
  catch { return {ok:false,status:"BLOCKED_SHADOW",read_only:true,provider_mutations:0,can_publish:false}; }
  if (shadow.ok !== true || shadow.read_only !== true || shadow.provider_mutations !== 0 ||
      shadow.can_publish !== false || !Array.isArray(shadow.results) ||
      shadow.results.length !== skus.length)
    return {ok:false,status:"BLOCKED_SHADOW",read_only:true,provider_mutations:0,can_publish:false};
  const rows = new Map<string, Row>();
  for (const raw of shadow.results) {
    const item = obj(raw);
    if (typeof item.sku !== "string" || !skus.includes(item.sku) || rows.has(item.sku))
      return {ok:false,status:"BLOCKED_SHADOW",read_only:true,provider_mutations:0,can_publish:false};
    rows.set(item.sku, item);
  }

  const reader = dependencies.readShopify ?? readShopifyCatalogComplete;
  const codes = new Map<string, string>();
  const blockers = new Map<string, string>();
  for (const sku of skus) {
    const row = rows.get(sku)!, shopify = obj(row.shopify);
    if (shopify.state !== "VERIFIED" || shopify.source_unique_active_sku !== true) {
      blockers.set(sku,"shopify_identity_unverified"); continue;
    }
    try {
      const c = await reader({
        query: 'sku:"' + sku + '" status:active,draft,archived,unlisted',
        max_products:50,inline_limit:50,include_csv:false,stable_order:true,persist_artifacts:false,
      }, env);
      const variant = lookupVariant(c, sku, shopify.variant_id);
      if (!variant || !validEAN(variant.barcode)) {
        blockers.set(sku,"shopify_sku_or_ean_unverified"); continue;
      }
      const ean = variant.barcode;
      const byBarcode = await reader({
        query:'barcode:"' + ean + '" status:active,draft,archived,unlisted',
        max_products:50,inline_limit:50,include_csv:false,stable_order:true,persist_artifacts:false,
      }, env);
      if (!barcodeUnique(byBarcode, ean, shopify.variant_id)) {
        blockers.set(sku,"shopify_ean_duplicated_or_incomplete"); continue;
      }
      codes.set(sku,ean);
    } catch { blockers.set(sku,"shopify_ean_read_unverified"); }
  }
  const uniqueCodes = [...new Set(codes.values())];
  if (uniqueCodes.length !== codes.size) {
    for (const [sku,code] of codes) if ([...codes.values()].filter(x=>x===code).length>1) {
      codes.delete(sku); blockers.set(sku,"shopify_ean_duplicate_in_batch");
    }
  }
  const matches = new Map<Market, Map<string, Row> | null>();
  for (const m of MARKETS) {
    if (!codes.size) { matches.set(m,new Map()); continue; }
    try {
      const response = await (dependencies.readMatch ?? readAmazonExactMatchCandidates)({
        marketplace:m,identifier_type:"EAN",identifiers:[...codes.values()],
      },env);
      matches.set(m,exactMatch(response,m,[...codes.values()]));
    } catch { matches.set(m,null); }
  }

  const counts: Record<string, Record<string, number>> = {};
  const results = skus.map(sku => {
    const row = rows.get(sku)!, shopify = obj(row.shopify), sellerMarkets = obj(row.amazon);
    const ean = codes.get(sku), markets: Record<string, Row> = {};
    for (const m of MARKETS) {
      const seller = obj(sellerMarkets[m]), match = ean ? matches.get(m)?.get(ean) : null;
      const asin = typeof seller.asin === "string" && ASIN.test(seller.asin) ? seller.asin : null;
      const candidate = match?.state === "EXACT_ONE" && Array.isArray(match.asins) ? match.asins[0] as string : null;
      const sellerState = typeof seller.state === "string" ? seller.state : "UNKNOWN";
      let status = "RECHECK_REQUIRED";
      if (!ean) status = "SHOPIFY_EAN_BLOCKED";
      else if (sellerState === "PRESENT" && seller.identity_state === "VERIFIED" && asin) {
        status = candidate && candidate !== asin ? "BLOCKED_ASIN_CONFLICT"
          : Array.isArray(seller.statuses) && seller.statuses.includes("BUYABLE")
            ? "SELLER_BUYABLE" : "SELLER_PRESENT_NOT_BUYABLE";
      } else if (sellerState === "PRESENT_ATTRIBUTES_UNKNOWN")
        status = "SELLER_PRESENT_NEEDS_DIAGNOSTICS";
      else if (sellerState === "VERIFIED_ABSENT" && match?.state === "EXACT_ONE")
        status = "EXISTING_ASIN_CANDIDATE";
      else if (sellerState === "VERIFIED_ABSENT" && match?.state === "NO_EXACT_MATCH")
        status = "NEW_ASIN_RESEARCH_REQUIRED";
      markets[m] = {
        status, seller_listing_state:sellerState,
        seller_asin:asin,catalog_ean_match:match?.state || "UNKNOWN",
        catalog_candidate_asin:candidate,
        is_publish_eligible:false, needs_product_identity_brand_size_color_review:true,
      };
      counts[m] ??= {};
      counts[m][status] = (counts[m][status] || 0) + 1;
    }
    return {sku, shopify_state:shopify.state || "UNKNOWN",ean_verified:Boolean(ean),
      ean:ean||null,blocker:blockers.get(sku)||null,markets};
  });
  return {ok:true,source:"amazon_sneaker_state_classifier",observed_at:at,requested_skus:skus.length,
    markets:[...MARKETS],counts,results,read_only:true,provider_mutations:0,
    creates_offers:false,creates_asins:false,can_publish:false,
    has_verified_brand_eligibility:false,has_verified_gpsr:false,
    channable_ownership_transferred:false};
}
