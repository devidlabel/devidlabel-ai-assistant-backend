import assert from "node:assert/strict";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: ["src/mare-business-amazon-stock-sync.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
  logLevel: "silent",
});
const mod = await import("data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const { prepareAmazonExistingOfferStockSync: prepare, executeAmazonExistingOfferStockSync: execute } = mod;

const request = {
  marketplace: "IT",
  sku: "SYNTHETIC_REPLAY_31",
  asin: "B0TEST0001",
  writer_isolation: "CHANNABLE_DISABLED_FOR_SKU",
};
const env = {
  AMAZON_SP_API_CLIENT_ID: "synthetic-client",
  AMAZON_SP_API_CLIENT_SECRET: "synthetic-secret",
  AMAZON_SP_API_REFRESH_TOKEN: "synthetic-refresh",
  AMAZON_SP_API_SELLER_ID: "A123456789",
  SHOPIFY_SHOP_DOMAIN: "synthetic.myshopify.com",
};
const fixedTime = Date.parse("2026-10-18T20:00:00.000Z");
const catalog = quantity => ({
  ok: true,
  truncated: false,
  complete_variant_pagination: true,
  products: [{
    status: "ACTIVE",
    variants: [{
      id: "gid://shopify/ProductVariant/123",
      sku: request.sku,
      inventory_tracked: true,
      inventory_levels_complete: true,
      inventory_quantity: quantity,
      inventory_levels: [{
        quantities: [
          { name: "available", quantity },
          { name: "committed", quantity: 1 },
          { name: "on_hand", quantity: quantity + 1 },
        ],
      }],
    }],
  }],
});
const amazon = quantity => ({
  ok: true,
  marketplace: "IT",
  observation_complete: true,
  provider_mutations: 0,
  can_change_stock: false,
  results: [{
    sku: request.sku,
    state: "PRESENT",
    identity_state: "VERIFIED",
    asin: request.asin,
    fulfillment_state: "VERIFIED",
    current_fbm_quantity: quantity,
    product_type: "PANTS",
  }],
});

let shopifyQuantity = 1;
let amazonQuantity = 2;
let reads = 0;
let writes = 0;
const deps = {
  clock: () => fixedTime,
  readShopifyCatalog: async args => {
    assert.equal(args.query, "sku:" + request.sku);
    assert.equal(args.include_csv, false);
    return catalog(shopifyQuantity);
  },
  readAmazonListing: async args => {
    assert.deepEqual(args, { marketplace: "IT", skus: [request.sku] });
    reads++;
    if (writes > 0 && reads >= 3) return amazon(shopifyQuantity);
    return amazon(amazonQuantity);
  },
  getAccessToken: async () => "synthetic-access-token",
  sleep: async () => {},
  fetch: async (url, init) => {
    writes++;
    const u = new URL(String(url));
    assert.equal(u.pathname, "/listings/2021-08-01/items/A123456789/" + request.sku);
    assert.equal(u.searchParams.get("marketplaceIds"), "APJ6JRA9NG5V4");
    assert.equal(init.method, "PATCH");
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers["x-amz-access-token"], "synthetic-access-token");
    assert.deepEqual(JSON.parse(init.body), {
      productType: "PANTS",
      patches: [{
        op: "replace",
        path: "/attributes/fulfillment_availability",
        value: [{
          fulfillment_channel_code: "DEFAULT",
          quantity: 1,
          marketplace_id: "APJ6JRA9NG5V4",
        }],
      }],
    });
    return new Response(JSON.stringify({
      sku: request.sku,
      status: "ACCEPTED",
      submissionId: "SYNTHETIC_SUBMISSION_1",
      issues: [],
    }), { status: 200, headers: { "content-type": "application/json" } });
  },
};

for (const bad of [
  { ...request, writer_isolation: "CHANNABLE_ACTIVE" },
  { ...request, marketplace: "US" },
  { ...request, sku: "../bad" },
  { ...request, asin: "bad" },
  { ...request, target_quantity: 0 },
]) {
  await assert.rejects(() => prepare(bad, env, deps), /amazon_stock_sync_invalid_request/);
}

const prepared = await prepare(request, env, deps);
assert.equal(prepared.summary.target_quantity, 1);
assert.equal(prepared.summary.amazon_current_quantity, 2);
assert.equal(prepared.summary.committed_quantity, 1);
assert.equal(prepared.summary.delta, -1);
assert.equal(prepared.summary.provider_mutations, 0);
assert.equal(prepared.prepared_request.shopify_available_quantity, 1);
assert.equal(prepared.prepared_request.amazon_current_quantity, 2);
assert.equal(prepared.prepared_request.amazon_product_type, "PANTS");

const updated = await execute(prepared.prepared_request, env, deps);
assert.equal(updated.status, "UPDATED_AND_VERIFIED");
assert.equal(updated.previous_quantity, 2);
assert.equal(updated.verified_quantity, 1);
assert.equal(updated.provider_mutations, 1);
assert.equal(updated.readback_verified, true);
assert.equal(writes, 1);

reads = 0;
writes = 0;
shopifyQuantity = 2;
amazonQuantity = 2;
const noopPrepared = await prepare(request, env, deps);
const noop = await execute(noopPrepared.prepared_request, env, deps);
assert.equal(noop.status, "NO_CHANGE_REQUIRED");
assert.equal(noop.provider_mutations, 0);
assert.equal(noop.verified_quantity, 2);
assert.equal(writes, 0);

reads = 0;
writes = 0;
shopifyQuantity = 1;
amazonQuantity = 2;
const raced = await prepare(request, env, deps);
shopifyQuantity = 0;
await assert.rejects(() => execute(raced.prepared_request, env, deps), /shopify_inventory_changed_since_prepare/);
assert.equal(writes, 0);

// A successful transport response is not proof of acceptance or application.
// Every failure below must stop after one PATCH, without retrying the write.
shopifyQuantity = 1;
amazonQuantity = 2;
const accepted = {
  sku: request.sku,
  status: "ACCEPTED",
  submissionId: "SYNTHETIC_SUBMISSION_1",
  issues: [],
};
for (const [httpStatus, body, error] of [
  [202, accepted, /amazon_stock_write_http_202/],
  [429, {}, /amazon_stock_write_http_429/],
  [500, {}, /amazon_stock_write_http_500/],
  [200, { ...accepted, status: "INVALID" }, /amazon_stock_write_not_accepted/],
  [200, { ...accepted, sku: "OTHER_SKU" }, /amazon_stock_write_not_accepted/],
  [200, { ...accepted, submissionId: null }, /amazon_stock_write_not_accepted/],
]) {
  let patches = 0;
  let observations = 0;
  const failureDeps = {
    ...deps,
    readAmazonListing: async () => { observations++; return amazon(2); },
    fetch: async () => {
      patches++;
      return new Response(JSON.stringify(body), { status: httpStatus });
    },
  };
  const plan = await prepare(request, env, failureDeps);
  await assert.rejects(() => execute(plan.prepared_request, env, failureDeps), error);
  assert.equal(patches, 1);
  assert.equal(observations, 2); // prepare + execute freshness check only
}

// Even HTTP 200 + ACCEPTED cannot succeed when the provider never confirms
// the target quantity; bounded GETs must not become mutation retries.
let unconfirmedPatches = 0;
let unconfirmedReads = 0;
const unconfirmedDeps = {
  ...deps,
  readAmazonListing: async () => { unconfirmedReads++; return amazon(2); },
  fetch: async () => {
    unconfirmedPatches++;
    return new Response(JSON.stringify(accepted), { status: 200 });
  },
};
const unconfirmed = await prepare(request, env, unconfirmedDeps);
await assert.rejects(
  () => execute(unconfirmed.prepared_request, env, unconfirmedDeps),
  /amazon_stock_write_readback_unconfirmed/,
);
assert.equal(unconfirmedPatches, 1);
assert.equal(unconfirmedReads, 7); // prepare + freshness check + five readbacks

console.log("Amazon stock sync pilot tests passed.");
