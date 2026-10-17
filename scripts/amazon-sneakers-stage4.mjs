import fs from "node:fs";
import { auditShopifyAgainstAmazon } from "./amazon-shopify-live-audit.mjs";
import { validEAN, sampleDiverseByVendor } from "./amazon-sneakers-catalog-pilot.mjs";
import { catalogBatch } from "./amazon-sneakers-batched-ean.mjs";

const MARKETS = ["IT", "DE", "FR", "ES"];
const SAMPLE_OFFSET = 16;
const BATCH_SIZE = 8;
const GROUPS_PER_MARKET = 3;
const TARGET = BATCH_SIZE * GROUPS_PER_MARKET;
const STATES = ["EXACT_ONE", "EXACT_MULTIPLE", "NO_EXACT_MATCH", "UNVERIFIED"];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const newCounts = () => Object.fromEntries(STATES.map(key => [key, 0]));
const safeError = raw => typeof raw === "string" && /^amazon_[a-z0-9_]+$/.test(raw)
  ? raw.slice(0, 100) : "amazon_sneakers_stage4_unclassified";

function newMarket() {
  return {
    missing_sneaker_variants: 0, missing_with_valid_ean: 0,
    missing_without_valid_ean: 0, duplicate_shopify_ean_blocked: 0,
    candidates_for_matching: 0,
    planned: 0, sampled: 0, groups_completed: 0, groups_planned: 0,
    http_status_counts: {}, catalog_pages_read: 0,
    matching: newCounts(), by_vendor: [], error_code: null,
    status: "NOT_STARTED"
  };
}

/** Reconcile once; query 24 additional EANs across three bounded groups. */
export async function runStage4Sneakers({
  bearer, auditFn = auditShopifyAgainstAmazon, lookup = catalogBatch,
  fetchImpl = fetch, delayMs = 2200
}) {
  const receipt = {
    schema_version: 1, generated_at: new Date().toISOString(),
    type: "amazon_sneakers_ean_bulk_stage4",
    read_only: true, no_listing_writes: true, category: "Sneakers",
    start_offset: SAMPLE_OFFSET, batch_size: BATCH_SIZE,
    groups_per_market: GROUPS_PER_MARKET, target_per_market: TARGET,
    counts_are_subset_only: true,
    audit_complete: false, overall_complete: false,
    markets: {}, error_code: null
  };
  if (!bearer) {
    receipt.error_code = "amazon_sneakers_stage4_bearer_missing";
    return receipt;
  }
  let snapshot = null;
  let audit;
  try {
    audit = await auditFn({ bearer, onPrivateSnapshot: s => { snapshot = s; } });
  } catch {
    receipt.error_code = "amazon_sneakers_stage4_audit_failed";
    return receipt;
  }
  receipt.audit_complete = audit?.complete === true && audit?.shopify?.complete === true &&
    MARKETS.every(market => audit?.amazon?.[market]?.compare_ready === true);
  receipt.audit_generated_at = audit?.generated_at || null;
  receipt.shopify_eligible_variants = Number.isInteger(audit?.shopify?.eligible_variants)
    ? audit.shopify.eligible_variants : null;
  if (!receipt.audit_complete || !snapshot || !Array.isArray(snapshot.rows) ||
      !MARKETS.every(m => snapshot.amazonIndexes?.[m] instanceof Map)) {
    receipt.error_code = "amazon_sneakers_stage4_snapshot_incomplete";
    return receipt;
  }
  const { rows, amazonIndexes } = snapshot;
  const skus = new Map(), eans = new Map();
  for (const row of rows) {
    skus.set(row.sku, (skus.get(row.sku) || 0) + 1);
    if (validEAN(row.barcode)) eans.set(row.barcode, (eans.get(row.barcode) || 0) + 1);
  }
  const sneakers = rows.filter(row =>
    row.product_type?.trim().toLowerCase() === "sneakers" &&
    skus.get(row.sku) === 1);
  receipt.sneaker_eligible_nonduplicate_variants = sneakers.length;
  receipt.sneaker_sku_duplicates_quarantined = rows.filter(row =>
    row.product_type?.trim().toLowerCase() === "sneakers" &&
    skus.get(row.sku) > 1).length;

  let throttle = false;
  for (const market of MARKETS) {
    const summary = newMarket();
    receipt.markets[market] = summary;
    const missing = sneakers.filter(row => !amazonIndexes[market].has(row.sku));
    const valid = missing.filter(row => validEAN(row.barcode));
    const ready = valid.filter(row => eans.get(row.barcode) === 1);
    summary.missing_sneaker_variants = missing.length;
    summary.missing_with_valid_ean = valid.length;
    summary.missing_without_valid_ean = missing.length - valid.length;
    summary.duplicate_shopify_ean_blocked = valid.length - ready.length;
    summary.candidates_for_matching = ready.length;
    const selected = sampleDiverseByVendor(ready, SAMPLE_OFFSET + TARGET).slice(SAMPLE_OFFSET);
    summary.planned = selected.length;
    summary.groups_planned = Math.ceil(selected.length / BATCH_SIZE);
    if (selected.length !== TARGET) {
      summary.status = "NOT_ENOUGH_ELIGIBLE_EANS";
      continue;
    }
    if (throttle) {
      summary.status = "SKIPPED_AFTER_THROTTLE";
      continue;
    }
    const vendors = new Map();
    summary.status = "PARTIAL";
    for (let start = 0; start < selected.length; start += BATCH_SIZE) {
      const chunk = selected.slice(start, start + BATCH_SIZE);
      let outcome;
      try {
        outcome = await lookup({ market, selected: chunk, bearer, fetchImpl, endpointRetryMs: 5000 });
      } catch {
        outcome = { ok: false, http_status: 0, error_code: "amazon_sneakers_stage4_network_error" };
      }
      const http = String(outcome.http_status ?? 0);
      summary.http_status_counts[http] = (summary.http_status_counts[http] || 0) + 1;
      if (!outcome.ok) {
        summary.error_code = safeError(outcome.error_code);
        if (outcome.error_code === "amazon_catalog_batch_http_429" || outcome.http_status === 429) {
          throttle = true;
        }
        break;
      }
      if (!Array.isArray(outcome.entries) || outcome.entries.length !== chunk.length ||
          !Number.isInteger(outcome.pages_read) || outcome.pages_read < 1) {
        summary.error_code = "amazon_sneakers_stage4_invalid_result";
        break;
      }
      const byEAN = new Map(outcome.entries.map(row => [row.ean, row.state]));
      if (byEAN.size !== chunk.length || chunk.some(row => !STATES.includes(byEAN.get(row.barcode)))) {
        summary.error_code = "amazon_sneakers_stage4_identity_invalid";
        break;
      }
      // Record aggregated classifications only after the whole group validates.
      for (const row of chunk) {
        const state = byEAN.get(row.barcode);
        summary.matching[state]++;
        const vendor = String(row.vendor || "Non specificato").slice(0, 120);
        if (!vendors.has(vendor)) vendors.set(vendor, { vendor, sampled: 0, matching: newCounts() });
        const item = vendors.get(vendor);
        item.sampled++;
        item.matching[state]++;
      }
      summary.sampled += chunk.length;
      summary.groups_completed++;
      summary.catalog_pages_read += outcome.pages_read;
      if (delayMs > 0) await pause(delayMs);
    }
    summary.by_vendor = [...vendors.values()];
    summary.status = summary.groups_completed === GROUPS_PER_MARKET &&
      summary.sampled === TARGET && !summary.error_code ? "COMPLETE" : "PARTIAL";
  }
  receipt.overall_complete = MARKETS.every(m => receipt.markets[m]?.status === "COMPLETE");
  if (!receipt.overall_complete) receipt.error_code = throttle
    ? "amazon_sneakers_stage4_throttled" : "amazon_sneakers_stage4_partial";
  return receipt;
}

if (process.env.AMAZON_SNEAKERS_STAGE4_RUN === "true") {
  const result = await runStage4Sneakers({ bearer: process.env.DAILY_PULSE_ACCESS_TOKEN || "" });
  fs.writeFileSync("/tmp/amazon-sneakers-stage4.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
