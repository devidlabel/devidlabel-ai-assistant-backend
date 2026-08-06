import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mcpSource = readFileSync("src/mare-product-media-mcp.ts", "utf8");
const imageSource = readFileSync("src/mare-product-media-image.ts", "utf8");
const shopifySource = readFileSync("src/mare-product-media-shopify.ts", "utf8");

for (const fragment of [
  'name: "mare_product_media_health"',
  'name: "mare_shopify_find_product_media"',
  'name: "mare_shopify_get_product_image"',
  'name: "mare_product_image_generate_preview"',
  'name: "mare_product_image_get_preview"',
  'name: "mare_product_image_publish"',
  'GENERATE PRODUCT IMAGE PREVIEW',
  'PUBLISH PRODUCT IMAGE TO SHOPIFY',
  'MARE_PRODUCT_MEDIA_ACCESS_TOKEN',
]) assert.ok(mcpSource.includes(fragment), `Missing Product Media contract fragment: ${fragment}`);

for (const fragment of [
  'gpt-image-2',
  'width: OUTPUT_WIDTH',
  'height: OUTPUT_HEIGHT',
  'fit: "pad"',
  'background: "#FFFFFF"',
  'visual_fidelity_review_required: true',
]) assert.ok(imageSource.includes(fragment), `Missing image pipeline guard: ${fragment}`);

for (const fragment of [
  'required_scopes: ["read_products", "write_products"]',
  'resource: "PRODUCT_IMAGE"',
  'originals_deleted: false',
  'productReorderMedia',
]) assert.ok(shopifySource.includes(fragment), `Missing Shopify media guard: ${fragment}`);

for (const forbidden of ["productDeleteMedia", "fileDelete", "productDelete", "DELETE PRODUCT IMAGE"]) {
  assert.equal([mcpSource, imageSource, shopifySource].some((source) => source.includes(forbidden)), false, `Forbidden deletion capability exposed: ${forbidden}`);
}

const out = mkdtempSync(join(tmpdir(), "mare-product-media-mcp-"));
execFileSync("npx", [
  "tsc",
  "--outDir", out,
  "--noEmit", "false",
  "--module", "ESNext",
  "--target", "ES2022",
  "--moduleResolution", "Bundler",
  "--lib", "ES2022,WebWorker",
  "src/mare-product-media-mcp.ts",
], { stdio: "inherit" });

const { handleMareProductMediaMcpRequest } = await import(`file://${join(out, "mare-product-media-mcp.js")}`);

const kv = new Map();
const env = {
  MARE_PRODUCT_MEDIA_ACCESS_TOKEN: "product-media-secret",
  SHOPIFY_SHOP_DOMAIN: "devidlabel.myshopify.com",
  SHOPIFY_TOKENS_KV: {
    async get(key) { return kv.get(key) ?? null; },
    async put(key, value) { kv.set(key, value); },
    async delete(key) { kv.delete(key); },
  },
  OPENAI_API_KEY: "openai-secret",
  PRODUCT_IMAGE_MODEL: "gpt-image-2",
  IMAGES: {
    input() {
      return {
        transform() { return this; },
        output() { return this; },
        async response() { return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/jpeg" } }); },
      };
    },
  },
};

await env.SHOPIFY_TOKENS_KV.put(
  "shopify:offline_token:devidlabel.myshopify.com",
  JSON.stringify({ scope: "read_products,write_products", encrypted_access_token: "encrypted", iv: "iv", shop: "devidlabel.myshopify.com", created_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
);

const endpoint = "https://worker.test/mcp-product-media";
function rpc(method, params = {}, id = 1) { return JSON.stringify({ jsonrpc: "2.0", id, method, params }); }
function request(body, token = "", headers = {}) {
  return new Request(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body,
  });
}

const health = await handleMareProductMediaMcpRequest(new Request(`${endpoint}/health`), env);
assert.equal(health?.status, 200);
const healthBody = await health.json();
assert.equal(healthBody.service, "mare_product_media_os_mcp");
assert.equal(healthBody.version, "0.1.0");
assert.equal(healthBody.tools.length, 6);
assert.equal(healthBody.shopify.read_products_granted, true);
assert.equal(healthBody.shopify.write_products_granted, true);
assert.equal(healthBody.safety.originals_deleted, false);
assert.equal(JSON.stringify(healthBody).includes("product-media-secret"), false);
assert.equal(JSON.stringify(healthBody).includes("openai-secret"), false);

const listed = await handleMareProductMediaMcpRequest(request(rpc("tools/list")), env);
const listedBody = await listed.json();
assert.deepEqual(listedBody.result.tools.map((tool) => tool.name), [
  "mare_product_media_health",
  "mare_shopify_find_product_media",
  "mare_shopify_get_product_image",
  "mare_product_image_generate_preview",
  "mare_product_image_get_preview",
  "mare_product_image_publish",
]);
assert.equal(listedBody.result.tools.filter((tool) => tool.annotations.readOnlyHint === false).length, 2);

const denied = await handleMareProductMediaMcpRequest(
  request(rpc("tools/call", { name: "mare_product_media_health", arguments: {} })),
  env,
);
assert.equal(denied?.status, 401);

const authenticatedHealth = await handleMareProductMediaMcpRequest(
  request(rpc("tools/call", { name: "mare_product_media_health", arguments: {} }), "product-media-secret"),
  env,
);
const authenticatedHealthBody = await authenticatedHealth.json();
assert.equal(authenticatedHealthBody.result.isError, false);
assert.equal(authenticatedHealthBody.result.structuredContent.safety.delete_tool_exposed, false);

const missingPreviewConfirmation = await handleMareProductMediaMcpRequest(
  request(rpc("tools/call", {
    name: "mare_product_image_generate_preview",
    arguments: {
      approval_confirmation: "wrong",
      idempotency_key: "puraai-test-001",
      product_id: "gid://shopify/Product/123",
      media_id: "gid://shopify/MediaImage/456",
    },
  }), "product-media-secret"),
  env,
);
const missingPreviewConfirmationBody = await missingPreviewConfirmation.json();
assert.equal(missingPreviewConfirmationBody.result.isError, true);
assert.match(missingPreviewConfirmationBody.result.content[0].text, /preview_generation_confirmation_required/);

const wrongOrigin = await handleMareProductMediaMcpRequest(
  request(rpc("ping"), "", { Origin: "https://example.com" }),
  env,
);
assert.equal(wrongOrigin?.status, 403);

console.log(JSON.stringify({
  ok: true,
  contract: "mare_product_media_os_foundation",
  tools: 6,
  controlled_write_tools: 2,
  exact_preview_confirmation_required: true,
  exact_publish_confirmation_required: true,
  original_media_deletion_exposed: false,
  secret_values_exposed: false,
}));
