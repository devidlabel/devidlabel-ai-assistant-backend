import { shopifyGraphQL } from "./index.js";

type JsonObject = Record<string, unknown>;
type PublicProductMediaEnv = Record<string, unknown>;

type ProductNode = {
  id?: string;
  title?: string;
  handle?: string;
  vendor?: string;
  status?: string;
  productType?: string;
  tags?: string[];
  description?: string;
  onlineStoreUrl?: string | null;
  media?: { nodes?: Array<{
    id?: string;
    mediaContentType?: string;
    status?: string;
    alt?: string | null;
    image?: { url?: string; width?: number; height?: number } | null;
  }> };
  variants?: { nodes?: Array<{ availableForSale?: boolean }> };
};

type ProductData = { products?: { nodes?: ProductNode[] } };

const QUERY = `
  query PublicProductMedia($first: Int!, $query: String!) {
    products(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        title
        handle
        vendor
        status
        productType
        tags
        description
        onlineStoreUrl
        media(first: 10) {
          nodes {
            id
            mediaContentType
            status
            alt
            ... on MediaImage { image { url width height } }
          }
        }
        variants(first: 20) { nodes { availableForSale } }
      }
    }
  }
`;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function boolParam(value: string | null): boolean {
  return ["1", "true", "yes", "on"].includes((value || "").trim().toLowerCase());
}

function extractDimensions(description: string): number[] | null {
  const normalized = description.replace(/,/g, ".");
  const match = normalized.match(/(\d{1,3}(?:\.\d+)?)\s*(?:cm)?\s*[x×]\s*(\d{1,3}(?:\.\d+)?)\s*(?:cm)?\s*[x×]\s*(\d{1,3}(?:\.\d+)?)\s*(?:cm)?/i);
  if (!match) return null;
  return match.slice(1, 4).map(Number);
}

function isStandardBackpack(title: string, productType: string, description: string): boolean {
  const haystack = `${title} ${productType}`.toLowerCase();
  if (!/(backpack|zaino)/i.test(haystack)) return false;
  if (/(xxxxl|largest|mini\s*backpack|sling|crossbody|duffle|luggage|trolley|carry-on|toiletry|pouch|wallet)/i.test(haystack)) return false;
  if (/standard size|dimensione standard|formato standard/i.test(description)) return true;
  const dims = extractDimensions(description);
  if (!dims) return false;
  const sorted = [...dims].sort((a, b) => a - b);
  return sorted[0] >= 13 && sorted[0] <= 17 && sorted[1] >= 26 && sorted[1] <= 31 && sorted[2] >= 42 && sorted[2] <= 47;
}

function imageRows(product: ProductNode): JsonObject[] {
  return (product.media?.nodes || [])
    .filter((item) => item?.mediaContentType === "IMAGE" && item?.status !== "FAILED" && normalize(item?.image?.url))
    .map((item, index) => ({
      id: item.id ?? null,
      position: index + 1,
      alt: item.alt ?? null,
      url: item.image?.url ?? null,
      width: item.image?.width ?? null,
      height: item.image?.height ?? null,
    }));
}

export async function handlePublicProductMediaRequest(request: Request, env: PublicProductMediaEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/internal/public-product-media") return null;
  if (request.method !== "GET") return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });

  const vendor = normalize(url.searchParams.get("vendor")) || "Sprayground";
  const text = normalize(url.searchParams.get("q"));
  const limit = integer(url.searchParams.get("limit"), 100, 1, 100);
  const standardOnly = boolParam(url.searchParams.get("standard_only"));
  const queryParts = [`vendor:${JSON.stringify(vendor)}`, "status:active"];
  if (text) queryParts.push(text);

  try {
    const data = await shopifyGraphQL<ProductData>(env as any, QUERY, { first: limit, query: queryParts.join(" ") });
    const products = (data.products?.nodes || []).map((product) => {
      const title = normalize(product.title);
      const productType = normalize(product.productType);
      const description = normalize(product.description);
      const images = imageRows(product);
      const available = (product.variants?.nodes || []).some((variant) => variant?.availableForSale === true);
      const dimensions = extractDimensions(description);
      return {
        id: product.id ?? null,
        title,
        handle: product.handle ?? null,
        vendor: product.vendor ?? null,
        product_type: productType,
        tags: Array.isArray(product.tags) ? product.tags : [],
        available,
        online_store_url: product.onlineStoreUrl ?? (product.handle ? `https://devidlabel.com/products/${product.handle}` : null),
        dimensions_cm: dimensions,
        standard_backpack: isStandardBackpack(title, productType, description),
        image_count: images.length,
        images,
      };
    }).filter((product) => product.available && product.image_count > 0 && (!standardOnly || product.standard_backpack));

    return new Response(JSON.stringify({
      ok: true,
      source: "shopify_admin_graphql_public_safe",
      generated_at: new Date().toISOString(),
      vendor,
      standard_only: standardOnly,
      count: products.length,
      products,
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60, s-maxage=120",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "public_product_media_failed" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}
