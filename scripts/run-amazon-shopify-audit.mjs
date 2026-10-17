import fs from "node:fs";
import { auditShopifyAgainstAmazon } from "./amazon-shopify-live-audit.mjs";

const bearer = process.env.DAILY_PULSE_ACCESS_TOKEN || "";
const report = await auditShopifyAgainstAmazon({ bearer });
// Persist only aggregate counts and group summaries; never raw SKU, product
// identifiers, Amazon signed URLs, API response bodies or credentials.
fs.writeFileSync("/tmp/amazon-shopify-audit-receipt.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({
  generated_at: report.generated_at, complete: report.complete,
  shopify: report.shopify, amazon: report.amazon,
  markets: report.results?.markets || null,
  product_categories: report.results?.by_category?.length || 0,
  vendors: report.results?.by_vendor?.length || 0,
  vendor_category_groups: report.results?.by_vendor_category?.length || 0
}, null, 2));
