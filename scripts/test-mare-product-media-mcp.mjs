import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const mcpSource = readFileSync("src/mare-product-media-mcp.ts", "utf8");
const imageSource = readFileSync("src/mare-product-media-image.ts", "utf8");
const shopifySource = readFileSync("src/mare-product-media-shopify.ts", "utf8");
const workerSource = readFileSync("src/worker-v3.ts", "utf8");
const wranglerSource = readFileSync("wrangler.toml", "utf8");

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
  'operations_token_fallback: false',
  'commerce_token_fallback: false',
  'delete_tool_exposed: false',
  'preview_required_before_publish: true',
]) assert.ok(mcpSource.includes(fragment), `Missing Product Media contract fragment: ${fragment}`);

for (const fragment of [
  'gpt-image-2',
  'const OUTPUT_WIDTH = 600',
  'const OUTPUT_HEIGHT = 771',
  'fit: "pad"',
  'background: "#FFFFFF"',
  'output({ format: "image/jpeg", quality: 92 })',
  'visual_fidelity_review_required: true',
  'automatic_product_publish: false',
]) assert.ok(imageSource.includes(fragment), `Missing image pipeline guard: ${fragment}`);

for (const fragment of [
  'required_scopes: ["read_products", "write_products"]',
  'resource: "PRODUCT_IMAGE"',
  'originals_deleted: false',
  'productReorderMedia',
  'PUBLISH PRODUCT IMAGE TO SHOPIFY',
]) assert.ok(shopifySource.includes(fragment), `Missing Shopify media guard: ${fragment}`);

for (const fragment of [
  'handleMareProductMediaMcpRequest',
  '"write_products"',
  'MARE_PRODUCT_MEDIA_ACCESS_TOKEN',
]) assert.ok(workerSource.includes(fragment), `Missing Worker integration fragment: ${fragment}`);

for (const fragment of [
  '[images]',
  'binding = "IMAGES"',
  'PRODUCT_IMAGE_MODEL = "gpt-image-2"',
]) assert.ok(wranglerSource.includes(fragment), `Missing Cloudflare image configuration fragment: ${fragment}`);

for (const forbidden of [
  "productDeleteMedia",
  "fileDelete",
  "productDelete",
  "DELETE PRODUCT IMAGE",
  "MARE_OPS_ACCESS_TOKEN) ||",
  "MARE_MCP_ACCESS_TOKEN) ||",
]) {
  assert.equal(
    [mcpSource, imageSource, shopifySource].some((source) => source.includes(forbidden)),
    false,
    `Forbidden capability or credential fallback exposed: ${forbidden}`,
  );
}

assert.equal(
  (mcpSource.match(/name: "mare_[a-z0-9_]+"/g) || []).length,
  6,
  "Product Media MCP must expose exactly six tools",
);
assert.equal(
  (mcpSource.match(/annotations: CONTROLLED_WRITE_ANNOTATIONS/g) || []).length,
  2,
  "Product Media MCP must expose exactly two controlled write tools",
);

console.log(JSON.stringify({
  ok: true,
  contract: "mare_product_media_os_foundation",
  tools: 6,
  controlled_write_tools: 2,
  exact_preview_confirmation_required: true,
  exact_publish_confirmation_required: true,
  canvas: "600x771",
  background: "#FFFFFF",
  original_media_deletion_exposed: false,
  isolated_access_token_required: true,
  project_typecheck_owns_runtime_compilation: true,
}));
