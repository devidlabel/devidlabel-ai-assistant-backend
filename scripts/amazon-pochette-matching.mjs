import fs from "node:fs";
import { auditShopifyAgainstAmazon } from "./amazon-shopify-live-audit.mjs";
import { classifyShopifyBarcode } from "./amazon-backpack-barcode-quality.mjs";
import { catalogBatch } from "./amazon-sneakers-batched-ean.mjs";
import { catalogUPCBatch } from "./amazon-backpacks-full-upc.mjs";

const MARKETS = ["IT", "DE", "FR", "ES"];
const CATEGORY = "Pochette e Borselli";
const BATCH_SIZE = 8;
const STATES = ["EXACT_ONE", "EXACT_MULTIPLE", "NO_EXACT_MATCH", "UNVERIFIED"];
const TYPES = ["EAN", "UPC"];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const matchCounts = () => Object.fromEntries(STATES.map(key => [key, 0]));
const byType = () => Object.fromEntries(TYPES.map(type => [type, {
  candidates: 0, searched: 0, groups_complete: 0, pages_read: 0,
  matching: matchCounts(), status: "NOT_STARTED", error_code: null
}]));
const safeError = e => typeof e === "string" && /^amazon_[a-z0-9_]+$/.test(e)
  ? e.slice(0, 100) : "amazon_pochette_unclassified_error";
const validType = code => {
  const status = classifyShopifyBarcode(code);
  return status === "EAN13_VALID" ? "EAN"
    : status === "UPC12_VALID" ? "UPC" : null;
};

/**
 * Run one complete, verified snapshot per country for seller-missing in-stock
 * Shopify Pochette e Borselli. Match only unique valid original UPC/EAN identifiers.
 * Return category/brand aggregates only; never log SKU, GTIN, ASIN or tokens.
 */
export async function runPochetteCatalogAudit({
  bearer,
  auditFn = auditShopifyAgainstAmazon,
  eanLookup = catalogBatch,
  upcLookup = catalogUPCBatch,
  fetchImpl = fetch,
  delayMs = 2200
}) {
  const result = {
    schema_version: 1, generated_at: new Date().toISOString(),
    type: "amazon_eu_pochette_ean_upc_matching",
    source: "complete_live_shopify_and_four_amazon_seller_reports",
    category: CATEGORY, identifier_types: TYPES, batch_size: BATCH_SIZE,
    read_only: true, no_listing_writes: true,
    audit_complete: false, overall_complete: false,
    results_are_full_snapshot: false,
    italy_season_activation_gate_required: true,
    markets: {}, error_code: null
  };
  if (!bearer) {
    result.error_code = "amazon_pochette_auth_missing";
    return result;
  }

  let snapshot = null, audit;
  try {
    audit = await auditFn({
      bearer,
      onPrivateSnapshot: raw => { snapshot = raw; }
    });
  } catch {
    result.error_code = "amazon_pochette_source_failure";
    return result;
  }

  result.audit_complete = audit?.complete === true && audit?.shopify?.complete === true &&
    MARKETS.every(m => audit?.amazon?.[m]?.compare_ready === true);
  result.audit_generated_at = audit?.generated_at || null;
  if (!result.audit_complete || !snapshot ||
      !Array.isArray(snapshot.rows) ||
      !MARKETS.every(m => snapshot.amazonIndexes?.[m] instanceof Map)) {
    result.error_code = "amazon_pochette_incomplete_snapshot";
    return result;
  }

  const { rows, amazonIndexes } = snapshot;
  const skuCounts = new Map(), barcodeCounts = new Map();
  for (const row of rows) {
    skuCounts.set(row.sku, (skuCounts.get(row.sku) || 0) + 1);
    const type = validType(row.barcode);
    if (type) {
      const key = type + ":" + row.barcode;
      barcodeCounts.set(key, (barcodeCounts.get(key) || 0) + 1);
    }
  }
  const eligible = rows.filter(row =>
    row.product_type?.trim().toLowerCase() === "pochette e borselli" &&
    skuCounts.get(row.sku) === 1);
  result.eligible_unique_sku_variants = eligible.length;
  result.duplicate_sku_variants_quarantined = rows.filter(row =>
    row.product_type?.trim().toLowerCase() === "pochette e borselli" &&
    skuCounts.get(row.sku) > 1).length;

  let throttle = false;
  for (const market of MARKETS) {
    const missing = eligible.filter(row => !amazonIndexes[market].has(row.sku));
    const groups = byType();
    const vendors = new Map();
    const summary = {
      missing_from_seller_report: missing.length,
      already_in_seller_report: eligible.length - missing.length,
      blank_or_invalid_gtin: 0,
      other_valid_gtin_format_not_queried: 0,
      duplicate_gtin_rows_quarantined: 0,
      identifier_groups: groups,
      match_counts: matchCounts(),
      vendor_breakdown: [],
      status: "NOT_STARTED",
      error_code: null
    };
    result.markets[market] = summary;
    const buckets = { EAN: [], UPC: [] };
    for (const row of missing) {
      const type = validType(row.barcode);
      if (!type) {
        const raw = classifyShopifyBarcode(row.barcode);
        if (raw === "GTIN14_VALID" || raw === "EAN8_VALID")
          summary.other_valid_gtin_format_not_queried++;
        else summary.blank_or_invalid_gtin++;
        continue;
      }
      if (barcodeCounts.get(type + ":" + row.barcode) !== 1) {
        summary.duplicate_gtin_rows_quarantined++;
        continue;
      }
      buckets[type].push(row);
    }
    for (const type of TYPES) {
      buckets[type].sort((a, b) => a.sku.localeCompare(b.sku));
      groups[type].candidates = buckets[type].length;
      groups[type].status = "NOT_STARTED";
    }
    if (throttle) {
      summary.status = "SKIPPED_AFTER_THROTTLE";
      continue;
    }
    summary.status = "PARTIAL";
    let errored = false;
    for (const type of TYPES) {
      const bucket = groups[type];
      const selected = buckets[type];
      if (selected.length === 0) {
        bucket.status = "NO_ELIGIBLE_IDENTIFIERS";
        continue;
      }
      for (let start = 0; start < selected.length; start += BATCH_SIZE) {
        const batch = selected.slice(start, start + BATCH_SIZE);
        let response;
        try {
          response = await (type === "EAN" ? eanLookup : upcLookup)({
            market, selected: batch, bearer, fetchImpl, endpointRetryMs: 5000
          });
        } catch {
          response = { ok: false, http_status: 0,
            error_code: "amazon_pochette_network_error" };
        }
        if (!response?.ok) {
          bucket.error_code = safeError(response?.error_code);
          bucket.status = "PARTIAL";
          summary.error_code = bucket.error_code;
          errored = true;
          if (response?.http_status === 429 ||
              response?.error_code === "amazon_catalog_batch_http_429") throttle = true;
          break;
        }
        if (!Array.isArray(response.entries) ||
            response.entries.length !== batch.length ||
            !Number.isInteger(response.pages_read) ||
            response.pages_read < 1 || response.pages_read > 10) {
          bucket.error_code = "amazon_pochette_invalid_catalog_response";
          summary.error_code = bucket.error_code;
          errored = true;
          break;
        }
        const field = type === "EAN" ? "ean" : "upc";
        const index = new Map(response.entries.map(entry =>
          [entry[field], entry.state]));
        if (index.size !== batch.length ||
            batch.some(row => !STATES.includes(index.get(row.barcode)))) {
          bucket.error_code = "amazon_pochette_identifier_identity_mismatch";
          summary.error_code = bucket.error_code;
          errored = true;
          break;
        }
        for (const row of batch) {
          const state = index.get(row.barcode);
          summary.match_counts[state]++;
          bucket.matching[state]++;
          const vendor = String(row.vendor || "Non specificato").slice(0, 120);
          if (!vendors.has(vendor)) {
            vendors.set(vendor, { vendor, searched: 0,
              by_identifier: { EAN: matchCounts(), UPC: matchCounts() } });
          }
          vendors.get(vendor).searched++;
          vendors.get(vendor).by_identifier[type][state]++;
        }
        bucket.searched += batch.length;
        bucket.groups_complete++;
        bucket.pages_read += response.pages_read;
        if (delayMs > 0) await pause(delayMs);
      }
      if (errored) break;
      bucket.status = "COMPLETE";
    }
    summary.vendor_breakdown = [...vendors.values()].sort((a,b) =>
      b.searched - a.searched || a.vendor.localeCompare(b.vendor));
    summary.status = !errored && TYPES.every(type =>
      ["COMPLETE", "NO_ELIGIBLE_IDENTIFIERS"].includes(groups[type].status))
      ? "COMPLETE" : "PARTIAL";
  }
  result.overall_complete = MARKETS.every(m => result.markets[m]?.status === "COMPLETE");
  result.results_are_full_snapshot = result.overall_complete;
  if (!result.overall_complete) result.error_code = throttle
    ? "amazon_pochette_throttled" : "amazon_pochette_partial";
  return result;
}

if (process.env.AMAZON_POCHETTE_MATCHING_RUN === "true") {
  const result = await runPochetteCatalogAudit({
    bearer: process.env.DAILY_PULSE_ACCESS_TOKEN || ""
  });
  fs.writeFileSync("/tmp/amazon-pochette-matching.json",
    JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
