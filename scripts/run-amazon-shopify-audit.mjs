import fs from "node:fs";
import { auditShopifyAgainstAmazon } from "./amazon-shopify-live-audit.mjs";
import { buildPrivateShopifyAmazonManifest, validatePrivateManifestOutput,
  writePrivateShopifyAmazonManifest } from "./amazon-shopify-private-manifest.mjs";

const bearer = process.env.DAILY_PULSE_ACCESS_TOKEN || "";
// Opt-in, local private destination only. Never add this file to the public repository.
const manifestOutput = process.env.AMAZON_SHOPIFY_PRIVATE_MANIFEST_OUTPUT || "";
if (manifestOutput) validatePrivateManifestOutput(manifestOutput);
let snapshot = null;
const report = await auditShopifyAgainstAmazon({
  bearer,
  ...(manifestOutput ? { onPrivateSnapshot: value => { snapshot = value; } } : {})
});
// The public receipt remains aggregate-only; no SKU, product identifiers,
// signed URLs, API response bodies or credentials are added to this file.
fs.writeFileSync("/tmp/amazon-shopify-audit-receipt.json", JSON.stringify(report, null, 2) + "\n");
if (manifestOutput) {
  const manifest = buildPrivateShopifyAmazonManifest(snapshot, report);
  writePrivateShopifyAmazonManifest(manifestOutput, manifest);
  snapshot = null;
}
console.log(JSON.stringify({
  generated_at: report.generated_at, complete: report.complete,
  shopify: report.shopify, amazon: report.amazon,
  markets: report.results?.markets || null,
  product_categories: report.results?.by_category?.length || 0,
  vendors: report.results?.by_vendor?.length || 0,
  vendor_category_groups: report.results?.by_vendor_category?.length || 0,
  ...(manifestOutput ? { private_manifest_written: true } : {})
}, null, 2));

