import assert from "node:assert/strict";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: ["src/marketplace-amazon-eu-inventory-shadow.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
  logLevel: "silent",
});
const mod = await import("data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const { readAmazonEuInventoryShadow: readShadow } = mod;

const skus = ["SKU_SHADOW_1", "SKU_SHADOW_2"];
const fixed = Date.parse("2026-10-19T10:30:00Z");
const shopify = {
  SKU_SHADOW_1: 2,
  SKU_SHADOW_2: 1,
};
const marketQuantities = {
  IT: { SKU_SHADOW_1: 2, SKU_SHADOW_2: 1 },
  DE: { SKU_SHADOW_1: 2, SKU_SHADOW_2: 1 },
  FR: { SKU_SHADOW_1: 2, SKU_SHADOW_2: 0 },
  ES: { SKU_SHADOW_1: 2, SKU_SHADOW_2: 1 },
};
const asins = { SKU_SHADOW_1: "B0SHADOW01", SKU_SHADOW_2: "B0SHADOW02" };

function catalog(sku, available) {
  return {
    ok: true,
    truncated: false,
    complete_variant_pagination: true,
    products: [{
      status: "ACTIVE",
      variants: [{
        id: "gid://shopify/ProductVariant/" + (sku.endsWith("1") ? "101" : "102"),
        sku,
        inventory_tracked: true,
        inventory_levels_complete: true,
        inventory_quantity: available,
        inventory_levels: [{
          quantities: [
            { name: "available", quantity: available },
            { name: "committed", quantity: 0 },
            { name: "on_hand", quantity: available },
          ],
        }],
      }],
    }],
  };
}
function amazon(market, requested) {
  return {
    ok: true,
    marketplace: market,
    provider_mutations: 0,
    can_change_stock: false,
    results: requested.map(sku => ({
      sku,
      state: "PRESENT",
      identity_state: "VERIFIED",
      asin: asins[sku],
      product_type: "PANTS",
      statuses: ["BUYABLE", "DISCOVERABLE"],
      fulfillment_state: "VERIFIED",
      current_fbm_quantity: marketQuantities[market][sku],
      price_state: "VERIFIED",
      current_b2c_price: { amount: sku.endsWith("1") ? "98.01" : "120.00", currency_code: "EUR" },
      observation_complete: true,
    })),
  };
}

const calls = { shopify: 0, amazon: 0 };
const result = await readShadow({ skus }, {}, {
  clock: () => fixed,
  readShopifyCatalog: async args => {
    calls.shopify++;
    const sku = args.query.slice(4);
    assert.equal(args.persist_artifacts, false);
    return catalog(sku, shopify[sku]);
  },
  readAmazonListing: async args => {
    calls.amazon++;
    assert.deepEqual(args.skus, skus);
    return amazon(args.marketplace, args.skus);
  },
});

assert.equal(result.ok, true);
assert.equal(result.read_only, true);
assert.equal(result.provider_mutations, 0);
assert.equal(result.requested_skus, 2);
assert.equal(calls.shopify, 2);
assert.equal(calls.amazon, 4);
assert.equal(result.results[0].all_four_market_quantities_verified, true);
assert.equal(result.results[0].all_verified_market_quantities_equal, true);
assert.equal(result.results[0].all_four_markets_match_shopify_available, true);
assert.deepEqual(result.results[0].unique_verified_asins, ["B0SHADOW01"]);
assert.equal(result.results[1].all_verified_market_quantities_equal, false);
assert.equal(result.results[1].all_four_markets_match_shopify_available, false);
assert.deepEqual(result.results[1].unique_verified_market_quantities, [1, 0]);
assert.equal(result.results[1].writer_ownership_proven, false);

function withDuplicateSkuProduct(sku, legacyQuantity, legacyStatus) {
  const current = catalog(sku, 2);
  const old = catalog(sku, legacyQuantity).products[0];
  old.status = legacyStatus;
  old.variants[0].id = "gid://shopify/ProductVariant/999";
  return { ...current, products: [...current.products, old] };
}

const legacyZeroStock = await readShadow({ skus: [skus[0]] }, {}, {
  clock: () => fixed,
  readShopifyCatalog: async () => withDuplicateSkuProduct(skus[0], 0, "UNLISTED"),
  readAmazonListing: async args => amazon(args.marketplace, args.skus),
});
assert.equal(legacyZeroStock.results[0].shopify.state, "VERIFIED");
assert.equal(legacyZeroStock.results[0].shopify.available, 2);
assert.equal(legacyZeroStock.results[0].shopify.inactive_duplicate_count, 1);
assert.equal(legacyZeroStock.results[0].shopify.source_unique_active_sku, true);
assert.equal(legacyZeroStock.results[0].all_four_markets_match_shopify_available, true);
assert.equal(legacyZeroStock.results[0].writer_ownership_proven, false);
assert.equal(legacyZeroStock.provider_mutations, 0);

const twoActiveProducts = await readShadow({ skus: [skus[0]] }, {}, {
  clock: () => fixed,
  readShopifyCatalog: async () => withDuplicateSkuProduct(skus[0], 2, "ACTIVE"),
  readAmazonListing: async args => amazon(args.marketplace, args.skus),
});
assert.equal(twoActiveProducts.results[0].shopify.state, "UNKNOWN");
assert.equal(twoActiveProducts.results[0].shopify.reason, "shopify_multiple_active_sku_matches");
assert.equal(twoActiveProducts.results[0].all_four_markets_match_shopify_available, false);

const inactiveWithStock = await readShadow({ skus: [skus[0]] }, {}, {
  clock: () => fixed,
  readShopifyCatalog: async () => withDuplicateSkuProduct(skus[0], 1, "UNLISTED"),
  readAmazonListing: async args => amazon(args.marketplace, args.skus),
});
assert.equal(inactiveWithStock.results[0].shopify.state, "UNKNOWN");
assert.equal(inactiveWithStock.results[0].shopify.reason, "shopify_inactive_sku_inventory_unverified");
assert.equal(inactiveWithStock.results[0].all_four_markets_match_shopify_available, false);

const partial = await readShadow({ skus: [skus[0]] }, {}, {
  clock: () => fixed,
  readShopifyCatalog: async () => catalog(skus[0], 2),
  readAmazonListing: async args => {
    if (args.marketplace === "FR") throw new Error("synthetic read failure");
    return amazon(args.marketplace, args.skus);
  },
});
assert.equal(partial.results[0].all_four_market_quantities_verified, false);
assert.equal(partial.results[0].amazon.FR.state, "UNKNOWN");

await assert.rejects(() => readShadow({ skus: [skus[0], skus[0]] }, {}, {}), /invalid_request/);
await assert.rejects(() => readShadow({ skus: ["../bad"] }, {}, {}), /invalid_request/);

console.log("Amazon EU inventory shadow tests passed.");
