import { shopifyGraphQL, type Env as ShopifyBaseEnv } from "./index.js";

type JsonObject = Record<string, unknown>;
type CatalogConnection = {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: JsonObject[];
};
type CatalogPageData = { products?: CatalogConnection };

type KVNamespaceLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

export type MareBusinessShopifyEnv = ShopifyBaseEnv & {
  SHOPIFY_TOKENS_KV?: KVNamespaceLike;
  [key: string]: unknown;
};

export type StoredBusinessArtifact = {
  artifact_id: string;
  kind: string;
  filename: string;
  mime_type: string;
  encoding: "utf-8" | "base64";
  content: string;
  bytes: number;
  created_at: string;
  expires_at: string;
  metadata: JsonObject;
};

const ARTIFACT_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_PRODUCTS = 2500;
const PAGE_SIZE = 50;

const CATALOG_QUERY = `
  query MareBusinessCatalog($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        vendor
        status
        productType
        tags
        createdAt
        updatedAt
        publishedAt
        descriptionHtml
        seo { title description }
        collections(first: 50) { nodes { id handle title } }
        media(first: 100) {
          nodes {
            id
            mediaContentType
            status
            alt
            ... on MediaImage {
              image { url width height }
              originalSource { url }
            }
          }
        }
        variants(first: 100) {
          nodes {
            id
            title
            sku
            barcode
            price
            compareAtPrice
            inventoryQuantity
            availableForSale
            selectedOptions { name value }
            inventoryItem {
              id
              tracked
              unitCost { amount currencyCode }
              inventoryLevels(first: 20) {
                nodes {
                  id
                  location { id name }
                  quantities(names: ["available", "on_hand", "committed"]) { name quantity }
                }
              }
            }
          }
        }
      }
    }
  }
`;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function boolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function artifactKey(id: string): string {
  return `mare-business:artifact:${id}`;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function buildCatalogCsv(products: JsonObject[]): string {
  const headers = [
    "Product ID", "Handle", "Title", "Vendor", "Status", "Product Type", "Tags", "Product Created At", "Product Updated At",
    "Published At", "SEO Title", "SEO Description", "Variant ID", "Variant Title", "SKU", "Barcode", "Price", "Compare At Price",
    "Unit Cost", "Cost Currency", "Inventory Quantity", "Available For Sale", "Selected Options", "Inventory Levels", "Collections",
    "Media Count", "Media",
  ];
  const lines = [headers.map(csvCell).join(",")];
  for (const product of products) {
    const variants = Array.isArray(product.variants) ? product.variants as JsonObject[] : [];
    const rows = variants.length ? variants : [{}];
    for (const variant of rows) {
      lines.push([
        product.id, product.handle, product.title, product.vendor, product.status, product.product_type,
        product.tags, product.created_at, product.updated_at, product.published_at, product.seo_title, product.seo_description,
        variant.id, variant.title, variant.sku, variant.barcode, variant.price, variant.compare_at_price,
        variant.unit_cost, variant.cost_currency, variant.inventory_quantity, variant.available_for_sale,
        variant.selected_options, variant.inventory_levels, product.collections, product.media_count, product.media,
      ].map(csvCell).join(","));
    }
  }
  return `${lines.join("\n")}\n`;
}

function mapProduct(node: JsonObject): JsonObject {
  const variantsConnection = node.variants && typeof node.variants === "object" ? node.variants as JsonObject : {};
  const mediaConnection = node.media && typeof node.media === "object" ? node.media as JsonObject : {};
  const collectionsConnection = node.collections && typeof node.collections === "object" ? node.collections as JsonObject : {};
  const variants = (Array.isArray(variantsConnection.nodes) ? variantsConnection.nodes : []).map((raw) => {
    const variant = raw && typeof raw === "object" ? raw as JsonObject : {};
    const inventoryItem = variant.inventoryItem && typeof variant.inventoryItem === "object" ? variant.inventoryItem as JsonObject : {};
    const unitCost = inventoryItem.unitCost && typeof inventoryItem.unitCost === "object" ? inventoryItem.unitCost as JsonObject : {};
    const levelsConnection = inventoryItem.inventoryLevels && typeof inventoryItem.inventoryLevels === "object" ? inventoryItem.inventoryLevels as JsonObject : {};
    const inventoryLevels = (Array.isArray(levelsConnection.nodes) ? levelsConnection.nodes : []).map((rawLevel) => {
      const level = rawLevel && typeof rawLevel === "object" ? rawLevel as JsonObject : {};
      const location = level.location && typeof level.location === "object" ? level.location as JsonObject : {};
      return {
        id: level.id ?? null,
        location_id: location.id ?? null,
        location_name: location.name ?? null,
        quantities: Array.isArray(level.quantities) ? level.quantities : [],
      };
    });
    return {
      id: variant.id ?? null,
      title: variant.title ?? null,
      sku: variant.sku ?? null,
      barcode: variant.barcode ?? null,
      price: variant.price ?? null,
      compare_at_price: variant.compareAtPrice ?? null,
      inventory_quantity: variant.inventoryQuantity ?? null,
      available_for_sale: variant.availableForSale ?? null,
      selected_options: Array.isArray(variant.selectedOptions) ? variant.selectedOptions : [],
      inventory_item_id: inventoryItem.id ?? null,
      inventory_tracked: inventoryItem.tracked ?? null,
      unit_cost: unitCost.amount ?? null,
      cost_currency: unitCost.currencyCode ?? null,
      inventory_levels: inventoryLevels,
    };
  });
  const media = (Array.isArray(mediaConnection.nodes) ? mediaConnection.nodes : []).map((raw, index) => {
    const item = raw && typeof raw === "object" ? raw as JsonObject : {};
    const image = item.image && typeof item.image === "object" ? item.image as JsonObject : {};
    const original = item.originalSource && typeof item.originalSource === "object" ? item.originalSource as JsonObject : {};
    return {
      id: item.id ?? null,
      position: index + 1,
      type: item.mediaContentType ?? null,
      status: item.status ?? null,
      alt: item.alt ?? null,
      url: original.url ?? image.url ?? null,
      width: image.width ?? null,
      height: image.height ?? null,
    };
  });
  const collections = (Array.isArray(collectionsConnection.nodes) ? collectionsConnection.nodes : []).map((raw) => {
    const collection = raw && typeof raw === "object" ? raw as JsonObject : {};
    return { id: collection.id ?? null, handle: collection.handle ?? null, title: collection.title ?? null };
  });
  const seo = node.seo && typeof node.seo === "object" ? node.seo as JsonObject : {};
  return {
    id: node.id ?? null,
    title: node.title ?? null,
    handle: node.handle ?? null,
    vendor: node.vendor ?? null,
    status: node.status ?? null,
    product_type: node.productType ?? null,
    tags: Array.isArray(node.tags) ? node.tags : [],
    created_at: node.createdAt ?? null,
    updated_at: node.updatedAt ?? null,
    published_at: node.publishedAt ?? null,
    description_html: node.descriptionHtml ?? null,
    seo_title: seo.title ?? null,
    seo_description: seo.description ?? null,
    collections,
    media_count: media.length,
    media,
    variant_count: variants.length,
    variants,
  };
}

export async function storeBusinessArtifact(
  env: MareBusinessShopifyEnv,
  input: Omit<StoredBusinessArtifact, "artifact_id" | "bytes" | "created_at" | "expires_at">,
): Promise<StoredBusinessArtifact> {
  if (!env.SHOPIFY_TOKENS_KV) throw new Error("business_artifact_store_not_configured");
  const artifactId = `mba_${crypto.randomUUID()}`;
  const now = new Date();
  const expires = new Date(now.getTime() + ARTIFACT_TTL_SECONDS * 1000);
  const bytes = new TextEncoder().encode(input.content).byteLength;
  const artifact: StoredBusinessArtifact = {
    ...input,
    artifact_id: artifactId,
    bytes,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
  };
  await env.SHOPIFY_TOKENS_KV.put(artifactKey(artifactId), JSON.stringify(artifact), { expirationTtl: ARTIFACT_TTL_SECONDS });
  return artifact;
}

export async function getBusinessArtifact(args: JsonObject, env: MareBusinessShopifyEnv): Promise<JsonObject> {
  if (!env.SHOPIFY_TOKENS_KV) throw new Error("business_artifact_store_not_configured");
  const artifactId = normalize(args.artifact_id);
  if (!/^mba_[A-Za-z0-9-]{20,80}$/.test(artifactId)) throw new Error("invalid_artifact_id");
  const raw = await env.SHOPIFY_TOKENS_KV.get(artifactKey(artifactId));
  if (!raw) throw new Error("artifact_not_found_or_expired");
  const artifact = JSON.parse(raw) as StoredBusinessArtifact;
  if (artifact.artifact_id !== artifactId) throw new Error("artifact_record_invalid");
  return { ok: true, ...artifact };
}

export async function readShopifyCatalog(args: JsonObject, env: MareBusinessShopifyEnv): Promise<JsonObject> {
  const query = normalize(args.query);
  const maxProducts = integer(args.max_products, 1000, 1, MAX_PRODUCTS);
  const inlineLimit = integer(args.inline_limit, 25, 0, 100);
  const includeCsv = boolean(args.include_csv, true);
  let after: string | null = null;
  let hasNextPage = true;
  const products: JsonObject[] = [];
  while (hasNextPage && products.length < maxProducts) {
    const first = Math.min(PAGE_SIZE, maxProducts - products.length);
    const data: CatalogPageData = await shopifyGraphQL<CatalogPageData>(
      env,
      CATALOG_QUERY,
      { first, after, query: query || null },
    );
    const connection: CatalogConnection = data.products || {};
    products.push(...(connection.nodes || []).map(mapProduct));
    hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
    after = normalize(connection.pageInfo?.endCursor) || null;
    if (!after) hasNextPage = false;
  }

  const jsonContent = JSON.stringify({ generated_at: new Date().toISOString(), query: query || null, products });
  const jsonArtifact = await storeBusinessArtifact(env, {
    kind: "shopify_catalog_json",
    filename: `shopify-catalog-${new Date().toISOString().slice(0, 10)}.json`,
    mime_type: "application/json",
    encoding: "utf-8",
    content: jsonContent,
    metadata: { product_count: products.length, truncated: hasNextPage },
  });
  let csvArtifact: StoredBusinessArtifact | null = null;
  if (includeCsv) {
    csvArtifact = await storeBusinessArtifact(env, {
      kind: "shopify_catalog_csv",
      filename: `shopify-catalog-${new Date().toISOString().slice(0, 10)}.csv`,
      mime_type: "text/csv",
      encoding: "utf-8",
      content: buildCatalogCsv(products),
      metadata: { product_count: products.length, truncated: hasNextPage },
    });
  }

  const variantCount = products.reduce((sum, product) => sum + (typeof product.variant_count === "number" ? product.variant_count : 0), 0);
  const mediaCount = products.reduce((sum, product) => sum + (typeof product.media_count === "number" ? product.media_count : 0), 0);
  return {
    ok: true,
    source: "shopify_admin_graphql",
    query: query || null,
    product_count: products.length,
    variant_count: variantCount,
    media_count: mediaCount,
    truncated: hasNextPage,
    next_cursor: after,
    artifacts: {
      json: { artifact_id: jsonArtifact.artifact_id, filename: jsonArtifact.filename, bytes: jsonArtifact.bytes, expires_at: jsonArtifact.expires_at },
      csv: csvArtifact ? { artifact_id: csvArtifact.artifact_id, filename: csvArtifact.filename, bytes: csvArtifact.bytes, expires_at: csvArtifact.expires_at } : null,
    },
    products: products.slice(0, inlineLimit),
    inline_product_count: Math.min(products.length, inlineLimit),
  };
}
