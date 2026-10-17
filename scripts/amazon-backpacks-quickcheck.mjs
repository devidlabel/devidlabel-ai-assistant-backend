import fs from "node:fs";
import { auditShopifyAgainstAmazon } from "./amazon-shopify-live-audit.mjs";
import { validEAN } from "./amazon-sneakers-catalog-pilot.mjs";
import { catalogBatch } from "./amazon-sneakers-batched-ean.mjs";

const MARKETS = ["IT","DE","FR","ES"];
const BATCH_SIZE = 8;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const states = ["EXACT_ONE","EXACT_MULTIPLE","NO_EXACT_MATCH","UNVERIFIED"];
const newCounts = () => Object.fromEntries(states.map(state => [state, 0]));
const safeError = value => typeof value === "string" && /^amazon_[a-z0-9_]+$/.test(value)
  ? value.slice(0, 100) : "amazon_backpack_quickcheck_unclassified_error";

/**
 * Single-snapshot read-only pilot for up to 8 missing backpacks per country.
 * The pilot reports a subset only, never the full backpack catalogue.
 * Never persist seller SKUs, GTINs, ASINs or signed report URLs.
 */
export async function runBackpacksQuickCheck({
  bearer, auditFn = auditShopifyAgainstAmazon, lookup = catalogBatch,
  fetchImpl = fetch, delayMs = 2500
}) {
  const receipt = {
    schema_version: 1, generated_at: new Date().toISOString(),
    type: "amazon_eu_backpacks_ean_quickcheck",
    read_only: true, no_listing_writes: true,
    source: "complete_live_shopify_and_four_amazon_seller_reports",
    category: "Zaini", batch_size: BATCH_SIZE,
    max_items_per_market: 8, sample_only: true,
    results_are_full_snapshot: false, audit_complete: false,
    overall_complete: false, markets: {}, error_code: null
  };
  if (!bearer) {
    receipt.error_code = "amazon_backpack_quickcheck_bearer_missing";
    return receipt;
  }

  let privateSnapshot = null;
  let audit;
  try {
    audit = await auditFn({ bearer, onPrivateSnapshot: data => { privateSnapshot = data; } });
  } catch {
    receipt.error_code = "amazon_backpack_quickcheck_audit_failed";
    return receipt;
  }
  receipt.audit_complete = audit?.complete === true && audit?.shopify?.complete === true &&
    MARKETS.every(m => audit?.amazon?.[m]?.compare_ready === true);
  receipt.audit_generated_at = audit?.generated_at || null;
  receipt.shopify_eligible_variants = Number.isInteger(audit?.shopify?.eligible_variants)
    ? audit.shopify.eligible_variants : null;
  if (!receipt.audit_complete || !privateSnapshot || !Array.isArray(privateSnapshot.rows) ||
      !MARKETS.every(m => privateSnapshot.amazonIndexes?.[m] instanceof Map)) {
    receipt.error_code = "amazon_backpack_quickcheck_incomplete_sources";
    return receipt;
  }

  const { rows, amazonIndexes } = privateSnapshot;
  const skuCounts = new Map(), eanCounts = new Map();
  for (const row of rows) {
    skuCounts.set(row.sku, (skuCounts.get(row.sku) || 0) + 1);
    if (validEAN(row.barcode)) {
      eanCounts.set(row.barcode, (eanCounts.get(row.barcode) || 0) + 1);
    }
  }
  const backpackEligible = rows.filter(row =>
    row.product_type?.trim().toLowerCase() === "zaini" &&
    skuCounts.get(row.sku) === 1);
  receipt.backpack_eligible_nonduplicate_variants = backpackEligible.length;
  receipt.backpack_duplicate_sku_variants_quarantined = rows.filter(row =>
    row.product_type?.trim().toLowerCase() === "zaini" &&
    skuCounts.get(row.sku) !== 1).length;

  let stoppedForThrottle = false;
  for (const market of MARKETS) {
    const missing = backpackEligible.filter(row => !amazonIndexes[market].has(row.sku));
    const valid = missing.filter(row => validEAN(row.barcode));
    const safeAll = valid.filter(row => eanCounts.get(row.barcode) === 1);
    // Bounded pilot: never present these counts as the whole backpack collection.
    safeAll.sort((a,b) => a.sku.localeCompare(b.sku));
    const safe = safeAll.slice(0,8);
    const summary = {
      missing_backpack_variants: missing.length,
      missing_with_valid_ean: valid.length,
      missing_without_valid_ean: missing.length - valid.length,
      duplicate_ean_rows_quarantined: valid.length - safeAll.length,
      all_safe_ean_candidates: safeAll.length,
      eligible_eans_to_search: safe.length,
      sampled_eans: 0, groups_planned: Math.ceil(safe.length / BATCH_SIZE),
      groups_completed: 0, total_catalog_pages: 0,
      http_status_counts: {}, matching: newCounts(), by_vendor: [],
      status: "NOT_STARTED", error_code: null
    };
    receipt.markets[market] = summary;
    if (stoppedForThrottle) {
      summary.status = "SKIPPED_AFTER_THROTTLE";
      continue;
    }
    if (!safe.length) {
      summary.status = "NO_VALID_EANS";
      continue;
    }
    const byVendor = new Map();
    summary.status = "PARTIAL";
    for (let i = 0; i < safe.length; i += BATCH_SIZE) {
      const batch = safe.slice(i, i + BATCH_SIZE);
      let response;
      try {
        response = await lookup({
          market, selected: batch, bearer, fetchImpl, endpointRetryMs: 5000
        });
      } catch {
        response = { ok: false, http_status: 0,
          error_code: "amazon_backpack_quickcheck_network_error" };
      }
      const status = String(response.http_status ?? 0);
      summary.http_status_counts[status] = (summary.http_status_counts[status] || 0) + 1;
      if (!response.ok) {
        summary.error_code = safeError(response.error_code);
        if (response.error_code === "amazon_catalog_batch_http_429" || response.http_status === 429) {
          stoppedForThrottle = true;
        }
        break;
      }
      if (!Array.isArray(response.entries) || response.entries.length !== batch.length ||
          !Number.isInteger(response.pages_read) || response.pages_read < 1) {
        summary.error_code = "amazon_backpack_quickcheck_invalid_response";
        break;
      }
      const index = new Map(response.entries.map(entry => [entry.ean, entry.state]));
      if (index.size !== batch.length ||
          batch.some(row => !states.includes(index.get(row.barcode)))) {
        summary.error_code = "amazon_backpack_quickcheck_identity_mismatch";
        break;
      }
      // Only write group counts after the complete batch has been validated.
      for (const row of batch) {
        const classification = index.get(row.barcode);
        summary.matching[classification]++;
        const vendor = String(row.vendor || "Non specificato").slice(0, 120);
        if (!byVendor.has(vendor)) {
          byVendor.set(vendor, { vendor, searched: 0, matching: newCounts() });
        }
        byVendor.get(vendor).searched++;
        byVendor.get(vendor).matching[classification]++;
      }
      summary.sampled_eans += batch.length;
      summary.groups_completed++;
      summary.total_catalog_pages += response.pages_read;
      if (delayMs > 0) await pause(delayMs);
    }
    summary.by_vendor = [...byVendor.values()].sort((a,b) => b.searched - a.searched ||
      a.vendor.localeCompare(b.vendor));
    summary.status = summary.groups_completed === summary.groups_planned &&
      summary.sampled_eans === summary.eligible_eans_to_search && !summary.error_code
      ? "COMPLETE" : "PARTIAL";
  }
  receipt.overall_complete = MARKETS.every(m => receipt.markets[m]?.status === "COMPLETE");
  receipt.results_are_full_snapshot = false;
  if (!receipt.overall_complete) receipt.error_code = stoppedForThrottle
    ? "amazon_backpack_quickcheck_throttled" : "amazon_backpack_quickcheck_partial";
  return receipt;
}

if (process.env.AMAZON_BACKPACKS_QUICKCHECK_RUN === "true") {
  const result = await runBackpacksQuickCheck({
    bearer: process.env.DAILY_PULSE_ACCESS_TOKEN || ""
  });
  fs.writeFileSync("/tmp/amazon-backpacks-quickcheck.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
