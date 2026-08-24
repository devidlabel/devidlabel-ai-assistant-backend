import { shopifyGraphQL } from "./index.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

type JsonObject = Record<string, unknown>;
type Env = MareBusinessShopifyEnv & {
  DAILY_PULSE_ACCESS_TOKEN?: string;
  SHOPIFY_REPORT_ACCESS_TOKEN?: string;
};

type Data = {
  products?: {
    nodes?: Array<{
      id?: string;
      title?: string;
      handle?: string;
      vendor?: string;
      status?: string;
      productType?: string;
      updatedAt?: string;
      featuredMedia?: { image?: { url?: string } } | null;
      variants?: { nodes?: JsonObject[] };
    }>;
  };
};

const QUERY = `
  query SpraygroundLiveCatalog($query: String!) {
    products(first: 250, query: $query, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        title
        handle
        vendor
        status
        productType
        updatedAt
        featuredMedia { ... on MediaImage { image { url } } }
        variants(first: 30) {
          nodes {
            id
            title
            sku
            price
            compareAtPrice
            inventoryQuantity
            availableForSale
          }
        }
      }
    }
  }
`;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
function timingSafeEqualText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
function isAuthorized(request: Request, env: Env): boolean {
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const accepted = [normalize(env.DAILY_PULSE_ACCESS_TOKEN), normalize(env.SHOPIFY_REPORT_ACCESS_TOKEN)].filter(Boolean);
  return accepted.some((expected) => timingSafeEqualText(supplied, expected));
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export async function handleSpraygroundLiveCatalogRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/internal/shopify/sprayground-live-catalog") return null;
  if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

  try {
    const data = await shopifyGraphQL<Data>(env, QUERY, { query: "vendor:Sprayground" });
    const products = data.products?.nodes || [];
    const compact = products.map((product) => {
      const variants = product.variants?.nodes || [];
      const inventoryQuantity = variants.reduce((sum, raw) => sum + Number(object(raw).inventoryQuantity || 0), 0);
      const availableVariants = variants.filter((raw) => object(raw).availableForSale === true && Number(object(raw).inventoryQuantity || 0) > 0).length;
      const prices = variants.map((raw) => Number(object(raw).price || 0)).filter((value) => Number.isFinite(value) && value > 0);
      const compare = variants.map((raw) => Number(object(raw).compareAtPrice || 0)).filter((value) => Number.isFinite(value) && value > 0);
      return {
        id: product.id ?? null,
        title: product.title ?? null,
        handle: product.handle ?? null,
        vendor: product.vendor ?? null,
        status: product.status ?? null,
        product_type: product.productType ?? null,
        inventory_quantity: inventoryQuantity,
        available_variants: availableVariants,
        variant_count: variants.length,
        price_min: prices.length ? Math.min(...prices) : null,
        compare_at_price_max: compare.length ? Math.max(...compare) : null,
        primary_image_url: product.featuredMedia?.image?.url ?? null,
        updated_at: product.updatedAt ?? null,
        variants: variants.map((raw) => {
          const variant = object(raw);
          return {
            id: variant.id ?? null,
            title: variant.title ?? null,
            sku: variant.sku ?? null,
            price: variant.price ?? null,
            compare_at_price: variant.compareAtPrice ?? null,
            inventory_quantity: variant.inventoryQuantity ?? null,
            available_for_sale: variant.availableForSale ?? null,
          };
        }),
      };
    });
    return jsonResponse({
      ok: true,
      service: "sprayground_live_catalog",
      generated_at: new Date().toISOString(),
      product_count: compact.length,
      products: compact,
      notes: ["Read-only single-query live Shopify catalog filtered to vendor Sprayground."],
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : "sprayground_live_catalog_failed" }, 502);
  }
}
