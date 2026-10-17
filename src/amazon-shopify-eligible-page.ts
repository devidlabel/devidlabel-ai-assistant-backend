import { shopifyGraphQL, type Env as ShopifyEnv } from "./index.js";

type Variant = { id: string; sku: string | null; barcode?: string | null; inventoryQuantity: number | null };
type PageInfo = { hasNextPage: boolean; endCursor: string | null };
type VariantConnection = { nodes: Variant[]; pageInfo: PageInfo };
type Product = {
  id: string; status: string; vendor: string; productType: string;
  variants: VariantConnection;
};
type ProductPage = { products: { nodes: Product[]; pageInfo: PageInfo } };
type VariantPage = { product: { variants: VariantConnection } | null };
const PRODUCTS_PER_PAGE = 20;
const INITIAL_VARIANTS = 20;
const EXTRA_VARIANTS = 100;
const MAX_VARIANTS_PER_PRODUCT = 3000;

const PRODUCTS_QUERY = `
query AmazonShopifyEligiblePage($after: String) {
  products(first: 20, after: $after, query: "status:active", sortKey: ID, reverse: false) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id status vendor productType
      variants(first: 20) {
        pageInfo { hasNextPage endCursor }
        nodes { id sku barcode inventoryQuantity }
      }
    }
  }
}`;
const VARIANTS_QUERY = `
query AmazonShopifyExtraVariants($id: ID!, $after: String) {
  product(id: $id) {
    variants(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id sku barcode inventoryQuantity }
    }
  }
}`;

function validatePageInfo(value: PageInfo | undefined): asserts value is PageInfo {
  if (!value || typeof value.hasNextPage !== "boolean" ||
      (value.hasNextPage && (!value.endCursor || typeof value.endCursor !== "string"))) {
    throw new Error("amazon_shopify_invalid_pagination");
  }
}
async function allVariants(product: Product, env: ShopifyEnv): Promise<Variant[]> {
  const initial = product.variants;
  if (!initial || !Array.isArray(initial.nodes)) throw new Error("amazon_shopify_variants_missing");
  validatePageInfo(initial.pageInfo);
  const output = [...initial.nodes];
  let pageInfo = initial.pageInfo;
  const seen = new Set<string>();
  while (pageInfo.hasNextPage) {
    const cursor = pageInfo.endCursor!;
    if (seen.has(cursor) || output.length >= MAX_VARIANTS_PER_PRODUCT) throw new Error("amazon_shopify_variant_cursor_invalid");
    seen.add(cursor);
    const result = await shopifyGraphQL<VariantPage>(env, VARIANTS_QUERY, { id: product.id, after: cursor });
    if (!result.product?.variants || !Array.isArray(result.product.variants.nodes)) {
      throw new Error("amazon_shopify_variant_page_missing");
    }
    validatePageInfo(result.product.variants.pageInfo);
    output.push(...result.product.variants.nodes);
    pageInfo = result.product.variants.pageInfo;
  }
  return output;
}
export async function readAmazonShopifyEligiblePage(
  env: ShopifyEnv, after: string | null
): Promise<unknown> {
  if (after !== null && (after.length > 2048 || !/^[A-Za-z0-9=+/._-]+$/.test(after))) {
    throw new Error("amazon_shopify_cursor_invalid");
  }
  const data = await shopifyGraphQL<ProductPage>(env, PRODUCTS_QUERY, { after });
  const products = data.products;
  if (!products || !Array.isArray(products.nodes)) throw new Error("amazon_shopify_products_missing");
  validatePageInfo(products.pageInfo);
  if (products.nodes.length > PRODUCTS_PER_PAGE || (products.pageInfo.hasNextPage && products.nodes.length === 0)) {
    throw new Error("amazon_shopify_product_page_invalid");
  }
  const eligible: Array<{
    sku: string; vendor: string; product_type: string; inventory_quantity: number;
    product_id: string; variant_id: string; barcode: string | null;
  }> = [];
  const excluded = { p448: 0, not_active: 0, no_stock: 0, blank_sku: 0 };
  let variantCount = 0;
  for (const product of products.nodes) {
    if (!product.id || typeof product.status !== "string") throw new Error("amazon_shopify_product_invalid");
    const variants = await allVariants(product, env);
    variantCount += variants.length;
    for (const variant of variants) {
      if (product.status !== "ACTIVE") { excluded.not_active++; continue; }
      if ((product.vendor || "").trim().toUpperCase() === "P448") { excluded.p448++; continue; }
      if (typeof variant.inventoryQuantity !== "number" || !Number.isFinite(variant.inventoryQuantity) ||
          variant.inventoryQuantity <= 0) { excluded.no_stock++; continue; }
      if (!variant.sku || !variant.sku.trim()) { excluded.blank_sku++; continue; }
      if (!variant.id) throw new Error("amazon_shopify_variant_id_missing");
      eligible.push({
        sku: variant.sku, vendor: product.vendor || "", product_type: product.productType || "",
        inventory_quantity: variant.inventoryQuantity,
        product_id: product.id, variant_id: variant.id, barcode: variant.barcode || null
      });
    }
  }
  return {
    ok: true, read_only: true, source: "shopify_live",
    sort_key: "ID", products_scanned: products.nodes.length, variants_scanned: variantCount,
    excluded, eligible_variants: eligible, has_more: products.pageInfo.hasNextPage,
    next_cursor: products.pageInfo.hasNextPage ? products.pageInfo.endCursor : null,
    eligible_count: eligible.length
  };
}
