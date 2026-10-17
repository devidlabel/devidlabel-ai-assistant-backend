import fs from "node:fs";
import { auditShopifyAgainstAmazon } from "./amazon-shopify-live-audit.mjs";
import { validEAN, sampleDiverseByVendor } from "./amazon-sneakers-catalog-pilot.mjs";

const BASE = "https://devidlabel-ai-assistant-backend.devidlabel.workers.dev";
const MARKETS = ["IT", "DE", "FR", "ES"];
const MAX_EANS_PER_MARKET = 8;
const SAMPLE_OFFSET = 8;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const STATES = ["EXACT_ONE", "EXACT_MULTIPLE", "NO_EXACT_MATCH", "UNVERIFIED"];
const newStates = () => Object.fromEntries(STATES.map(s => [s, 0]));
const publicError = value => typeof value === "string" && /^amazon_[a-z0-9_]+$/.test(value)
  ? value.slice(0, 100) : "amazon_batch_pilot_unclassified_error";

export async function catalogBatch({ market, selected, bearer, fetchImpl, endpointRetryMs = 5000 }) {
  const url = new URL(BASE + "/internal/amazon/catalog-eans");
  url.searchParams.set("marketplace", market);
  url.searchParams.set("eans", selected.map(row => row.barcode).join(","));
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { Authorization: "Bearer " + bearer, Accept: "application/json" },
      signal: AbortSignal.timeout(90000)
    });
    // Newly deployed Cloudflare routes can briefly return the old 404.
    // Never interpret that response as "EAN missing" from Amazon.
    if (response.status !== 404 || attempt === 2) break;
    if (endpointRetryMs > 0) await pause(endpointRetryMs * (attempt + 1));
  }
  let body = {};
  try { body = await response.json(); } catch {}
  if (response.status === 404) {
    return { ok: false, http_status: 404,
      error_code: "amazon_batch_pilot_endpoint_not_ready" };
  }
  if (response.status !== 200 || body?.ok !== true || body?.read_only !== true) {
    return { ok: false, http_status: response.status, error_code: publicError(body?.error) };
  }
  const result = body.result;
  if (!result || result.read_only !== true || result.complete !== true ||
      result.marketplace !== market || result.identifiers_count !== selected.length ||
      !Array.isArray(result.identifiers) || result.identifiers.length !== selected.length ||
      !Number.isInteger(result.pages_read) || result.pages_read < 1 || result.pages_read > 10) {
    return { ok: false, http_status: response.status, error_code: "amazon_batch_pilot_contract_error" };
  }
  const expected = new Set(selected.map(row => row.barcode));
  const seen = new Set();
  for (const entry of result.identifiers) {
    if (!entry || typeof entry.ean !== "string" || !expected.has(entry.ean) ||
        seen.has(entry.ean) || !STATES.includes(entry.state) ||
        !Number.isInteger(entry.exact_match_count) || entry.exact_match_count < 0 ||
        !Array.isArray(entry.asins) || entry.asins.length !== entry.exact_match_count ||
        (entry.state === "EXACT_ONE" && entry.exact_match_count !== 1) ||
        (entry.state === "EXACT_MULTIPLE" && entry.exact_match_count < 2) ||
        ((entry.state === "NO_EXACT_MATCH" || entry.state === "UNVERIFIED") && entry.exact_match_count !== 0)) {
      return { ok: false, http_status: response.status, error_code: "amazon_batch_pilot_identity_mismatch" };
    }
    seen.add(entry.ean);
  }
  if (seen.size !== selected.length) {
    return { ok: false, http_status: response.status, error_code: "amazon_batch_pilot_missing_ean_response" };
  }
  return { ok: true, http_status: response.status, pages_read: result.pages_read,
    entries: result.identifiers };
}

/**
 * One 8-EAN batched request per market (four requests total) after read-only
 * reconciliation. Raw Shopify SKU/EAN and Amazon ASIN never leave runner memory
 * except within the authenticated internal API call, and are never persisted.
 */
export async function runSneakerBatchedEANPilot({
  bearer, auditFn = auditShopifyAgainstAmazon, fetchImpl = fetch,
  delayMs = 3000, sampleOffset = SAMPLE_OFFSET, batchSize = MAX_EANS_PER_MARKET,
  endpointRetryMs = 5000
}) {
  const receipt = {
    schema_version: 1, generated_at: new Date().toISOString(),
    source: "shopify_live_missing_sneakers_amazon_catalog_ean_batched",
    read_only: true, no_listing_writes: true,
    sample_offset: sampleOffset, max_eans_per_market: Math.min(batchSize, MAX_EANS_PER_MARKET),
    samples_are_not_catalog_total: true,
    audit_complete: false, overall_complete: false,
    markets: {}, error_code: null
  };
  if (!bearer) { receipt.error_code = "amazon_batch_pilot_bearer_missing"; return receipt; }
  if (!Number.isInteger(sampleOffset) || sampleOffset < 0 || sampleOffset > 80 ||
      !Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_EANS_PER_MARKET) {
    receipt.error_code = "amazon_batch_pilot_invalid_configuration";
    return receipt;
  }

  let privateSnapshot = null;
  let audit;
  try {
    audit = await auditFn({ bearer, onPrivateSnapshot: value => { privateSnapshot = value; } });
  } catch {
    receipt.error_code = "amazon_batch_pilot_audit_failed";
    return receipt;
  }
  receipt.audit_complete = audit?.complete === true && audit?.shopify?.complete === true &&
    MARKETS.every(market => audit?.amazon?.[market]?.compare_ready === true);
  receipt.shopify_eligible_variants = Number.isInteger(audit?.shopify?.eligible_variants)
    ? audit.shopify.eligible_variants : null;
  receipt.audit_generated_at = audit?.generated_at || null;
  if (!receipt.audit_complete || !privateSnapshot || !Array.isArray(privateSnapshot.rows) ||
      !MARKETS.every(market => privateSnapshot.amazonIndexes?.[market] instanceof Map)) {
    receipt.error_code = "amazon_batch_pilot_incomplete_audit";
    return receipt;
  }

  const { rows, amazonIndexes } = privateSnapshot;
  const skuCount = new Map(), eanCount = new Map();
  for (const row of rows) {
    skuCount.set(row.sku, (skuCount.get(row.sku) || 0) + 1);
    if (validEAN(row.barcode)) eanCount.set(row.barcode, (eanCount.get(row.barcode) || 0) + 1);
  }
  const sneakers = rows.filter(row => row.product_type?.trim().toLowerCase() === "sneakers" &&
    skuCount.get(row.sku) === 1);
  receipt.sneaker_eligible_nonduplicate_variants = sneakers.length;

  let stopped = false;
  for (const market of MARKETS) {
    const missing = sneakers.filter(row => !amazonIndexes[market].has(row.sku));
    const valid = missing.filter(row => validEAN(row.barcode));
    const safe = valid.filter(row => eanCount.get(row.barcode) === 1);
    const selected = sampleDiverseByVendor(safe, sampleOffset + batchSize).slice(sampleOffset);
    const summary = {
      missing_sneaker_variants: missing.length,
      missing_with_valid_ean: valid.length,
      missing_without_valid_ean: missing.length - valid.length,
      missing_with_shared_ean: valid.length - safe.length,
      candidates_for_safe_lookup: safe.length,
      selected: selected.length, sampled: 0, http_status: null,
      catalog_pages_read: 0, matching: newStates(),
      by_vendor: [], status: "NOT_STARTED", error_code: null
    };
    receipt.markets[market] = summary;
    if (!selected.length) {
      summary.status = "NO_SAFE_EAN_SELECTED";
      continue;
    }
    if (stopped) {
      summary.status = "SKIPPED_AFTER_THROTTLE";
      continue;
    }
    let outcome;
    try { outcome = await catalogBatch({ market, selected, bearer, fetchImpl, endpointRetryMs }); }
    catch { outcome = { ok: false, http_status: 0, error_code: "amazon_batch_pilot_network_error" }; }
    summary.http_status = outcome.http_status;
    if (!outcome.ok) {
      summary.status = "LOOKUP_UNVERIFIED";
      summary.error_code = outcome.error_code;
      if (outcome.http_status === 429 || outcome.error_code === "amazon_catalog_batch_http_429") stopped = true;
      if (delayMs) await pause(delayMs);
      continue;
    }
    const byEan = new Map(outcome.entries.map(item => [item.ean, item.state]));
    const vendors = new Map();
    for (const item of selected) {
      const state = byEan.get(item.barcode);
      summary.matching[state]++;
      const vendor = String(item.vendor || "Non specificato").slice(0, 120);
      if (!vendors.has(vendor)) vendors.set(vendor, { vendor, sampled: 0, matching: newStates() });
      const bucket = vendors.get(vendor);
      bucket.sampled++;
      bucket.matching[state]++;
    }
    summary.by_vendor = [...vendors.values()];
    summary.sampled = selected.length;
    summary.catalog_pages_read = outcome.pages_read;
    summary.status = "SAMPLE_COMPLETE";
    if (delayMs) await pause(delayMs);
  }
  receipt.overall_complete = MARKETS.every(market =>
    receipt.markets[market]?.status === "SAMPLE_COMPLETE" &&
    receipt.markets[market]?.sampled === receipt.markets[market]?.selected);
  if (!receipt.overall_complete) receipt.error_code = stopped
    ? "amazon_batch_pilot_throttled" : "amazon_batch_pilot_partial_or_unverified";
  return receipt;
}

if (process.env.AMAZON_SNEAKERS_BATCHED_EAN_RUN === "true") {
  const report = await runSneakerBatchedEANPilot({
    bearer: process.env.DAILY_PULSE_ACCESS_TOKEN || ""
  });
  fs.writeFileSync("/tmp/amazon-sneakers-batched-ean.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
