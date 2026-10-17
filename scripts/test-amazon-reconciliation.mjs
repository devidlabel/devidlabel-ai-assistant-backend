import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/amazon-shopify-reconciliation.ts"],
  bundle: true, platform: "neutral", format: "esm", write: false, logLevel: "silent"
});
const { reconcileShopifyAmazon } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const products = [
  { id: "sneaker1", status: "ACTIVE", vendor: "Nike", product_type: "Sneakers",
    variants: [{ id: "v1", sku: "SN-001", inventory_quantity: 2 }, { id: "v2", sku: "SN-002", inventory_quantity: 0 }] },
  { id: "p448", status: "ACTIVE", vendor: "P448",
    variants: [{ sku: "P448-1", inventory_quantity: 10 }] },
  { id: "draft", status: "DRAFT", vendor: "New Balance",
    variants: [{ sku: "DRAFT-1", inventory_quantity: 5 }] },
  { id: "no-sku", status: "ACTIVE", vendor: "Nike",
    variants: [{ sku: "", inventory_quantity: 3 }] },
  { id: "case-sensitive", status: "ACTIVE", vendor: "Nike",
    variants: [{ sku: "sn-001", inventory_quantity: 1 }] },
  { id: "duplicate-a", status: "ACTIVE", vendor: "Nike",
    variants: [{ sku: "DUP-1", inventory_quantity: 1 }] },
  { id: "duplicate-b", status: "ACTIVE", vendor: "Nike",
    variants: [{ sku: "DUP-1", inventory_quantity: 1 }] }
];
const snapshots = {
  IT: { marketplace: "IT", complete: true, rows: [{ sellerSku: "SN-001", status: "Active" }] },
  DE: { marketplace: "DE", complete: true, rows: [{ sellerSku: "SN-001", status: "Inactive" }] },
  FR: { marketplace: "FR", complete: false, rows: [] }
};
const inputBefore = JSON.stringify({ products, snapshots });
const result = reconcileShopifyAmazon(products, snapshots);
assert.equal(result.readOnly, true);
assert.equal(result.eligibleVariants, 4);
assert.deepEqual(result.excluded, { notActive: 1, p448: 1, noStock: 1, blankSku: 1 });
const primary = result.entries.find(row => row.sku === "SN-001");
assert.equal(primary.perMarket.IT, "PRESENT_ACTIVE");
assert.equal(primary.perMarket.DE, "PRESENT_INACTIVE");
assert.equal(primary.perMarket.FR, "UNVERIFIED");
assert.equal(primary.perMarket.ES, "UNVERIFIED");
const differentCase = result.entries.find(row => row.sku === "sn-001");
assert.equal(differentCase.perMarket.IT, "NOT_FOUND_IN_COMPLETE_SNAPSHOT");
assert.equal(differentCase.perMarket.FR, "UNVERIFIED");
assert.equal(result.entries.filter(row => row.sku === "DUP-1").length, 2);
assert(result.entries.filter(row => row.sku === "DUP-1").every(row => row.perMarket.IT === "AMBIGUOUS_SHOPIFY_SKU"));
assert.equal(JSON.stringify({ products, snapshots }), inputBefore, "input data must not be mutated");
assert.throws(() => reconcileShopifyAmazon(products, { IT: { marketplace: "DE", complete: true, rows: [] } }), /marketplace_mismatch/);
console.log("Shopify to Amazon safe reconciliation tests passed");
