import assert from "node:assert/strict";
import { build } from "esbuild";

const bundled = await build({ entryPoints: ["src/amazon-readonly-handler.ts"],
  bundle: true, platform: "neutral", format: "esm", write: false, logLevel: "silent" });
const { handleAmazonReadonlyRequest } = await import("data:text/javascript;base64," +
  Buffer.from(bundled.outputFiles[0].text).toString("base64"));
const originalFetch = globalThis.fetch;
const env = {
  DAILY_PULSE_ACCESS_TOKEN: "admin",
  SHOPIFY_SHOP_DOMAIN: "test-store.myshopify.com",
  SHOPIFY_ADMIN_ACCESS_TOKEN: "test-shopify-admin-token"
};
const base = "https://worker.example/internal/amazon/shopify-eligible-page";
let calls = 0;
try {
  globalThis.fetch = async (url, init) => {
    calls++;
    assert(String(url).startsWith("https://test-store.myshopify.com/admin/api/"));
    assert.equal(init.method, "POST");
    assert.equal(init.headers["X-Shopify-Access-Token"], "test-shopify-admin-token");
    const body = JSON.parse(init.body);
    if (body.query.includes("AmazonShopifyExtraVariants")) {
      assert.equal(body.variables.id, "gid://shopify/Product/1");
      assert.equal(body.variables.after, "VARCUR1");
      return new Response(JSON.stringify({ data: {
        product: { variants: { pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ id: "gid://shopify/ProductVariant/12", sku: "SECOND", inventoryQuantity: 4, barcode: "0001234567890" }] } }
      } }), { status: 200 });
    }
    assert(body.query.includes("AmazonShopifyEligiblePage"));
    assert.equal(body.variables.after, null);
    return new Response(JSON.stringify({ data: {
      products: { pageInfo: { hasNextPage: true, endCursor: "PAGE2" }, nodes: [
        { id: "gid://shopify/Product/1", status: "ACTIVE", vendor: "Nike", productType: "Sneakers",
          variants: { pageInfo: { hasNextPage: true, endCursor: "VARCUR1" }, nodes: [
            { id: "gid://shopify/ProductVariant/10", sku: "EXACT-0001", barcode: "1234567890123", inventoryQuantity: 2 },
            { id: "gid://shopify/ProductVariant/11", sku: "OUT", inventoryQuantity: 0 }
          ] } },
        { id: "gid://shopify/Product/2", status: "ACTIVE", vendor: "P448", productType: "Sneakers",
          variants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
            { id: "gid://shopify/ProductVariant/20", sku: "P448", inventoryQuantity: 20 }
          ] } },
        { id: "gid://shopify/Product/3", status: "ACTIVE", vendor: "K-Way", productType: "Giubbotti",
          variants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
            { id: "gid://shopify/ProductVariant/30", sku: "", inventoryQuantity: 5 }
          ] } }
      ] }
    } }), { status: 200 });
  };
  const denied = await handleAmazonReadonlyRequest(new Request(base), env);
  assert.equal(denied.status, 401);
  assert.equal(calls, 0);
  const wrongMethod = await handleAmazonReadonlyRequest(new Request(base, { method: "POST" }), env);
  assert.equal(wrongMethod.status, 405);
  assert.equal(calls, 0);
  const headers = { Authorization: "Bearer admin" };
  const invalid = await handleAmazonReadonlyRequest(new Request(base + "?after=bad%20value", { headers }), env);
  assert.equal(invalid.status, 502);
  assert.equal((await invalid.json()).error, "amazon_shopify_cursor_invalid");
  assert.equal(calls, 0);
  const response = await handleAmazonReadonlyRequest(new Request(base, { headers }), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.read_only, true);
  assert.equal(data.source, "shopify_live");
  assert.equal(data.products_scanned, 3);
  assert.equal(data.variants_scanned, 5);
  assert.equal(data.eligible_count, 2);
  assert.deepEqual(data.eligible_variants.map(row => row.sku), ["EXACT-0001", "SECOND"]);
  assert.equal(data.eligible_variants[0].barcode, "1234567890123");
  assert.equal(data.has_more, true);
  assert.equal(data.next_cursor, "PAGE2");
  assert.deepEqual(data.excluded, { p448: 1, not_active: 0, no_stock: 1, blank_sku: 1 });
  assert.equal(calls, 2);
  assert(!JSON.stringify(data).includes("test-shopify-admin-token"));
  console.log("Amazon Shopify eligible-SKU read-only page tests passed");
} finally { globalThis.fetch = originalFetch; }
