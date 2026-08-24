import { readShopifyCatalogComplete } from "./mare-business-shopify-complete.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

type JsonObject = Record<string, unknown>;
type Env = MareBusinessShopifyEnv & {
  DAILY_PULSE_ACCESS_TOKEN?: string;
  SHOPIFY_REPORT_ACCESS_TOKEN?: string;
};

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function handleSpraygroundLiveCatalogRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/internal/shopify/sprayground-live-catalog") return null;
  if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

  try {
    const catalog = await readShopifyCatalogComplete({
      query: "vendor:Sprayground",
      max_products: 500,
      inline_limit: 100,
      include_csv: false,
    }, env);
    const products = Array.isArray(catalog.products) ? catalog.products as JsonObject[] : [];
    const compact = products.map((product) => {
      const variants = Array.isArray(product.variants) ? product.variants as JsonObject[] : [];
      const inventoryQuantity = variants.reduce((sum, variant) => sum + Number(variant.inventory_quantity || 0), 0);
      const availableVariants = variants.filter((variant) => variant.available_for_sale === true && Number(variant.inventory_quantity || 0) > 0).length;
      const media = Array.isArray(product.media) ? product.media as JsonObject[] : [];
      return {
        id: product.id ?? null,
        title: product.title ?? null,
        handle: product.handle ?? null,
        vendor: product.vendor ?? null,
        status: product.status ?? null,
        product_type: product.product_type ?? null,
        inventory_quantity: inventoryQuantity,
        available_variants: availableVariants,
        variant_count: variants.length,
        price_min: variants.length ? Math.min(...variants.map((variant) => Number(variant.price || 0)).filter((value) => Number.isFinite(value))) : null,
        compare_at_price_max: variants.length ? Math.max(...variants.map((variant) => Number(variant.compare_at_price || 0)).filter((value) => Number.isFinite(value))) : null,
        primary_image_url: media.length ? (media[0].url ?? null) : null,
        updated_at: product.updated_at ?? null,
        variants: variants.map((variant) => ({
          id: variant.id ?? null,
          title: variant.title ?? null,
          sku: variant.sku ?? null,
          price: variant.price ?? null,
          compare_at_price: variant.compare_at_price ?? null,
          inventory_quantity: variant.inventory_quantity ?? null,
          available_for_sale: variant.available_for_sale ?? null,
        })),
      };
    });
    return jsonResponse({
      ok: true,
      service: "sprayground_live_catalog",
      generated_at: new Date().toISOString(),
      product_count: compact.length,
      products: compact,
      notes: ["Read-only live Shopify catalog filtered to vendor Sprayground."],
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : "sprayground_live_catalog_failed" }, 502);
  }
}
