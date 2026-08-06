import { shopifyGraphQL, type Env as ShopifyBaseEnv } from "./index.js";

type JsonObject = Record<string, unknown>;

type KVNamespaceLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

export type ProductMediaEnv = ShopifyBaseEnv & {
  SHOPIFY_TOKENS_KV?: KVNamespaceLike;
  [key: string]: unknown;
};

export type ShopifyMediaImage = {
  id: string;
  mediaContentType: string;
  status?: string | null;
  alt?: string | null;
  position: number;
  image_url: string;
  original_url: string;
  width?: number | null;
  height?: number | null;
};

export type ShopifyProductMedia = {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  status?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  media: ShopifyMediaImage[];
};

export type StoredProductImagePreview = {
  preview_id: string;
  idempotency_key: string;
  product_id: string;
  product_title: string;
  source_media_id: string;
  source_url: string;
  mime_type: "image/jpeg";
  width: 600;
  height: 771;
  image_base64: string;
  created_at: string;
  expires_at: string;
  prompt_version: string;
};

type ShopifyMediaNode = {
  id?: string;
  mediaContentType?: string;
  status?: string | null;
  alt?: string | null;
  image?: { url?: string; width?: number | null; height?: number | null } | null;
  originalSource?: { url?: string; width?: number | null; height?: number | null } | null;
};

type ShopifyProductNode = {
  id?: string;
  title?: string;
  handle?: string;
  vendor?: string;
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  media?: { nodes?: ShopifyMediaNode[] } | null;
};

const PRODUCT_QUERY = `
  query MareProductMediaFind($query: String!, $first: Int!) {
    products(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        title
        handle
        vendor
        status
        createdAt
        updatedAt
        media(first: 100) {
          nodes {
            id
            mediaContentType
            status
            alt
            ... on MediaImage {
              image { url width height }
              originalSource { url width height }
            }
          }
        }
      }
    }
  }
`;

const PRODUCT_BY_ID_QUERY = `
  query MareProductMediaById($id: ID!) {
    node(id: $id) {
      ... on Product {
        id
        title
        handle
        vendor
        status
        createdAt
        updatedAt
        media(first: 100) {
          nodes {
            id
            mediaContentType
            status
            alt
            ... on MediaImage {
              image { url width height }
              originalSource { url width height }
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

function normalizeText(value: unknown): string {
  return normalize(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function escapeShopifySearch(value: string): string {
  return value.replace(/[\\']/g, (character) => `\\${character}`);
}

function mapProduct(node: ShopifyProductNode): ShopifyProductMedia | null {
  const id = normalize(node.id);
  const title = normalize(node.title);
  const vendor = normalize(node.vendor);
  const handle = normalize(node.handle);
  if (!id || !title || !vendor) return null;
  const media = (node.media?.nodes || [])
    .map((item, index): ShopifyMediaImage | null => {
      const mediaId = normalize(item.id);
      const imageUrl = normalize(item.image?.url);
      const originalUrl = normalize(item.originalSource?.url) || imageUrl;
      if (!mediaId || !imageUrl || !originalUrl || normalize(item.mediaContentType) !== "IMAGE") return null;
      return {
        id: mediaId,
        mediaContentType: "IMAGE",
        status: item.status ?? null,
        alt: item.alt ?? null,
        position: index + 1,
        image_url: imageUrl,
        original_url: originalUrl,
        width: item.originalSource?.width ?? item.image?.width ?? null,
        height: item.originalSource?.height ?? item.image?.height ?? null,
      };
    })
    .filter((item): item is ShopifyMediaImage => Boolean(item));
  return {
    id,
    title,
    handle,
    vendor,
    status: node.status ?? null,
    created_at: node.createdAt ?? null,
    updated_at: node.updatedAt ?? null,
    media,
  };
}

export async function shopifyProductMediaConfiguration(env: ProductMediaEnv): Promise<JsonObject> {
  const shop = normalize(env.SHOPIFY_SHOP_DOMAIN).toLowerCase();
  let grantedScopes: string[] = [];
  if (shop && env.SHOPIFY_TOKENS_KV) {
    try {
      const raw = await env.SHOPIFY_TOKENS_KV.get(`shopify:offline_token:${shop}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { scope?: unknown };
        grantedScopes = normalize(parsed.scope).split(",").map((scope) => scope.trim()).filter(Boolean);
      }
    } catch {
      grantedScopes = [];
    }
  }
  return {
    configured: Boolean(shop && env.SHOPIFY_TOKENS_KV),
    shop_domain_configured: Boolean(shop),
    oauth_kv_configured: Boolean(env.SHOPIFY_TOKENS_KV),
    required_scopes: ["read_products", "write_products"],
    granted_scopes: grantedScopes,
    read_products_granted: grantedScopes.includes("read_products"),
    write_products_granted: grantedScopes.includes("write_products"),
    originals_are_never_deleted: true,
  };
}

export async function findShopifyProductMedia(args: JsonObject, env: ProductMediaEnv): Promise<JsonObject> {
  const vendor = normalize(args.vendor);
  const startTitle = normalize(args.start_title);
  const endTitle = normalize(args.end_title);
  const maxProducts = integer(args.max_products, 50, 1, 100);
  if (!vendor || vendor.length > 120) throw new Error("invalid_vendor");
  const query = `vendor:'${escapeShopifySearch(vendor)}'`;
  const data = await shopifyGraphQL<{ products?: { nodes?: ShopifyProductNode[] } }>(env, PRODUCT_QUERY, {
    query,
    first: 100,
  });
  let products = (data.products?.nodes || [])
    .map(mapProduct)
    .filter((product): product is ShopifyProductMedia => Boolean(product))
    .filter((product) => normalizeText(product.vendor) === normalizeText(vendor));

  const warnings: string[] = [];
  if (startTitle || endTitle) {
    const startIndex = startTitle ? products.findIndex((product) => normalizeText(product.title) === normalizeText(startTitle)) : 0;
    const endIndex = endTitle ? products.findIndex((product) => normalizeText(product.title) === normalizeText(endTitle)) : products.length - 1;
    if (startTitle && startIndex < 0) warnings.push("start_title_not_found");
    if (endTitle && endIndex < 0) warnings.push("end_title_not_found");
    if ((!startTitle || startIndex >= 0) && (!endTitle || endIndex >= 0) && products.length) {
      const first = Math.min(startIndex < 0 ? 0 : startIndex, endIndex < 0 ? products.length - 1 : endIndex);
      const last = Math.max(startIndex < 0 ? 0 : startIndex, endIndex < 0 ? products.length - 1 : endIndex);
      products = products.slice(first, last + 1);
    }
  }

  products = products.slice(0, maxProducts);
  return {
    ok: true,
    vendor,
    selection: {
      start_title: startTitle || null,
      end_title: endTitle || null,
      ordering: "Shopify createdAt descending",
    },
    product_count: products.length,
    image_count: products.reduce((sum, product) => sum + product.media.length, 0),
    warnings,
    products,
  };
}

export async function getShopifyProductImage(
  args: JsonObject,
  env: ProductMediaEnv,
): Promise<{ metadata: JsonObject; bytes: Uint8Array; mimeType: string }> {
  const productId = normalize(args.product_id);
  const mediaId = normalize(args.media_id);
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) throw new Error("invalid_product_id");
  if (mediaId && !/^gid:\/\/shopify\/[A-Za-z]+\/\d+$/.test(mediaId)) throw new Error("invalid_media_id");
  const data = await shopifyGraphQL<{ node?: ShopifyProductNode | null }>(env, PRODUCT_BY_ID_QUERY, { id: productId });
  const product = mapProduct(data.node || {});
  if (!product) throw new Error("shopify_product_not_found");
  const media = mediaId ? product.media.find((item) => item.id === mediaId) : product.media[0];
  if (!media) throw new Error("shopify_product_image_not_found");
  const response = await fetch(media.original_url, {
    headers: { Accept: "image/avif,image/webp,image/png,image/jpeg" },
  });
  if (!response.ok) throw new Error(`shopify_image_download_failed_${response.status}`);
  const contentLength = Number(response.headers.get("Content-Length") || "0");
  if (Number.isFinite(contentLength) && contentLength > 12 * 1024 * 1024) throw new Error("shopify_image_too_large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > 12 * 1024 * 1024) throw new Error("shopify_image_too_large");
  const contentType = (response.headers.get("Content-Type") || "image/jpeg").split(";")[0].trim().toLowerCase();
  const mimeType = ["image/jpeg", "image/png", "image/webp", "image/avif"].includes(contentType) ? contentType : "image/jpeg";
  return {
    metadata: {
      ok: true,
      product: { id: product.id, title: product.title, handle: product.handle, vendor: product.vendor },
      media,
      bytes: bytes.byteLength,
      mime_type: mimeType,
    },
    bytes,
    mimeType,
  };
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function currentProductMediaIds(productId: string, env: ProductMediaEnv): Promise<string[]> {
  const data = await shopifyGraphQL<{ node?: ShopifyProductNode | null }>(env, PRODUCT_BY_ID_QUERY, { id: productId });
  return (data.node?.media?.nodes || []).map((item) => normalize(item.id)).filter(Boolean);
}

async function stagedUploadProductImage(
  preview: StoredProductImagePreview,
  filename: string,
  env: ProductMediaEnv,
): Promise<string> {
  const result = await shopifyGraphQL<{
    stagedUploadsCreate?: {
      stagedTargets?: Array<{ url?: string; resourceUrl?: string; parameters?: Array<{ name?: string; value?: string }> }>;
      userErrors?: Array<{ field?: string[]; message?: string }>;
    };
  }>(env, `
    mutation MareStageProductImage($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }
  `, {
    input: [{ filename, mimeType: preview.mime_type, resource: "PRODUCT_IMAGE", httpMethod: "POST" }],
  });
  const errors = result.stagedUploadsCreate?.userErrors || [];
  if (errors.length) throw new Error(`shopify_staged_upload_error:${errors.map((item) => item.message).join(" | ")}`);
  const target = result.stagedUploadsCreate?.stagedTargets?.[0];
  const uploadUrl = normalize(target?.url);
  const resourceUrl = normalize(target?.resourceUrl);
  if (!uploadUrl || !resourceUrl) throw new Error("shopify_staged_upload_target_missing");
  const form = new FormData();
  for (const parameter of target?.parameters || []) {
    const name = normalize(parameter.name);
    if (name) form.append(name, normalize(parameter.value));
  }
  const bytes = bytesFromBase64(preview.image_base64);
  form.append("file", new Blob([bytes], { type: preview.mime_type }), filename);
  const upload = await fetch(uploadUrl, { method: "POST", body: form });
  if (!upload.ok) throw new Error(`shopify_staged_binary_upload_failed_${upload.status}`);
  return resourceUrl;
}

export async function publishProductImagePreview(
  args: JsonObject,
  preview: StoredProductImagePreview,
  env: ProductMediaEnv,
): Promise<JsonObject> {
  if (normalize(args.approval_confirmation) !== "PUBLISH PRODUCT IMAGE TO SHOPIFY") {
    throw new Error("publish_confirmation_required");
  }
  const productId = normalize(args.product_id);
  if (productId !== preview.product_id) throw new Error("preview_product_mismatch");
  const altText = normalize(args.alt_text) || preview.product_title;
  if (altText.length > 512) throw new Error("invalid_alt_text");
  const makePrimary = args.make_primary === true;
  const beforeIds = new Set(await currentProductMediaIds(productId, env));
  const filenameBase = preview.product_title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "product";
  const filename = `${filenameBase}-${preview.preview_id.slice(-8)}.jpg`;
  const resourceUrl = await stagedUploadProductImage(preview, filename, env);
  const mutation = await shopifyGraphQL<{
    productUpdate?: {
      product?: { id?: string; media?: { nodes?: ShopifyMediaNode[] } };
      userErrors?: Array<{ field?: string[]; message?: string }>;
      mediaUserErrors?: Array<{ field?: string[]; message?: string; code?: string }>;
    };
  }>(env, `
    mutation MareAttachProductImage($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
      productUpdate(product: $product, media: $media) {
        product { id media(first: 100) { nodes { id mediaContentType status alt } } }
        userErrors { field message }
        mediaUserErrors { field message code }
      }
    }
  `, {
    product: { id: productId },
    media: [{ originalSource: resourceUrl, mediaContentType: "IMAGE", alt: altText }],
  });
  const errors = [
    ...(mutation.productUpdate?.userErrors || []).map((item) => item.message),
    ...(mutation.productUpdate?.mediaUserErrors || []).map((item) => item.message),
  ].filter(Boolean);
  if (errors.length) throw new Error(`shopify_product_media_attach_error:${errors.join(" | ")}`);

  let mediaIds = (mutation.productUpdate?.product?.media?.nodes || []).map((item) => normalize(item.id)).filter(Boolean);
  let newMediaId = mediaIds.find((id) => !beforeIds.has(id)) || "";
  for (let attempt = 0; !newMediaId && attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    mediaIds = await currentProductMediaIds(productId, env);
    newMediaId = mediaIds.find((id) => !beforeIds.has(id)) || "";
  }
  if (!newMediaId) throw new Error("shopify_new_media_id_not_resolved");

  let reorderJobId: string | null = null;
  if (makePrimary) {
    const reorder = await shopifyGraphQL<{
      productReorderMedia?: {
        job?: { id?: string } | null;
        mediaUserErrors?: Array<{ field?: string[]; message?: string; code?: string }>;
      };
    }>(env, `
      mutation MareReorderProductImage($id: ID!, $moves: [MoveInput!]!) {
        productReorderMedia(id: $id, moves: $moves) {
          job { id }
          mediaUserErrors { field message code }
        }
      }
    `, { id: productId, moves: [{ id: newMediaId, newPosition: "0" }] });
    const reorderErrors = reorder.productReorderMedia?.mediaUserErrors || [];
    if (reorderErrors.length) throw new Error(`shopify_product_media_reorder_error:${reorderErrors.map((item) => item.message).join(" | ")}`);
    reorderJobId = normalize(reorder.productReorderMedia?.job?.id) || null;
  }

  return {
    ok: true,
    status: "published",
    product_id: productId,
    product_title: preview.product_title,
    preview_id: preview.preview_id,
    media_id: newMediaId,
    made_primary: makePrimary,
    reorder_job_id: reorderJobId,
    originals_deleted: false,
    rollback: "Remove the newly created media manually or through a future separately approved delete tool. Existing originals were preserved.",
  };
}
