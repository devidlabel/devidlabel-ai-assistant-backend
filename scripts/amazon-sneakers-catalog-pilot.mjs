import fs from "node:fs";
import { auditShopifyAgainstAmazon } from "./amazon-shopify-live-audit.mjs";

const BASE = "https://devidlabel-ai-assistant-backend.devidlabel.workers.dev";
const MARKETS = ["IT", "DE", "FR", "ES"];
const MAX_PER_MARKET = 4;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function validEAN(ean) {
  if (typeof ean !== "string" || !/^\d{13}$/.test(ean)) return false;
  const sum = [...ean.slice(0, 12)].reduce((n, digit, i) => n + Number(digit) * (i % 2 ? 3 : 1), 0);
  return (10 - sum % 10) % 10 === Number(ean[12]);
}
function safeError(value) {
  return typeof value === "string" && /^amazon_[a-z0-9_]+$/.test(value) ? value.slice(0, 90)
    : "amazon_pilot_invalid_or_missing_response";
}

const STATES = [
  "ONE_EXACT_EAN_ASIN_MATCH",
  "MULTIPLE_EXACT_EAN_ASIN_MATCHES",
  "NO_EXACT_EAN_MATCH_IN_RESPONSE",
  "LOOKUP_ERROR"
];
function newCounts() { return Object.fromEntries(STATES.map(key => [key, 0])); }
export function sampleDiverseByVendor(rows, limit) {
  const buckets = new Map();
  for (const item of rows) {
    const vendor = item.vendor || "Non specificato";
    if (!buckets.has(vendor)) buckets.set(vendor, []);
    buckets.get(vendor).push(item);
  }
  const vendors = [...buckets.keys()].sort((a, b) => a.localeCompare(b));
  for (const vendor of vendors) {
    buckets.get(vendor).sort((a, b) => a.sku.localeCompare(b.sku));
  }
  const selected = [];
  let position = 0;
  while (selected.length < limit && vendors.some(vendor => buckets.get(vendor).length > position)) {
    for (const vendor of vendors) {
      const item = buckets.get(vendor)[position];
      if (item) selected.push(item);
      if (selected.length >= limit) break;
    }
    position++;
  }
  return selected;
}
function emptyMarket() {
  return {
    report_complete: true, missing_sneaker_variants: 0,
    missing_with_valid_ean: 0, missing_without_valid_ean: 0,
    missing_with_ean_shared_across_shopify: 0, candidates_for_safe_lookup: 0,
    sampled: 0, successful_lookups: 0, lookup_errors: 0, cases: newCounts(),
    by_vendor: [], http_status_counts: {}, partial: false,
    status: "NOT_STARTED"
  };
}

/**
 * Exactly four bounded catalog queries per market, on SKUs confirmed missing
 * from the seller's complete marketplace reports. Full SKU, EAN and ASIN
 * identities remain in volatile runner memory and are never returned/logged.
 */
export async function runSneakerCatalogPilot({
  bearer,
  auditFn = auditShopifyAgainstAmazon,
  fetchImpl = fetch,
  delayMs = 2200,
  limitPerMarket = MAX_PER_MARKET,
  sampleOffset = 0
}) {
  const receipt = {
    schema_version: 1, generated_at: new Date().toISOString(),
    source: "live_shopify_missing_sneakers_vs_amazon_catalog_ean",
    read_only: true, no_listing_writes: true,
    collection: "Sneakers", cap_per_market: Math.min(Math.max(1, limitPerMarket), MAX_PER_MARKET),
    sample_offset: sampleOffset,
    audit_complete: false, amazon_reports_complete: false,
    overall_complete: false,
    counts_are_sample_only: true,
    markets: {}, error_code: null
  };
  if (!bearer) { receipt.error_code = "amazon_pilot_bearer_missing"; return receipt; }
  if (!Number.isInteger(sampleOffset) || sampleOffset < 0 || sampleOffset > 50) {
    receipt.error_code = "amazon_pilot_invalid_offset"; return receipt;
  }
  let privateData = null;
  let audit;
  try {
    audit = await auditFn({ bearer, onPrivateSnapshot: data => { privateData = data; } });
  } catch {
    receipt.error_code = "amazon_pilot_audit_failed"; return receipt;
  }
  receipt.audit_complete = audit?.complete === true && audit?.shopify?.complete === true;
  receipt.amazon_reports_complete = MARKETS.every(m => audit?.amazon?.[m]?.compare_ready === true);
  receipt.shopify_eligible_variants = Number.isInteger(audit?.shopify?.eligible_variants)
    ? audit.shopify.eligible_variants : null;
  receipt.shopify_report_timestamp = audit?.generated_at || null;
  if (!receipt.audit_complete || !receipt.amazon_reports_complete || !privateData) {
    receipt.error_code = "amazon_pilot_incomplete_eligible_or_amazon_snapshots";
    return receipt;
  }
  const { rows, amazonIndexes } = privateData;
  if (!Array.isArray(rows) || !MARKETS.every(m => amazonIndexes?.[m] instanceof Map)) {
    receipt.error_code = "amazon_pilot_private_snapshot_invalid"; return receipt;
  }
  const shopifySkuCounts = new Map(), shopifyEanCounts = new Map();
  for (const row of rows) {
    shopifySkuCounts.set(row.sku, (shopifySkuCounts.get(row.sku) || 0) + 1);
    if (validEAN(row.barcode)) {
      shopifyEanCounts.set(row.barcode, (shopifyEanCounts.get(row.barcode) || 0) + 1);
    }
  }
  const sneakers = rows.filter(item => item.product_type?.trim().toLowerCase() === "sneakers"
    && shopifySkuCounts.get(item.sku) === 1);
  receipt.sneaker_eligible_nonduplicate_variants = sneakers.length;
  receipt.sneaker_ambiguous_sku_variants = rows.filter(item =>
    item.product_type?.trim().toLowerCase() === "sneakers" && shopifySkuCounts.get(item.sku) > 1).length;

  let stopForThrottle = false;
  for (const market of MARKETS) {
    const info = emptyMarket();
    receipt.markets[market] = info;
    const missing = sneakers.filter(item => !amazonIndexes[market].has(item.sku));
    info.missing_sneaker_variants = missing.length;
    const ready = [];
    for (const item of missing) {
      if (!validEAN(item.barcode)) { info.missing_without_valid_ean++; continue; }
      info.missing_with_valid_ean++;
      if (shopifyEanCounts.get(item.barcode) !== 1) {
        info.missing_with_ean_shared_across_shopify++;
        continue;
      }
      ready.push(item);
    }
    info.candidates_for_safe_lookup = ready.length;
    const selected = sampleDiverseByVendor(ready, sampleOffset + receipt.cap_per_market)
      .slice(sampleOffset);
    info.status = selected.length ? "PARTIAL_SAMPLE" : "NO_SAFE_EAN_CANDIDATES";
    const byVendor = new Map();
    for (const item of selected) {
      if (stopForThrottle) { info.partial = true; break; }
      let status = "LOOKUP_ERROR", httpStatus = 0;
      try {
        const url = new URL(BASE + "/internal/amazon/catalog-ean");
        url.searchParams.set("marketplace", market);
        url.searchParams.set("ean", item.barcode);
        const response = await fetchImpl(url.toString(), {
          method: "GET",
          headers: { Authorization: "Bearer " + bearer, Accept: "application/json" },
          signal: AbortSignal.timeout(45000)
        });
        httpStatus = response.status;
        let body = {};
        try { body = await response.json(); } catch {}
        if (response.status === 200 && body.ok === true && body.read_only === true &&
            body.result?.marketplace === market &&
            Number.isInteger(body.result.exact_ean_matches) &&
            Number.isInteger(body.result.catalog_candidates) &&
            Array.isArray(body.result.candidates) &&
            body.result.exact_ean_matches >= 0 &&
            body.result.exact_ean_matches <= body.result.catalog_candidates &&
            body.result.catalog_candidates === body.result.candidates.length &&
            body.result.candidates.filter(candidate => candidate.ean_confirmed === true).length ===
              body.result.exact_ean_matches) {
          status = body.result.exact_ean_matches === 1 ? "ONE_EXACT_EAN_ASIN_MATCH"
            : body.result.exact_ean_matches > 1 ? "MULTIPLE_EXACT_EAN_ASIN_MATCHES"
            : "NO_EXACT_EAN_MATCH_IN_RESPONSE";
        }
        if (httpStatus === 429 || body.error === "amazon_catalog_http_429") {
          stopForThrottle = true;
        }
      } catch { /* Never expose native error text or signed URL. */ }
      info.http_status_counts[String(httpStatus)] =
        (info.http_status_counts[String(httpStatus)] || 0) + 1;
      info.cases[status]++;
      info.sampled++;
      if (status === "LOOKUP_ERROR") info.lookup_errors++;
      else info.successful_lookups++;
      const vendor = item.vendor?.slice(0, 120) || "Non specificato";
      if (!byVendor.has(vendor)) byVendor.set(vendor, { vendor, sampled: 0, cases: newCounts() });
      byVendor.get(vendor).sampled++;
      byVendor.get(vendor).cases[status]++;
      if (delayMs > 0) await pause(delayMs);
    }
    info.by_vendor = [...byVendor.values()];
    if (info.sampled === selected.length && info.lookup_errors === 0 && !stopForThrottle) {
      info.status = "SAMPLE_COMPLETE";
    } else if (stopForThrottle) {
      info.status = "THROTTLED_OR_INTERRUPTED";
      info.partial = true;
    }
  }
  // The batch is complete only if every marketplace tested at least one
  // valid EAN and all those queries returned trustworthy catalog responses.
  receipt.overall_complete = MARKETS.every(m => {
    const entry = receipt.markets[m];
    return entry?.status === "SAMPLE_COMPLETE" && entry.sampled > 0;
  });
  if (stopForThrottle) receipt.error_code = "amazon_pilot_catalog_throttled";
  else if (!receipt.overall_complete) receipt.error_code = "amazon_pilot_partial_or_unverified";
  return receipt;
}

if (process.env.AMAZON_SNEAKERS_PILOT_RUN === "true") {
  const receipt = await runSneakerCatalogPilot({ bearer: process.env.DAILY_PULSE_ACCESS_TOKEN || "" });
  fs.writeFileSync("/tmp/amazon-sneakers-catalog-pilot.json", JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt, null, 2));
}
