import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces";

export type AmazonMarket = keyof typeof AMAZON_EU_MARKETPLACES;
export type OfferAuditStatus =
  | "PRESENT_ACTIVE"
  | "PRESENT_INACTIVE"
  | "PRESENT_STATUS_UNKNOWN"
  | "NOT_FOUND_IN_COMPLETE_SNAPSHOT"
  | "UNVERIFIED"
  | "AMBIGUOUS_SHOPIFY_SKU";

export interface ShopifyAuditProduct {
  id: string;
  title?: string;
  vendor?: string;
  product_type?: string;
  status?: string;
  variants?: Array<{ id?: string; sku?: string; inventory_quantity?: number | null }>;
}
export interface AmazonAuditRow {
  sellerSku: string;
  status?: string | null;
  asin?: string | null;
}
export interface AmazonAuditSnapshot {
  marketplace: AmazonMarket;
  /** Must only be true after all report pages were read and validation completed. */
  complete: boolean;
  rows: AmazonAuditRow[];
}
export interface AuditSku {
  sku: string;
  productId: string;
  variantId: string | null;
  vendor: string;
  productType: string;
  inventoryQuantity: number;
  perMarket: Record<AmazonMarket, OfferAuditStatus>;
}
export interface AuditResult {
  readOnly: true;
  eligibleVariants: number;
  excluded: { notActive: number; p448: number; noStock: number; blankSku: number };
  markets: Record<AmazonMarket, Record<OfferAuditStatus, number>>;
  entries: AuditSku[];
}

/**
 * Pure classification: never mutates input or publishes listings.
 * Amazon omissions are actionable ONLY when the source snapshot explicitly
 * asserts completeness. SKU matching is exact; no case conversion or renaming.
 */
export function reconcileShopifyAmazon(
  products: ShopifyAuditProduct[],
  amazonSnapshots: Partial<Record<AmazonMarket, AmazonAuditSnapshot>>
): AuditResult {
  const markets = Object.keys(AMAZON_EU_MARKETPLACES) as AmazonMarket[];
  const excluded = { notActive: 0, p448: 0, noStock: 0, blankSku: 0 };
  const eligible: Array<Omit<AuditSku, "perMarket">> = [];
  for (const product of products) {
    for (const variant of product.variants || []) {
      if (product.status !== "ACTIVE") { excluded.notActive++; continue; }
      if ((product.vendor || "").trim().toUpperCase() === "P448") { excluded.p448++; continue; }
      const quantity = variant.inventory_quantity;
      if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) { excluded.noStock++; continue; }
      if (!variant.sku || !variant.sku.trim()) { excluded.blankSku++; continue; }
      eligible.push({
        sku: variant.sku,
        productId: product.id,
        variantId: variant.id || null,
        vendor: product.vendor || "",
        productType: product.product_type || "",
        inventoryQuantity: quantity
      });
    }
  }
  const skuCounts = new Map<string, number>();
  for (const variant of eligible) skuCounts.set(variant.sku, (skuCounts.get(variant.sku) || 0) + 1);
  const amazonByMarket = {} as Record<AmazonMarket, Map<string, AmazonAuditRow>>;
  for (const market of markets) {
    const index = new Map<string, AmazonAuditRow>();
    const snapshot = amazonSnapshots[market];
    if (snapshot && snapshot.marketplace !== market) throw new Error("amazon_snapshot_marketplace_mismatch");
    for (const row of snapshot?.rows || []) {
      if (typeof row.sellerSku === "string" && row.sellerSku) index.set(row.sellerSku, row);
    }
    amazonByMarket[market] = index;
  }
  const marketSummary = {} as Record<AmazonMarket, Record<OfferAuditStatus, number>>;
  for (const market of markets) {
    marketSummary[market] = {
      PRESENT_ACTIVE: 0, PRESENT_INACTIVE: 0, PRESENT_STATUS_UNKNOWN: 0,
      NOT_FOUND_IN_COMPLETE_SNAPSHOT: 0, UNVERIFIED: 0, AMBIGUOUS_SHOPIFY_SKU: 0
    };
  }
  const entries: AuditSku[] = eligible.map(variant => {
    const perMarket = {} as Record<AmazonMarket, OfferAuditStatus>;
    for (const market of markets) {
      const snapshot = amazonSnapshots[market];
      const row = amazonByMarket[market].get(variant.sku);
      let status: OfferAuditStatus;
      if ((skuCounts.get(variant.sku) || 0) > 1) status = "AMBIGUOUS_SHOPIFY_SKU";
      else if (row) {
        const rawStatus = (row.status || "").trim().toUpperCase();
        status = rawStatus === "ACTIVE" ? "PRESENT_ACTIVE"
          : rawStatus === "INACTIVE" || rawStatus === "INCOMPLETE" || rawStatus === "SUPPRESSED"
          ? "PRESENT_INACTIVE" : "PRESENT_STATUS_UNKNOWN";
      } else status = snapshot?.complete === true ? "NOT_FOUND_IN_COMPLETE_SNAPSHOT" : "UNVERIFIED";
      perMarket[market] = status;
      marketSummary[market][status]++;
    }
    return { ...variant, perMarket };
  });
  return { readOnly: true, eligibleVariants: eligible.length, excluded, markets: marketSummary, entries };
}
