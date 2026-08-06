import {
  findShopifyProductMedia,
  getShopifyProductImage,
  publishProductImagePreview,
  shopifyProductMediaConfiguration,
  type ProductMediaEnv,
} from "./mare-product-media-shopify.js";
import {
  generateProductImagePreview,
  loadStoredProductImagePreview,
  productImageConfiguration,
  type ProductImageEnv,
} from "./mare-product-media-image.js";

type JsonObject = Record<string, unknown>;

type ProductMediaMcpEnv = ProductImageEnv & ProductMediaEnv & {
  MARE_PRODUCT_MEDIA_ACCESS_TOKEN?: string;
  [key: string]: unknown;
};

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonObject;
};

const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const MAX_REQUEST_BYTES = 96 * 1024;

const ALLOWED_ORIGINS = new Set([
  "https://chatgpt.com",
  "https://www.chatgpt.com",
  "https://chat.openai.com",
]);

const PUBLIC_DISCOVERY_METHODS = new Set(["initialize", "ping", "tools/list"]);
const PUBLIC_DISCOVERY_NOTIFICATIONS = new Set(["notifications/initialized", "notifications/cancelled"]);

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const CONTROLLED_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const TOOLS = [
  {
    name: "mare_product_media_health",
    title: "MARE Product Media OS health",
    description: "Checks Shopify media access, image-editing configuration, preview storage and safety controls without exposing credentials.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_shopify_find_product_media",
    title: "Find Shopify product images",
    description: "Finds Shopify products and their image media for an exact vendor. Optional start and end titles select an inclusive created-at-ordered range. It performs no writes.",
    inputSchema: {
      type: "object",
      properties: {
        vendor: { type: "string", minLength: 1, maxLength: 120 },
        start_title: { type: "string", maxLength: 240 },
        end_title: { type: "string", maxLength: 240 },
        max_products: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      required: ["vendor"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_shopify_get_product_image",
    title: "Read one Shopify product image",
    description: "Downloads one original Shopify product image and returns it visually for inspection. It performs no writes.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string", pattern: "^gid://shopify/Product/[0-9]+$" },
        media_id: { type: "string", pattern: "^gid://shopify/[A-Za-z]+/[0-9]+$" },
      },
      required: ["product_id", "media_id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_product_image_generate_preview",
    title: "Generate a strict e-commerce product-image preview",
    description: "Uses the original Shopify image to create a product-faithful white-background preview, normalizes it to exactly 600 x 771 px, stores it temporarily for 24 hours, and returns it for visual review. It does not alter the storefront. Exact approval and idempotency are required because image generation has an external cost.",
    inputSchema: {
      type: "object",
      properties: {
        approval_confirmation: { type: "string", const: "GENERATE PRODUCT IMAGE PREVIEW" },
        idempotency_key: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" },
        product_id: { type: "string", pattern: "^gid://shopify/Product/[0-9]+$" },
        media_id: { type: "string", pattern: "^gid://shopify/[A-Za-z]+/[0-9]+$" },
      },
      required: ["approval_confirmation", "idempotency_key", "product_id", "media_id"],
      additionalProperties: false,
    },
    annotations: CONTROLLED_WRITE_ANNOTATIONS,
  },
  {
    name: "mare_product_image_get_preview",
    title: "Retrieve a stored product-image preview",
    description: "Returns a previously generated preview by preview ID while it remains within its 24-hour retention window. It performs no external write.",
    inputSchema: {
      type: "object",
      properties: {
        preview_id: { type: "string", pattern: "^pm_[A-Za-z0-9-]{20,80}$" },
      },
      required: ["preview_id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_product_image_publish",
    title: "Publish an approved product image to Shopify",
    description: "Uploads the exact approved stored preview and attaches it to the matching Shopify product. Existing images are preserved. It can optionally move the new image to the first position. Exact approval and idempotency are mandatory. Deletion is not available.",
    inputSchema: {
      type: "object",
      properties: {
        approval_confirmation: { type: "string", const: "PUBLISH PRODUCT IMAGE TO SHOPIFY" },
        idempotency_key: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" },
        preview_id: { type: "string", pattern: "^pm_[A-Za-z0-9-]{20,80}$" },
        product_id: { type: "string", pattern: "^gid://shopify/Product/[0-9]+$" },
        alt_text: { type: "string", maxLength: 512 },
        make_primary: { type: "boolean", default: false },
      },
      required: ["approval_confirmation", "idempotency_key", "preview_id", "product_id"],
      additionalProperties: false,
    },
    annotations: CONTROLLED_WRITE_ANNOTATIONS,
  },
] as const;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function timingSafeEqualText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function suppliedToken(request: Request): string {
  const authorization = request.headers.get("Authorization") || "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return normalize(request.headers.get("X-MARE-PRODUCT-MEDIA-Key"));
}

function isAuthorized(request: Request, env: ProductMediaMcpEnv): boolean {
  const expected = normalize(env.MARE_PRODUCT_MEDIA_ACCESS_TOKEN);
  return Boolean(expected) && timingSafeEqualText(suppliedToken(request), expected);
}

function isAllowedOrigin(request: Request): boolean {
  const origin = normalize(request.headers.get("Origin"));
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function protocolVersion(request: Request, rpc?: RpcRequest): string {
  return normalize(rpc?.params?.protocolVersion) || normalize(request.headers.get("MCP-Protocol-Version")) || DEFAULT_PROTOCOL_VERSION;
}

function responseHeaders(version = DEFAULT_PROTOCOL_VERSION): HeadersInit {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "MCP-Protocol-Version": version,
  };
}

function rpcResult(id: RpcRequest["id"], result: unknown, version: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), { status: 200, headers: responseHeaders(version) });
}

function rpcError(id: RpcRequest["id"], code: number, message: string, status = 200, data?: unknown, version = DEFAULT_PROTOCOL_VERSION): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }), {
    status,
    headers: responseHeaders(version),
  });
}

function authError(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { ...responseHeaders(), "WWW-Authenticate": "Bearer realm=\"MARE Product Media OS MCP\"" },
  });
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function textToolResult(payload: JsonObject): JsonObject {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function imageToolResult(payload: JsonObject, imageBase64: string, mimeType: string): JsonObject {
  return {
    content: [
      { type: "text", text: JSON.stringify(payload) },
      { type: "image", data: imageBase64, mimeType },
    ],
    structuredContent: payload,
    isError: false,
  };
}

function toolFailure(message: string): JsonObject {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function safeIdempotency(value: unknown): string {
  const normalized = normalize(value);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(normalized)) throw new Error("invalid_idempotency_key");
  return normalized;
}

function publishIdempotencyKey(value: string): string {
  return `product-media:idempotency:publish:${value}`;
}

function audit(event: string, details: { requestId: string; tool?: string; success: boolean; reason?: string }): void {
  console.info(JSON.stringify({
    audit_schema: "mare_product_media_v1",
    generated_at: new Date().toISOString(),
    event,
    request_id: details.requestId,
    tool: details.tool || null,
    success: details.success,
    reason: details.reason || null,
    raw_arguments_logged: false,
    image_bytes_logged: false,
    secrets_logged: false,
  }));
}

async function health(env: ProductMediaMcpEnv): Promise<JsonObject> {
  const shopify = await shopifyProductMediaConfiguration(env);
  const image = await productImageConfiguration(env);
  return {
    ok: true,
    service: "mare_product_media_os_mcp",
    version: SERVER_VERSION,
    generated_at: new Date().toISOString(),
    configured: Boolean(env.MARE_PRODUCT_MEDIA_ACCESS_TOKEN),
    authentication: {
      isolated_secret: "MARE_PRODUCT_MEDIA_ACCESS_TOKEN",
      operations_token_fallback: false,
      commerce_token_fallback: false,
      public_discovery_only: true,
      tool_calls_require_authentication: true,
    },
    mode: "controlled_product_media_operations",
    tools: TOOLS.map((tool) => tool.name),
    shopify,
    image_pipeline: image,
    safety: {
      originals_deleted: false,
      delete_tool_exposed: false,
      preview_required_before_publish: true,
      explicit_confirmation_required_for_generation: true,
      explicit_confirmation_required_for_publish: true,
      preview_retention_hours: 24,
    },
  };
}

async function callTool(name: string, args: JsonObject, env: ProductMediaMcpEnv): Promise<JsonObject> {
  if (name === "mare_product_media_health") return textToolResult(await health(env));
  if (name === "mare_shopify_find_product_media") return textToolResult(await findShopifyProductMedia(args, env));
  if (name === "mare_shopify_get_product_image") {
    const result = await getShopifyProductImage(args, env);
    return imageToolResult(result.metadata, bytesToBase64(result.bytes), result.mimeType);
  }
  if (name === "mare_product_image_generate_preview") {
    const result = await generateProductImagePreview(args, env);
    return imageToolResult(result.metadata, result.imageBase64, result.mimeType);
  }
  if (name === "mare_product_image_get_preview") {
    const previewId = normalize(args.preview_id);
    const preview = await loadStoredProductImagePreview(previewId, env);
    const metadata: JsonObject = {
      ok: true,
      status: "preview_loaded",
      preview_id: preview.preview_id,
      product_id: preview.product_id,
      product_title: preview.product_title,
      source_media_id: preview.source_media_id,
      width: preview.width,
      height: preview.height,
      mime_type: preview.mime_type,
      created_at: preview.created_at,
      expires_at: preview.expires_at,
      publish_confirmation_required: "PUBLISH PRODUCT IMAGE TO SHOPIFY",
    };
    return imageToolResult(metadata, preview.image_base64, preview.mime_type);
  }
  if (name === "mare_product_image_publish") {
    if (!env.SHOPIFY_TOKENS_KV) throw new Error("preview_store_not_configured");
    const idem = safeIdempotency(args.idempotency_key);
    const key = publishIdempotencyKey(idem);
    const existingRaw = await env.SHOPIFY_TOKENS_KV.get(key);
    if (existingRaw) {
      try {
        return textToolResult({ ...(JSON.parse(existingRaw) as JsonObject), idempotent_replay: true });
      } catch {
        throw new Error("publish_idempotency_record_invalid");
      }
    }
    const preview = await loadStoredProductImagePreview(normalize(args.preview_id), env);
    const result = await publishProductImagePreview(args, preview, env);
    await env.SHOPIFY_TOKENS_KV.put(key, JSON.stringify(result), { expirationTtl: 30 * 24 * 60 * 60 });
    return textToolResult(result);
  }
  return toolFailure(`Unknown tool: ${name}`);
}

async function parseRpcRequest(request: Request): Promise<RpcRequest> {
  const declaredLength = Number(request.headers.get("Content-Length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) throw new Error("request_too_large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) throw new Error("request_too_large");
  try {
    return JSON.parse(text) as RpcRequest;
  } catch {
    throw new Error("parse_error");
  }
}

export async function handleMareProductMediaMcpRequest(
  request: Request,
  env: ProductMediaMcpEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp-product-media" && url.pathname !== "/mcp-product-media/health") return null;
  const requestId = crypto.randomUUID();
  if (!isAllowedOrigin(request)) {
    audit("request_denied", { requestId, success: false, reason: "origin_not_allowed" });
    return new Response(JSON.stringify({ error: "origin_not_allowed" }), { status: 403, headers: responseHeaders() });
  }
  if (url.pathname === "/mcp-product-media/health") {
    return new Response(JSON.stringify(await health(env)), { status: 200, headers: responseHeaders() });
  }
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": request.headers.get("Origin") || "https://chatgpt.com",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, X-MARE-PRODUCT-MEDIA-Key",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Max-Age": "600",
      },
    });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { ...responseHeaders(), Allow: "POST, OPTIONS" } });
  }

  let rpc: RpcRequest;
  try {
    rpc = await parseRpcRequest(request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "parse_error";
    audit("request_rejected", { requestId, success: false, reason });
    return rpcError(null, reason === "request_too_large" ? -32001 : -32700, reason === "request_too_large" ? "Request too large" : "Parse error", reason === "request_too_large" ? 413 : 400);
  }

  const version = protocolVersion(request, rpc);
  const method = normalize(rpc.method);
  if (rpc.jsonrpc !== "2.0" || !method) return rpcError(rpc.id, -32600, "Invalid Request", 400, undefined, version);
  if (PUBLIC_DISCOVERY_NOTIFICATIONS.has(method)) return new Response(null, { status: 202, headers: { "Cache-Control": "no-store", "MCP-Protocol-Version": version } });
  if (PUBLIC_DISCOVERY_METHODS.has(method)) {
    if (method === "initialize") {
      return rpcResult(rpc.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "MARE Product Media OS", version: SERVER_VERSION },
        instructions: "Controlled Shopify product-image operations. Discovery is public; every tool call requires the isolated Product Media token. The agent must create and visually review a preview before publishing. Existing Shopify media is never deleted.",
      }, version);
    }
    if (method === "ping") return rpcResult(rpc.id, {}, version);
    return rpcResult(rpc.id, { tools: TOOLS }, version);
  }
  if (!isAuthorized(request, env)) {
    audit("request_denied", { requestId, success: false, reason: "unauthorized_non_discovery_method" });
    return authError();
  }
  if (method === "tools/call") {
    const params = asObject(rpc.params);
    const name = normalize(params.name);
    const args = asObject(params.arguments);
    if (!name) return rpcError(rpc.id, -32602, "Missing tool name", 200, undefined, version);
    try {
      const result = await callTool(name, args, env);
      audit("tool_call", { requestId, tool: name, success: result.isError !== true });
      return rpcResult(rpc.id, result, version);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "tool_execution_failed";
      audit("tool_call", { requestId, tool: name, success: false, reason });
      return rpcResult(rpc.id, toolFailure(reason), version);
    }
  }
  return rpcError(rpc.id, -32601, "Method not found", 200, { method }, version);
}
