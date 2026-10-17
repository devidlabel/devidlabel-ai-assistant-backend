import fs from "node:fs";
import { auditShopifyAgainstAmazon } from "./amazon-shopify-live-audit.mjs";

const MARKETS = ["IT","DE","FR","ES"];
const STATES = [
  "EMPTY", "EAN13_VALID", "EAN13_INVALID", "UPC12_VALID", "UPC12_INVALID",
  "GTIN14_VALID", "GTIN14_INVALID", "EAN8_VALID", "EAN8_INVALID",
  "NON_DIGIT", "OTHER_NUMERIC_LENGTH"
];

function checksumValid(value) {
  if (!/^\d+$/.test(value) || value.length < 2) return false;
  const payload = value.slice(0,-1);
  const sum = [...payload].reverse().reduce((total,ch,i) =>
    total + Number(ch) * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(value[value.length - 1]);
}
export function classifyShopifyBarcode(value) {
  const code = typeof value === "string" ? value.trim() : "";
  if (!code) return "EMPTY";
  if (!/^\d+$/.test(code)) return "NON_DIGIT";
  const format = {8:"EAN8",12:"UPC12",13:"EAN13",14:"GTIN14"}[code.length];
  if (!format) return "OTHER_NUMERIC_LENGTH";
  return format + (checksumValid(code) ? "_VALID" : "_INVALID");
}

function newCounts() { return Object.fromEntries(STATES.map(s => [s,0])); }
function emptyMarket() {
  return {
    missing_backpacks:0, classified:0,
    gtin_format_counts:newCounts(), vendors:[]
  };
}
/**
 * Check barcode format only, no catalog requests or listing operations.
 * SKU identities and barcode values never enter the returned receipt.
 */
export async function auditBackpackBarcodeQuality({
  bearer, auditFn = auditShopifyAgainstAmazon
}) {
  const receipt = {
    schema_version:1, generated_at:new Date().toISOString(),
    type:"amazon_eu_backpack_missing_gtin_format_diagnostic",
    source:"live_shopify_and_complete_amazon_seller_reports",
    read_only:true, no_listing_writes:true,
    complete:false, shopify_audit_generated_at:null,
    markets:{}, error_code:null
  };
  if (!bearer) { receipt.error_code="amazon_barcode_audit_auth_missing"; return receipt; }
  let privateSnapshot = null, audit;
  try {
    audit = await auditFn({ bearer, onPrivateSnapshot:s => { privateSnapshot=s; } });
  } catch {
    receipt.error_code="amazon_barcode_audit_source_failure"; return receipt;
  }
  if (!audit || audit.complete !== true || audit.shopify?.complete !== true ||
      !MARKETS.every(m => audit.amazon?.[m]?.compare_ready === true) ||
      !Array.isArray(privateSnapshot?.rows) ||
      !MARKETS.every(m => privateSnapshot?.amazonIndexes?.[m] instanceof Map)) {
    receipt.error_code="amazon_barcode_audit_incomplete_sources"; return receipt;
  }
  receipt.shopify_audit_generated_at = audit.generated_at || null;
  const { rows, amazonIndexes } = privateSnapshot;
  const skuOccurrences = new Map();
  for (const r of rows) skuOccurrences.set(r.sku,(skuOccurrences.get(r.sku)||0)+1);
  const backpacks = rows.filter(r => r.product_type?.trim().toLowerCase()==="zaini" &&
    skuOccurrences.get(r.sku)===1);
  receipt.backpack_eligible_nonduplicate_variants=backpacks.length;
  receipt.backpack_duplicate_sku_variants_quarantined=rows.filter(r =>
    r.product_type?.trim().toLowerCase()==="zaini" && skuOccurrences.get(r.sku)>1).length;

  for (const market of MARKETS) {
    const summary=emptyMarket();
    const vendorBuckets = new Map();
    for (const row of backpacks) {
      if (amazonIndexes[market].has(row.sku)) continue;
      const barcodeStatus=classifyShopifyBarcode(row.barcode);
      summary.gtin_format_counts[barcodeStatus]++;
      summary.missing_backpacks++;
      summary.classified++;
      const vendor=String(row.vendor || "Non specificato").slice(0,120);
      if (!vendorBuckets.has(vendor)) vendorBuckets.set(vendor,{
        vendor, missing_backpacks:0, gtin_format_counts:newCounts()
      });
      const group=vendorBuckets.get(vendor);
      group.missing_backpacks++;
      group.gtin_format_counts[barcodeStatus]++;
    }
    summary.vendors=[...vendorBuckets.values()].sort((a,b) =>
      b.missing_backpacks-a.missing_backpacks || a.vendor.localeCompare(b.vendor));
    receipt.markets[market]=summary;
  }
  receipt.complete = MARKETS.every(m =>
    receipt.markets[m].classified === receipt.markets[m].missing_backpacks &&
    Object.values(receipt.markets[m].gtin_format_counts).reduce((s,n)=>s+n,0) ===
      receipt.markets[m].missing_backpacks);
  if (!receipt.complete) receipt.error_code="amazon_barcode_audit_inconsistent_counts";
  return receipt;
}

if (process.env.AMAZON_BACKPACK_BARCODE_QUALITY_RUN === "true") {
  const result=await auditBackpackBarcodeQuality({
    bearer:process.env.DAILY_PULSE_ACCESS_TOKEN||""
  });
  fs.writeFileSync("/tmp/amazon-backpack-barcode-quality.json",
    JSON.stringify(result,null,2)+"\n");
  console.log(JSON.stringify(result,null,2));
}
