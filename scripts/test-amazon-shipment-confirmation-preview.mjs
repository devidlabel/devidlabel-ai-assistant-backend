import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: ["src/marketplace-amazon-shipment-confirmation-preview.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
  logLevel: "silent",
});
const mod = await import("data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const {
  previewAmazonShipmentConfirmation: preview,
  validateAmazonShipmentConfirmationPreviewRequest: validateRequest,
} = mod;

const request = {
  marketplace: "IT",
  shopify_order_gid: "gid://shopify/Order/123456",
  amazon_order_id: "171-1234567-1234567",
};
const fixed = Date.parse("2026-10-19T10:35:00Z");

function shopifySource(overrides = {}) {
  return {
    order_gid: request.shopify_order_gid,
    amazon_order_id: request.amazon_order_id,
    fulfillments: [{
      fulfillment_gid: "gid://shopify/Fulfillment/999",
      status: "SUCCESS",
      created_at: "2026-10-19T10:30:00Z",
      tracking: [{ company: "UPS", number: "PRIVATE_TRACKING_123" }],
      lines: [{
        line_item_gid: "gid://shopify/LineItem/555",
        sku: "SKU_ORDER_1",
        quantity: 1,
      }],
    }],
    ...overrides,
  };
}
function amazonObservation(overrides = {}) {
  return {
    ok: true,
    source: "amazon_spapi_order_packages_2026_01_01",
    identity_scope: "SELLER_ACCOUNT_PLUS_ORDER_ID",
    account_id: "A123456789",
    order_id: request.amazon_order_id,
    order_key: "amazon:A123456789:" + request.amazon_order_id,
    marketplace: "IT",
    marketplace_id: "APJ6JRA9NG5V4",
    created_at: "2026-10-19T09:00:00Z",
    last_updated_at: "2026-10-19T10:00:00Z",
    observed_at: "2026-10-19T10:34:00Z",
    fulfillment_owner: "MERCHANT",
    fulfillment_status: "UNSHIPPED",
    items: [{
      line_id: "79039765272157",
      seller_sku: "SKU_ORDER_1",
      quantity_ordered: 1,
      quantity_fulfilled: 0,
      quantity_unfulfilled: 1,
    }],
    packages: [],
    read_only: true,
    provider_mutations: 0,
    buyer_recipient_datasets_requested: false,
    customer_fields_returned: false,
    private_tracking_transient_only: true,
    can_confirm_shipment: false,
    can_change_inventory: false,
    can_advance_checkpoint: false,
    ...overrides,
  };
}

const env = {
  AMAZON_SHIPMENT_CARRIER_MAP_JSON: JSON.stringify({
    UPS: { carrier_code: "UPS", shipping_method: "Standard" },
  }),
};

const ready = await preview(request, env, {
  clock: () => fixed,
  readShopify: async () => shopifySource(),
  readAmazonPackages: async () => amazonObservation(),
});
assert.equal(ready.ok, true);
assert.equal(ready.status, "PREVIEW_READY_FOR_LIVE_PLAN_DESIGN");
assert.equal(ready.package_count, 1);
assert.equal(ready.blocker_count, 0);
assert.equal(ready.provider_request_performed, false);
assert.equal(ready.provider_mutations, 0);
assert.equal(ready.preview_only, true);
assert.equal(ready.can_confirm_shipment, false);
assert.equal(ready.live_writer_implemented, false);
assert.equal(ready.packages[0].carrier_code, "UPS");
assert.equal(ready.packages[0].tracking_number_present, true);
assert.equal(ready.packages[0].order_item_count, 1);
assert.equal(ready.packages[0].unit_count, 1);
assert.equal(JSON.stringify(ready).includes("PRIVATE_TRACKING_123"), false);

// The preview's allowed BRT label aliases come from the deployed (non-secret)
// Worker configuration, never from caller-provided carrier assertions.
const wrangler = readFileSync("wrangler.toml", "utf8");
const carrierConfig = wrangler.match(/^AMAZON_SHIPMENT_CARRIER_MAP_JSON = '(.+)'$/m);
assert.ok(carrierConfig, "BRT preview mapping must be declared in wrangler.toml");
const configuredCarriers = JSON.parse(carrierConfig[1]);
assert.equal(configuredCarriers.brt.carrier_code, "BRT");
assert.equal(configuredCarriers.BRT.carrier_code, "BRT");
const brtEnv = { AMAZON_SHIPMENT_CARRIER_MAP_JSON: carrierConfig[1] };
const brtShopify = shopifySource();
brtShopify.fulfillments[0].tracking[0].company = "brt";
const brtReady = await preview(request, brtEnv, {
  clock: () => fixed,
  readShopify: async () => brtShopify,
  readAmazonPackages: async () => amazonObservation(),
});
assert.equal(brtReady.status, "PREVIEW_READY_FOR_LIVE_PLAN_DESIGN");
assert.equal(brtReady.packages[0].carrier_code, "BRT");
assert.equal(brtReady.provider_mutations, 0);
assert.equal(brtReady.preview_only, true);
assert.equal(brtReady.can_confirm_shipment, false);
assert.equal(JSON.stringify(brtReady).includes("PRIVATE_TRACKING_123"), false);

const brtAlreadyRegistered = await preview(request, brtEnv, {
  clock: () => fixed,
  readShopify: async () => brtShopify,
  readAmazonPackages: async () => amazonObservation({
    fulfillment_status: "SHIPPED",
    packages: [{
      package_reference_id: "1",
      carrier: "BRT",
      tracking_number: "EXISTING_PRIVATE_TRACKING",
      ship_time: "2026-10-19T10:32:00Z",
      package_status: "SHIPPED",
      items: [{ line_id: "79039765272157", quantity: 1 }],
    }],
  }),
});
assert.equal(brtAlreadyRegistered.status, "PREVIEW_REVIEW_REQUIRED");
assert.ok(brtAlreadyRegistered.blockers.includes("amazon_packages_already_registered"));
assert.equal(brtAlreadyRegistered.provider_mutations, 0);
assert.equal(JSON.stringify(brtAlreadyRegistered).includes("EXISTING_PRIVATE_TRACKING"), false);

const noFulfillments = await preview(request, env, {
  clock: () => fixed,
  readShopify: async () => { throw new Error("amazon_shipment_preview_fulfillments_unavailable"); },
  readAmazonPackages: async () => { throw new Error("must not read Amazon after Shopify blocker"); },
});
assert.equal(noFulfillments.status, "BLOCKED_PREVIEW");
assert.equal(noFulfillments.reason, "shopify_fulfillments_unavailable");
assert.equal(noFulfillments.provider_request_performed, false);
assert.equal(noFulfillments.provider_mutations, 0);

const noCarrierMap = await preview(request, {}, {
  clock: () => fixed,
  readShopify: async () => shopifySource(),
  readAmazonPackages: async () => amazonObservation(),
});
assert.equal(noCarrierMap.status, "PREVIEW_REVIEW_REQUIRED");
assert.ok(noCarrierMap.blockers.includes("carrier_code_mapping_not_verified"));
assert.equal(noCarrierMap.provider_mutations, 0);

const alreadyRegistered = await preview(request, env, {
  clock: () => fixed,
  readShopify: async () => shopifySource(),
  readAmazonPackages: async () => amazonObservation({
    packages: [{
      package_reference_id: "1",
      carrier: "UPS",
      tracking_number: "EXISTING_PRIVATE_TRACKING",
      ship_time: "2026-10-19T10:20:00Z",
      package_status: "SHIPPED",
      items: [{ line_id: "79039765272157", quantity: 1 }],
    }],
  }),
});
assert.equal(alreadyRegistered.status, "PREVIEW_REVIEW_REQUIRED");
assert.ok(alreadyRegistered.blockers.includes("amazon_packages_already_registered"));
assert.equal(JSON.stringify(alreadyRegistered).includes("EXISTING_PRIVATE_TRACKING"), false);

const duplicateSku = await preview(request, env, {
  clock: () => fixed,
  readShopify: async () => shopifySource(),
  readAmazonPackages: async () => amazonObservation({
    items: [
      {
        line_id: "79039765272157",
        seller_sku: "SKU_ORDER_1",
        quantity_ordered: 1,
        quantity_fulfilled: 0,
        quantity_unfulfilled: 1,
      },
      {
        line_id: "79039765272158",
        seller_sku: "SKU_ORDER_1",
        quantity_ordered: 1,
        quantity_fulfilled: 0,
        quantity_unfulfilled: 1,
      },
    ],
  }),
});
assert.equal(duplicateSku.status, "PREVIEW_REVIEW_REQUIRED");
assert.ok(duplicateSku.blockers.includes("duplicate_amazon_sku_requires_line_mapping"));

assert.deepEqual(validateRequest(request), request);
assert.throws(() => validateRequest({ ...request, marketplace: "US" }), /invalid_request/);
assert.throws(() => validateRequest({ ...request, extra: true }), /invalid_request/);

console.log("Amazon shipment confirmation preview tests passed.");
