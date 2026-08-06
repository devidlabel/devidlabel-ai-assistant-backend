import {
  getBusinessArtifact,
  readShopifyCatalog,
  storeBusinessArtifact,
  type MareBusinessShopifyEnv,
} from "./mare-business-shopify.js";

type JsonObject = Record<string, unknown>;

type Channel =
  | "google_merchant"
  | "meta_catalog"
  | "tiktok_catalog"
  | "amazon_json_listings"
  | "spartoo_csv"
  | "miinto_csv"
  | "generic_csv";

const ALLOWED_CHANNELS: readonly Channel[] = [
  "google_merchant",
  "meta_catalog",
  "tiktok_catalog",
  "amazon_json_listings",
  "spartoo_csv",
  "miinto_csv",
  "generic_csv",
];

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function array(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object").map((item) => item as JsonObject) : [];
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function stripHtml(value: unknown): string {
  return normalize(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstMediaUrl(product: JsonObject): string {
  return normalize(array(product.media)[0]?.url);
}

function productLink(product: JsonObject, baseUrl: string): string {
  const handle = normalize(product.handle);
  return handle ? `${baseUrl.replace(/\/$/, "")}/products/${encodeURIComponent(handle)}` : "";
}

function variantRows(products: JsonObject[], includeOutOfStock: boolean): Array<{ product: JsonObject; variant: JsonObject }> {
  const rows: Array<{ product: JsonObject; variant: JsonObject }> = [];
  for (const product of products) {
    if (normalize(product.status).toUpperCase() !== "ACTIVE") continue;
    for (const variant of array(product.variants)) {
      const stock = numeric(variant.inventory_quantity);
      if (!includeOutOfStock && stock <= 0 && variant.available_for_sale !== true) continue;
      rows.push({ product, variant });
    }
  }
  return rows;
}

function canonicalRow(product: JsonObject, variant: JsonObject, args: JsonObject): JsonObject {
  const baseUrl = normalize(args.storefront_url) || "https://devidlabel.com";
  const currency = (normalize(args.currency) || "EUR").toUpperCase();
  const sku = normalize(variant.sku) || normalize(variant.id).split("/").pop() || "";
  const barcode = normalize(variant.barcode);
  const stock = Math.max(0, numeric(variant.inventory_quantity));
  const price = numeric(variant.price);
  const compareAt = numeric(variant.compare_at_price);
  const title = normalize(product.title);
  const variantTitle = normalize(variant.title);
  const completeTitle = variantTitle && variantTitle.toLowerCase() !== "default title" ? `${title} - ${variantTitle}` : title;
  return {
    id: sku,
    item_group_id: normalize(product.handle) || normalize(product.id),
    title: completeTitle,
    description: stripHtml(product.description_html) || normalize(product.seo_description),
    availability: stock > 0 || variant.available_for_sale === true ? "in stock" : "out of stock",
    condition: "new",
    price: `${price.toFixed(2)} ${currency}`,
    sale_price: compareAt > price && price > 0 ? `${price.toFixed(2)} ${currency}` : "",
    original_price: compareAt > price ? `${compareAt.toFixed(2)} ${currency}` : "",
    link: productLink(product, baseUrl),
    image_link: firstMediaUrl(product),
    brand: normalize(product.vendor),
    gtin: barcode,
    mpn: sku,
    product_type: normalize(product.product_type),
    google_product_category: normalize(args.google_product_category),
    quantity: stock,
    size: array(variant.selected_options).find((option) => /size|taglia/i.test(normalize(option.name)))?.value ?? "",
    color: array(variant.selected_options).find((option) => /color|colore/i.test(normalize(option.name)))?.value ?? "",
    cost: numeric(variant.unit_cost),
    source_product_id: product.id ?? null,
    source_variant_id: variant.id ?? null,
  };
}

function csvFromRows(rows: JsonObject[], headers: string[]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(headers.map((header) => csvCell(row[header])).join(","));
  return `${lines.join("\n")}\n`;
}

function buildChannelContent(channel: Channel, rows: JsonObject[], args: JsonObject): { content: string; mimeType: string; filename: string; warnings: string[] } {
  const date = new Date().toISOString().slice(0, 10);
  const commonHeaders = [
    "id", "item_group_id", "title", "description", "availability", "condition", "price", "sale_price", "link",
    "image_link", "brand", "gtin", "mpn", "product_type", "google_product_category", "quantity", "size", "color",
  ];
  if (channel === "google_merchant" || channel === "meta_catalog" || channel === "tiktok_catalog") {
    return {
      content: csvFromRows(rows, commonHeaders),
      mimeType: "text/csv",
      filename: `${channel}-${date}.csv`,
      warnings: rows.some((row) => !normalize(row.gtin) && !normalize(row.mpn)) ? ["some_rows_missing_gtin_and_mpn"] : [],
    };
  }
  if (channel === "amazon_json_listings") {
    const sellerId = normalize(args.amazon_seller_id);
    const marketplaceId = normalize(args.amazon_marketplace_id);
    const productType = normalize(args.amazon_product_type);
    const messages = rows.map((row, index) => ({
      messageId: index + 1,
      sku: row.id,
      operationType: "UPDATE",
      productType: productType || "REQUIRES_PRODUCT_TYPE_MAPPING",
      requirements: "LISTING",
      attributes: {
        merchant_suggested_asin: [],
        item_name: [{ value: row.title, marketplace_id: marketplaceId || "REQUIRES_MARKETPLACE_ID" }],
        brand: [{ value: row.brand, marketplace_id: marketplaceId || "REQUIRES_MARKETPLACE_ID" }],
        externally_assigned_product_identifier: normalize(row.gtin) ? [{ type: "ean", value: row.gtin, marketplace_id: marketplaceId || "REQUIRES_MARKETPLACE_ID" }] : [],
        purchasable_offer: [{ currency: normalize(args.currency) || "EUR", our_price: [{ schedule: [{ value_with_tax: numeric(String(row.price).split(" ")[0]) }] }], marketplace_id: marketplaceId || "REQUIRES_MARKETPLACE_ID" }],
        fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: row.quantity }],
      },
    }));
    return {
      content: JSON.stringify({ header: { sellerId: sellerId || "REQUIRES_SELLER_ID", version: "2.0", issueLocale: "it_IT" }, messages }, null, 2),
      mimeType: "application/json",
      filename: `amazon-json-listings-${date}.json`,
      warnings: [
        ...(sellerId ? [] : ["amazon_seller_id_missing"]),
        ...(marketplaceId ? [] : ["amazon_marketplace_id_missing"]),
        ...(productType ? [] : ["amazon_product_type_mapping_required"]),
      ],
    };
  }
  if (channel === "spartoo_csv" || channel === "miinto_csv" || channel === "generic_csv") {
    const headers = ["id", "item_group_id", "title", "brand", "gtin", "price", "original_price", "quantity", "size", "color", "link", "image_link", "product_type"];
    return {
      content: csvFromRows(rows, headers),
      mimeType: "text/csv",
      filename: `${channel}-${date}.csv`,
      warnings: channel === "generic_csv" ? [] : [`${channel}_contract_mapping_must_be_verified_before_direct_push`],
    };
  }
  throw new Error("unsupported_marketplace_channel");
}

async function loadCanonicalProducts(args: JsonObject, env: MareBusinessShopifyEnv): Promise<JsonObject[]> {
  const catalog = await readShopifyCatalog({
    query: normalize(args.query),
    max_products: integer(args.max_products, 1000, 1, 2500),
    inline_limit: 0,
    include_csv: false,
  }, env);
  const artifacts = object(catalog.artifacts);
  const jsonArtifactMeta = object(artifacts.json);
  const artifactId = normalize(jsonArtifactMeta.artifact_id);
  if (!artifactId) throw new Error("canonical_catalog_artifact_missing");
  const artifact = await getBusinessArtifact({ artifact_id: artifactId }, env);
  const parsed = JSON.parse(normalize(artifact.content)) as { products?: JsonObject[] };
  return Array.isArray(parsed.products) ? parsed.products : [];
}

export async function generateMarketplaceFeed(args: JsonObject, env: MareBusinessShopifyEnv): Promise<JsonObject> {
  const channel = normalize(args.channel) as Channel;
  if (!ALLOWED_CHANNELS.includes(channel)) throw new Error("unsupported_marketplace_channel");
  const products = await loadCanonicalProducts(args, env);
  const canonicalRows = variantRows(products, bool(args.include_out_of_stock, false)).map(({ product, variant }) => canonicalRow(product, variant, args));
  const built = buildChannelContent(channel, canonicalRows, args);
  const artifact = await storeBusinessArtifact(env, {
    kind: `marketplace_feed_${channel}`,
    filename: built.filename,
    mime_type: built.mimeType,
    encoding: "utf-8",
    content: built.content,
    metadata: {
      channel,
      row_count: canonicalRows.length,
      product_count: products.length,
      warnings: built.warnings,
      direct_external_push_performed: false,
      canonical_source: "shopify_admin_graphql",
    },
  });
  return {
    ok: true,
    status: "artifact_created",
    channel,
    product_count: products.length,
    row_count: canonicalRows.length,
    warnings: built.warnings,
    direct_external_push_performed: false,
    artifact: { artifact_id: artifact.artifact_id, filename: artifact.filename, mime_type: artifact.mime_type, bytes: artifact.bytes, expires_at: artifact.expires_at },
  };
}

export async function generateMatrixifyCatalog(args: JsonObject, env: MareBusinessShopifyEnv): Promise<JsonObject> {
  const products = await loadCanonicalProducts(args, env);
  const operation = (normalize(args.operation) || "MERGE").toUpperCase();
  const transformations = object(args.transformations);
  const headers = [
    "Command", "Handle", "Title", "Body HTML", "Vendor", "Type", "Tags", "Status", "Variant ID", "Variant SKU",
    "Variant Barcode", "Variant Price", "Variant Compare At Price", "Variant Cost", "Variant Inventory Qty", "SEO Title",
    "SEO Description", "Image Src", "Image Alt Text",
  ];
  const lines = [headers.map(csvCell).join(",")];
  let rowCount = 0;
  for (const product of products) {
    const variants = array(product.variants);
    const media = array(product.media);
    const rows = variants.length ? variants : [{}];
    for (let index = 0; index < rows.length; index += 1) {
      const variant = rows[index];
      const titleOverride = normalize(transformations.title) || normalize(product.title);
      const seoTitleOverride = normalize(transformations.seo_title) || normalize(product.seo_title);
      const seoDescriptionOverride = normalize(transformations.seo_description) || normalize(product.seo_description);
      const image = media[index] || media[0] || {};
      const record: JsonObject = {
        "Command": operation,
        "Handle": product.handle,
        "Title": titleOverride,
        "Body HTML": product.description_html,
        "Vendor": product.vendor,
        "Type": product.product_type,
        "Tags": Array.isArray(product.tags) ? product.tags.join(", ") : product.tags,
        "Status": product.status,
        "Variant ID": variant.id,
        "Variant SKU": variant.sku,
        "Variant Barcode": variant.barcode,
        "Variant Price": variant.price,
        "Variant Compare At Price": variant.compare_at_price,
        "Variant Cost": variant.unit_cost,
        "Variant Inventory Qty": variant.inventory_quantity,
        "SEO Title": seoTitleOverride,
        "SEO Description": seoDescriptionOverride,
        "Image Src": image.url,
        "Image Alt Text": image.alt,
      };
      lines.push(headers.map((header) => csvCell(record[header])).join(","));
      rowCount += 1;
    }
  }
  const artifact = await storeBusinessArtifact(env, {
    kind: "matrixify_catalog_csv",
    filename: `matrixify-catalog-${new Date().toISOString().slice(0, 10)}.csv`,
    mime_type: "text/csv",
    encoding: "utf-8",
    content: `${lines.join("\n")}\n`,
    metadata: {
      product_count: products.length,
      row_count: rowCount,
      operation,
      direct_shopify_write_performed: false,
      validation_level: "structural_headers_and_types",
      note: "Validate against a current Matrixify export before first live import.",
    },
  });
  return {
    ok: true,
    status: "artifact_created",
    product_count: products.length,
    row_count: rowCount,
    operation,
    direct_shopify_write_performed: false,
    artifact: { artifact_id: artifact.artifact_id, filename: artifact.filename, mime_type: artifact.mime_type, bytes: artifact.bytes, expires_at: artifact.expires_at },
    validation: { level: "structural_headers_and_types", live_import_not_performed: true },
  };
}
