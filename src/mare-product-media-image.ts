import {
  getShopifyProductImage,
  type ProductMediaEnv,
  type StoredProductImagePreview,
} from "./mare-product-media-shopify.js";

type JsonObject = Record<string, unknown>;

type ImagePipeline = {
  transform(options: Record<string, unknown>): ImagePipeline;
  output(options: Record<string, unknown>): ImagePipeline;
  response(): Promise<Response>;
};

type ImagesBinding = {
  input(stream: ReadableStream<Uint8Array>): ImagePipeline;
};

export type ProductImageEnv = ProductMediaEnv & {
  OPENAI_API_KEY?: string;
  PRODUCT_IMAGE_MODEL?: string;
  IMAGES?: ImagesBinding;
  [key: string]: unknown;
};

const OPENAI_IMAGE_EDIT_URL = "https://api.openai.com/v1/images/edits";
const PREVIEW_TTL_SECONDS = 24 * 60 * 60;
const PROMPT_VERSION = "devid-ecommerce-product-v1";
const OUTPUT_WIDTH = 600;
const OUTPUT_HEIGHT = 771;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function previewKey(previewId: string): string {
  return `product-media:preview:${previewId}`;
}

function idempotencyKey(value: string): string {
  return `product-media:idempotency:preview:${value}`;
}

function safeIdempotency(value: unknown): string {
  const normalized = normalize(value);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(normalized)) throw new Error("invalid_idempotency_key");
  return normalized;
}

function imageEditPrompt(productTitle: string): string {
  return [
    "Edit the supplied real product photograph for a premium fashion e-commerce catalog.",
    `The product is: ${productTitle}.`,
    "This is a strict product-preservation task, not a redesign and not a new product generation.",
    "Keep the exact same physical sneaker, exact perspective, proportions, silhouette, sole shape, toe shape, laces, eyelets, stitching, panels, materials, textures, logos, labels, colors, distressing and every visible detail.",
    "Do not add, remove, repair, simplify, reinterpret or hallucinate any product detail.",
    "Remove only the original background and any unrelated support or surface.",
    "Place the complete sneaker on a uniform pure white #FFFFFF e-commerce background.",
    "Keep the entire sneaker visible with no cropping. Center it optically, preserve its original orientation, and size it consistently so the product occupies about 80 to 85 percent of the usable frame.",
    "No decorative props, no text, no watermark, no border, no gradient and no dramatic shadow.",
    "A very subtle natural contact shadow is allowed only if necessary to avoid a floating appearance.",
    "Return one clean product image only.",
  ].join("\n");
}

async function editWithOpenAI(
  sourceBytes: Uint8Array,
  sourceMimeType: string,
  productTitle: string,
  env: ProductImageEnv,
): Promise<Uint8Array> {
  const apiKey = normalize(env.OPENAI_API_KEY);
  if (!apiKey) throw new Error("openai_api_key_not_configured");
  const form = new FormData();
  form.append("model", normalize(env.PRODUCT_IMAGE_MODEL) || "gpt-image-2");
  form.append("prompt", imageEditPrompt(productTitle));
  form.append("size", "1024x1536");
  form.append("quality", "high");
  form.append("output_format", "png");
  form.append("background", "opaque");
  form.append("image", new Blob([toArrayBuffer(sourceBytes)], { type: sourceMimeType }), "source-product-image");
  const response = await fetch(OPENAI_IMAGE_EDIT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  let payload: { data?: Array<{ b64_json?: string }>; error?: { message?: string; code?: string } } = {};
  try {
    payload = await response.json() as typeof payload;
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const code = normalize(payload.error?.code) || `http_${response.status}`;
    throw new Error(`openai_image_edit_failed_${code}`);
  }
  const encoded = normalize(payload.data?.[0]?.b64_json);
  if (!encoded) throw new Error("openai_image_edit_empty_result");
  const bytes = base64ToBytes(encoded);
  if (!bytes.byteLength || bytes.byteLength > 20 * 1024 * 1024) throw new Error("openai_image_edit_invalid_size");
  return bytes;
}

async function normalizeCanvas(generatedPng: Uint8Array, env: ProductImageEnv): Promise<Uint8Array> {
  if (!env.IMAGES) throw new Error("cloudflare_images_binding_not_configured");
  const source = new Blob([toArrayBuffer(generatedPng)], { type: "image/png" }).stream();
  const pipeline = env.IMAGES
    .input(source)
    .transform({
      width: OUTPUT_WIDTH,
      height: OUTPUT_HEIGHT,
      fit: "pad",
      gravity: "center",
      background: "#FFFFFF",
    })
    .output({ format: "image/jpeg", quality: 92 });
  const response = await pipeline.response();
  if (!response.ok) throw new Error(`cloudflare_image_transform_failed_${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > 8 * 1024 * 1024) throw new Error("normalized_image_invalid_size");
  return bytes;
}

export async function productImageConfiguration(env: ProductImageEnv): Promise<JsonObject> {
  return {
    configured: Boolean(env.OPENAI_API_KEY && env.IMAGES && env.SHOPIFY_TOKENS_KV),
    openai_configured: Boolean(env.OPENAI_API_KEY),
    cloudflare_images_configured: Boolean(env.IMAGES),
    preview_store_configured: Boolean(env.SHOPIFY_TOKENS_KV),
    image_model: normalize(env.PRODUCT_IMAGE_MODEL) || "gpt-image-2",
    canvas: { width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT, background: "#FFFFFF", format: "image/jpeg" },
    preview_ttl_hours: PREVIEW_TTL_SECONDS / 3600,
    prompt_version: PROMPT_VERSION,
    automatic_product_publish: false,
  };
}

export async function loadStoredProductImagePreview(
  previewId: string,
  env: ProductImageEnv,
): Promise<StoredProductImagePreview> {
  if (!env.SHOPIFY_TOKENS_KV) throw new Error("preview_store_not_configured");
  if (!/^pm_[A-Za-z0-9-]{20,80}$/.test(previewId)) throw new Error("invalid_preview_id");
  const raw = await env.SHOPIFY_TOKENS_KV.get(previewKey(previewId));
  if (!raw) throw new Error("preview_not_found_or_expired");
  let preview: StoredProductImagePreview;
  try {
    preview = JSON.parse(raw) as StoredProductImagePreview;
  } catch {
    throw new Error("preview_record_invalid");
  }
  if (preview.preview_id !== previewId || !preview.image_base64 || preview.width !== 600 || preview.height !== 771) {
    throw new Error("preview_record_invalid");
  }
  return preview;
}

export async function generateProductImagePreview(
  args: JsonObject,
  env: ProductImageEnv,
): Promise<{ metadata: JsonObject; imageBase64: string; mimeType: "image/jpeg" }> {
  if (normalize(args.approval_confirmation) !== "GENERATE PRODUCT IMAGE PREVIEW") {
    throw new Error("preview_generation_confirmation_required");
  }
  if (!env.SHOPIFY_TOKENS_KV) throw new Error("preview_store_not_configured");
  const idem = safeIdempotency(args.idempotency_key);
  const existingId = normalize(await env.SHOPIFY_TOKENS_KV.get(idempotencyKey(idem)));
  if (existingId) {
    const existing = await loadStoredProductImagePreview(existingId, env);
    return {
      metadata: {
        ok: true,
        status: "existing_preview",
        preview_id: existing.preview_id,
        product_id: existing.product_id,
        product_title: existing.product_title,
        source_media_id: existing.source_media_id,
        width: existing.width,
        height: existing.height,
        mime_type: existing.mime_type,
        created_at: existing.created_at,
        expires_at: existing.expires_at,
        publish_confirmation_required: "PUBLISH PRODUCT IMAGE TO SHOPIFY",
      },
      imageBase64: existing.image_base64,
      mimeType: existing.mime_type,
    };
  }

  const source = await getShopifyProductImage(args, env);
  const product = source.metadata.product as { id?: string; title?: string };
  const media = source.metadata.media as { id?: string; original_url?: string };
  const productId = normalize(product?.id);
  const productTitle = normalize(product?.title);
  const sourceMediaId = normalize(media?.id);
  if (!productId || !productTitle || !sourceMediaId) throw new Error("source_product_metadata_invalid");
  const generatedPng = await editWithOpenAI(source.bytes, source.mimeType, productTitle, env);
  const normalizedJpeg = await normalizeCanvas(generatedPng, env);
  const previewId = `pm_${crypto.randomUUID()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PREVIEW_TTL_SECONDS * 1000);
  const preview: StoredProductImagePreview = {
    preview_id: previewId,
    idempotency_key: idem,
    product_id: productId,
    product_title: productTitle,
    source_media_id: sourceMediaId,
    source_url: normalize(media?.original_url),
    mime_type: "image/jpeg",
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    image_base64: bytesToBase64(normalizedJpeg),
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    prompt_version: PROMPT_VERSION,
  };
  await env.SHOPIFY_TOKENS_KV.put(previewKey(previewId), JSON.stringify(preview), { expirationTtl: PREVIEW_TTL_SECONDS });
  await env.SHOPIFY_TOKENS_KV.put(idempotencyKey(idem), previewId, { expirationTtl: PREVIEW_TTL_SECONDS });
  return {
    metadata: {
      ok: true,
      status: "preview_created",
      preview_id: previewId,
      product_id: productId,
      product_title: productTitle,
      source_media_id: sourceMediaId,
      source_bytes: source.bytes.byteLength,
      output_bytes: normalizedJpeg.byteLength,
      width: OUTPUT_WIDTH,
      height: OUTPUT_HEIGHT,
      mime_type: "image/jpeg",
      background: "#FFFFFF",
      prompt_version: PROMPT_VERSION,
      created_at: preview.created_at,
      expires_at: preview.expires_at,
      external_storefront_write_performed: false,
      visual_fidelity_review_required: true,
      publish_confirmation_required: "PUBLISH PRODUCT IMAGE TO SHOPIFY",
    },
    imageBase64: preview.image_base64,
    mimeType: preview.mime_type,
  };
}
