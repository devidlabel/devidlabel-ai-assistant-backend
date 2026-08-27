import { shopifyGraphQL, type Env as ShopifyBaseEnv } from "./index.js";

type JsonObject = Record<string, unknown>;

type KVNamespaceLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

export type ShopifyMediaSeoEnv = ShopifyBaseEnv & {
  SHOPIFY_TOKENS_KV?: KVNamespaceLike;
  [key: string]: unknown;
};

type ShopifyMediaNode = {
  id?: string;
  mediaContentType?: string;
  status?: string | null;
  fileStatus?: string | null;
  alt?: string | null;
  image?: { url?: string; width?: number | null; height?: number | null } | null;
  originalSource?: { url?: string } | null;
};

type ShopifyProductNode = {
  id?: string;
  title?: string;
  handle?: string;
  vendor?: string;
  status?: string | null;
  publishedAt?: string | null;
  onlineStoreUrl?: string | null;
  masterSku?: { value?: string | null } | null;
  variants?: { nodes?: Array<{ sku?: string | null }> } | null;
  media?: { nodes?: ShopifyMediaNode[] } | null;
};

type DesiredMediaUpdate = {
  id: string;
  product_id: string;
  product_title: string;
  vendor: string;
  master_sku: string;
  master_sku_source: "xphub.master_sku" | "single_variant_sku";
  position: number;
  current_alt: string | null;
  current_filename: string;
  desired_alt: string;
  desired_filename: string;
  width: number | null;
  height: number | null;
};

type MediaSeoRequest = {
  schema: "shopify_media_seo_request_v1";
  operation: "optimize_product_image_metadata";
  mode: "dry_run" | "execute";
  policy: "devid_image_seo_v1";
  scope: {
    status: "ACTIVE";
    published_only: true;
    vendor?: string | null;
    max_products?: number;
  };
};

const BRIDGE_PATH = "/internal/shopify-media-seo-bridge";
const REQUEST_PATH_PATTERN = /^ops\/shopify-media-seo-requests\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/;
const RAW_REPOSITORY_BASE = "https://raw.githubusercontent.com/devidlabel/devidlabel-ai-assistant-backend/main/";
const MAX_REQUEST_BYTES = 32 * 1024;
const PRODUCT_PAGE_SIZE = 250;
const FILE_UPDATE_BATCH_SIZE = 10;
const MAX_PRODUCTS_HARD_LIMIT = 5000;
const MAX_FILENAME_BASE = 180;
const MAX_ALT_LENGTH = 180;
const RETRYABLE_FETCH_STATUSES = new Set([404, 408, 425, 429, 500, 502, 503, 504]);

const PRODUCTS_QUERY = `
  query MareShopifyMediaSeoProducts($first: Int!, $after: String, $query: String!) {
    products(first: $first, after: $after, query: $query, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        vendor
        status
        publishedAt
        onlineStoreUrl
        masterSku: metafield(namespace: "xphub", key: "master_sku") { value }
        variants(first: 100) { nodes { sku } }
        media(first: 100) {
          nodes {
            id
            mediaContentType
            status
            alt
            ... on MediaImage {
              fileStatus
              image { url width height }
              originalSource { url }
            }
          }
        }
      }
    }
  }
`;

const FILE_UPDATE_MUTATION = `
  mutation MareShopifyMediaSeoFileUpdate($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) {
      files {
        id
        alt
        fileStatus
        ... on MediaImage { image { url width height } }
      }
      userErrors { field message code }
    }
  }
`;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function slug(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " e ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

function truncateSlug(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const sliced = value.slice(0, maxLength).replace(/-[^-]*$/, "").replace(/-+$/, "");
  return sliced || value.slice(0, maxLength).replace(/-+$/, "");
}

function basenameFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const basename = decodeURIComponent(url.pathname.split("/").pop() || "");
    return basename.trim();
  } catch {
    return "";
  }
}

function extensionFromFilename(filename: string): string {
  const match = filename.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  return match?.[1] || "";
}

function makeDesiredFilename(vendor: string, title: string, masterSku: string, position: number, extension: string): string {
  const vendorSlug = slug(vendor) || "prodotto";
  const titleSlug = slug(title) || "articolo";
  const masterSlug = slug(masterSku) || "sku";
  const suffix = `${masterSlug}-foto-${String(position).padStart(2, "0")}`;
  const reserved = suffix.length + 1;
  const prefixBudget = Math.max(24, MAX_FILENAME_BASE - reserved);
  const prefix = truncateSlug(`${vendorSlug}-${titleSlug}`, prefixBudget);
  return `${prefix}-${suffix}.${extension}`;
}

function makeDesiredAlt(vendor: string, title: string, masterSku: string, position: number): string {
  const view = position === 1 ? "vista principale" : `dettaglio prodotto ${position}`;
  const suffix = ` – ${view} – Master SKU ${masterSku}`;
  const prefix = `${vendor} ${title}`.replace(/\s+/g, " ").trim();
  if ((prefix + suffix).length <= MAX_ALT_LENGTH) return prefix + suffix;
  const budget = Math.max(40, MAX_ALT_LENGTH - suffix.length - 1);
  const shortened = prefix.slice(0, budget).replace(/\s+\S*$/, "").trim() || prefix.slice(0, budget).trim();
  return `${shortened}${suffix}`.slice(0, MAX_ALT_LENGTH).trim();
}

function sameText(left: string | null | undefined, right: string): boolean {
  return normalize(left) === right;
}

function buildShopifySearch(vendor: string): string {
  const parts = ["status:active"];
  if (vendor) parts.push(`vendor:'${vendor.replace(/[\\']/g, (character) => `\\${character}`)}'`);
  return parts.join(" ");
}

function cleanSingleVariantSku(value: string): string {
  return value.replace(/\s+_?taglia\s+unica$/i, "").trim() || value;
}

function resolveMasterSku(product: ShopifyProductNode): { value: string; source: "xphub.master_sku" | "single_variant_sku" } | null {
  const metafieldValue = normalize(product.masterSku?.value);
  if (metafieldValue) return { value: metafieldValue, source: "xphub.master_sku" };

  const uniqueVariantSkus = Array.from(new Set(
    (product.variants?.nodes || [])
      .map((variant) => normalize(variant.sku))
      .filter(Boolean),
  ));
  if (uniqueVariantSkus.length === 1) return { value: cleanSingleVariantSku(uniqueVariantSkus[0]), source: "single_variant_sku" };
  return null;
}

async function fetchRequestText(requestPath: string): Promise<string> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const response = await fetch(`${RAW_REPOSITORY_BASE}${requestPath}`, {
      headers: { Accept: "application/json", "User-Agent": "devid-shopify-media-seo/1.0" },
      cf: { cacheTtl: 0, cacheEverything: false },
    } as RequestInit);
    lastStatus = response.status;
    if (response.ok) return response.text();
    if (!RETRYABLE_FETCH_STATUSES.has(response.status) || attempt === 8) break;
    await sleep(Math.min(250 * (2 ** (attempt - 1)), 2000));
  }
  throw new Error(`media_seo_request_fetch_failed_${lastStatus || "unknown"}`);
}

async function loadAuthorizedRequest(requestPath: string): Promise<{ request: MediaSeoRequest; request_hash: string }> {
  if (!REQUEST_PATH_PATTERN.test(requestPath)) throw new Error("invalid_media_seo_request_path");
  const text = await fetchRequestText(requestPath);
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) throw new Error("media_seo_request_too_large");
  let parsed: JsonObject;
  try { parsed = object(JSON.parse(text)); } catch { throw new Error("media_seo_request_invalid_json"); }
  if (normalize(parsed.schema) !== "shopify_media_seo_request_v1") throw new Error("media_seo_request_schema_invalid");
  if (normalize(parsed.operation) !== "optimize_product_image_metadata") throw new Error("media_seo_operation_invalid");
  if (!["dry_run", "execute"].includes(normalize(parsed.mode))) throw new Error("media_seo_mode_invalid");
  if (normalize(parsed.policy) !== "devid_image_seo_v1") throw new Error("media_seo_policy_invalid");
  const scope = object(parsed.scope);
  if (normalize(scope.status).toUpperCase() !== "ACTIVE") throw new Error("media_seo_scope_status_must_be_active");
  if (scope.published_only !== true) throw new Error("media_seo_scope_must_be_published_only");
  const maxProducts = integer(scope.max_products, MAX_PRODUCTS_HARD_LIMIT, 1, MAX_PRODUCTS_HARD_LIMIT);
  const vendor = normalize(scope.vendor);
  if (vendor.length > 120) throw new Error("media_seo_vendor_invalid");
  const normalized: MediaSeoRequest = {
    schema: "shopify_media_seo_request_v1",
    operation: "optimize_product_image_metadata",
    mode: normalize(parsed.mode) as "dry_run" | "execute",
    policy: "devid_image_seo_v1",
    scope: { status: "ACTIVE", published_only: true, ...(vendor ? { vendor } : {}), max_products: maxProducts },
  };
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const requestHash = Array.from(new Uint8Array(hashBuffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { request: normalized, request_hash: requestHash };
}

function mediaReady(media: ShopifyMediaNode): boolean {
  const fileStatus = normalize(media.fileStatus).toUpperCase();
  const mediaStatus = normalize(media.status).toUpperCase();
  return fileStatus === "READY" || (!fileStatus && mediaStatus === "READY");
}

async function collectDesiredUpdates(request: MediaSeoRequest, env: ShopifyMediaSeoEnv): Promise<{
  updates: DesiredMediaUpdate[];
  metrics: JsonObject;
  samples: JsonObject[];
}> {
  const vendor = normalize(request.scope.vendor);
  const maxProducts = integer(request.scope.max_products, MAX_PRODUCTS_HARD_LIMIT, 1, MAX_PRODUCTS_HARD_LIMIT);
  const searchQuery = buildShopifySearch(vendor);
  let after: string | null = null;
  let productCount = 0;
  let eligibleProducts = 0;
  let skippedUnpublished = 0;
  let skippedMissingMasterSku = 0;
  let masterSkuFromMetafield = 0;
  let masterSkuFromSingleVariant = 0;
  let imagesSeen = 0;
  let imagesEligible = 0;
  let skippedNotReady = 0;
  let skippedNoExtension = 0;
  let alreadyCompliant = 0;
  let sharedConflicts = 0;
  const samples: JsonObject[] = [];
  const desiredByMediaId = new Map<string, DesiredMediaUpdate>();
  const conflictedMediaIds = new Set<string>();

  while (productCount < maxProducts) {
    const first = Math.min(PRODUCT_PAGE_SIZE, maxProducts - productCount);
    const data = await shopifyGraphQL<{
      products?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: ShopifyProductNode[];
      };
    }>(env, PRODUCTS_QUERY, { first, after, query: searchQuery });
    const products = data.products?.nodes || [];
    if (!products.length) break;

    for (const product of products) {
      if (productCount >= maxProducts) break;
      productCount += 1;
      if (normalize(product.status).toUpperCase() !== "ACTIVE") continue;
      if (!normalize(product.onlineStoreUrl)) {
        skippedUnpublished += 1;
        continue;
      }
      const productId = normalize(product.id);
      const title = normalize(product.title);
      const productVendor = normalize(product.vendor);
      const resolvedMasterSku = resolveMasterSku(product);
      if (!productId || !title || !productVendor) continue;
      if (!resolvedMasterSku) {
        skippedMissingMasterSku += 1;
        continue;
      }
      if (resolvedMasterSku.source === "xphub.master_sku") masterSkuFromMetafield += 1;
      else masterSkuFromSingleVariant += 1;
      const masterSku = resolvedMasterSku.value;
      eligibleProducts += 1;
      const mediaNodes = product.media?.nodes || [];
      for (let index = 0; index < mediaNodes.length; index += 1) {
        const media = mediaNodes[index];
        imagesSeen += 1;
        if (normalize(media.mediaContentType).toUpperCase() !== "IMAGE") continue;
        if (!mediaReady(media)) {
          skippedNotReady += 1;
          continue;
        }
        const mediaId = normalize(media.id);
        const originalUrl = normalize(media.originalSource?.url) || normalize(media.image?.url);
        const currentFilename = basenameFromUrl(originalUrl);
        const extension = extensionFromFilename(currentFilename);
        if (!mediaId || !currentFilename || !extension) {
          skippedNoExtension += 1;
          continue;
        }
        const position = index + 1;
        const desiredFilename = makeDesiredFilename(productVendor, title, masterSku, position, extension);
        const desiredAlt = makeDesiredAlt(productVendor, title, masterSku, position);
        imagesEligible += 1;
        if (currentFilename.toLowerCase() === desiredFilename.toLowerCase() && sameText(media.alt, desiredAlt)) {
          alreadyCompliant += 1;
          continue;
        }
        const desired: DesiredMediaUpdate = {
          id: mediaId,
          product_id: productId,
          product_title: title,
          vendor: productVendor,
          master_sku: masterSku,
          master_sku_source: resolvedMasterSku.source,
          position,
          current_alt: media.alt ?? null,
          current_filename: currentFilename,
          desired_alt: desiredAlt,
          desired_filename: desiredFilename,
          width: media.image?.width ?? null,
          height: media.image?.height ?? null,
        };
        const existing = desiredByMediaId.get(mediaId);
        if (existing && (existing.desired_filename !== desired.desired_filename || existing.desired_alt !== desired.desired_alt)) {
          desiredByMediaId.delete(mediaId);
          conflictedMediaIds.add(mediaId);
          sharedConflicts += 1;
          continue;
        }
        if (conflictedMediaIds.has(mediaId)) continue;
        desiredByMediaId.set(mediaId, desired);
        if (samples.length < 20) {
          samples.push({
            product_id: productId,
            product_title: title,
            vendor: productVendor,
            master_sku: masterSku,
            master_sku_source: resolvedMasterSku.source,
            position,
            dimensions: media.image?.width && media.image?.height ? `${media.image.width}x${media.image.height}` : null,
            before: { filename: currentFilename, alt: media.alt ?? null },
            after: { filename: desiredFilename, alt: desiredAlt },
          });
        }
      }
    }

    const pageInfo = data.products?.pageInfo;
    if (!pageInfo?.hasNextPage || !normalize(pageInfo.endCursor) || productCount >= maxProducts) break;
    after = normalize(pageInfo.endCursor);
  }

  const updates = Array.from(desiredByMediaId.values());
  return {
    updates,
    metrics: {
      products_scanned: productCount,
      products_eligible: eligibleProducts,
      products_skipped_not_online_store: skippedUnpublished,
      products_skipped_missing_master_sku: skippedMissingMasterSku,
      products_master_sku_from_metafield: masterSkuFromMetafield,
      products_master_sku_from_single_variant: masterSkuFromSingleVariant,
      images_seen: imagesSeen,
      images_eligible: imagesEligible,
      images_already_compliant: alreadyCompliant,
      images_skipped_not_ready: skippedNotReady,
      images_skipped_no_extension: skippedNoExtension,
      shared_media_conflicts: sharedConflicts,
      updates_planned: updates.length,
    },
    samples,
  };
}

async function applyUpdates(updates: DesiredMediaUpdate[], env: ShopifyMediaSeoEnv): Promise<{ applied: number; errors: JsonObject[] }> {
  let applied = 0;
  const errors: JsonObject[] = [];
  for (let offset = 0; offset < updates.length; offset += FILE_UPDATE_BATCH_SIZE) {
    const batch = updates.slice(offset, offset + FILE_UPDATE_BATCH_SIZE);
    const result = await shopifyGraphQL<{
      fileUpdate?: {
        files?: Array<{ id?: string; alt?: string | null; fileStatus?: string | null; image?: { url?: string } | null }>;
        userErrors?: Array<{ field?: string[]; message?: string; code?: string }>;
      };
    }>(env, FILE_UPDATE_MUTATION, {
      files: batch.map((item) => ({ id: item.id, alt: item.desired_alt, filename: item.desired_filename })),
    });
    const userErrors = result.fileUpdate?.userErrors || [];
    for (const error of userErrors) {
      errors.push({ field: error.field || [], message: normalize(error.message), code: normalize(error.code) || null, batch_offset: offset });
    }
    applied += (result.fileUpdate?.files || []).length;
    if (offset + FILE_UPDATE_BATCH_SIZE < updates.length) await sleep(180);
  }
  return { applied, errors };
}

async function runAuthorizedRequest(requestPath: string, env: ShopifyMediaSeoEnv): Promise<JsonObject> {
  const authorized = await loadAuthorizedRequest(requestPath);
  const request = authorized.request;
  const configured = Boolean(normalize(env.SHOPIFY_SHOP_DOMAIN) && env.SHOPIFY_TOKENS_KV);
  if (!configured) throw new Error("shopify_media_seo_not_configured");

  const collected = await collectDesiredUpdates(request, env);
  if (request.mode === "dry_run") {
    return {
      ok: true,
      schema: "shopify_media_seo_result_v1",
      request_path: requestPath,
      request_hash: authorized.request_hash,
      mode: "dry_run",
      policy: request.policy,
      scope: request.scope,
      external_write_performed: false,
      metadata_only: true,
      image_bytes_modified: false,
      card_theme_modified: false,
      metrics: collected.metrics,
      samples: collected.samples,
    };
  }

  const applied = await applyUpdates(collected.updates, env);
  return {
    ok: applied.errors.length === 0,
    schema: "shopify_media_seo_result_v1",
    request_path: requestPath,
    request_hash: authorized.request_hash,
    mode: "execute",
    policy: request.policy,
    scope: request.scope,
    external_write_performed: true,
    metadata_only: true,
    image_bytes_modified: false,
    card_theme_modified: false,
    metrics: { ...collected.metrics, updates_applied: applied.applied, update_errors: applied.errors.length },
    errors: applied.errors.slice(0, 100),
    samples: collected.samples,
  };
}

export async function handleShopifyMediaSeoBridgeRequest(request: Request, env: ShopifyMediaSeoEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== BRIDGE_PATH) return null;
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  let args: JsonObject;
  try { args = object(await request.json()); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const requestPath = normalize(args.request_path);
  try {
    const result = await runAuthorizedRequest(requestPath, env);
    return json(result, result.ok === false ? 207 : 200);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "shopify_media_seo_bridge_failed", request_path: requestPath || null }, 500);
  }
}
