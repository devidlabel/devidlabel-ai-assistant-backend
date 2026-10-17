import { summarizeAmazonReportStream } from "./amazon-stream-count.mjs";

const BASE = "https://devidlabel-ai-assistant-backend.devidlabel.workers.dev";
const MARKETS = ["IT", "DE", "FR", "ES"];
const MAX_SHOPIFY_PAGES = 400;
const SHOPIFY_RETRIES_MS = [2000, 5000, 10000, 20000];

function safeCode(value) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" && /^(amazon|shopify|http)_[a-z0-9_]+$/.test(value)
    ? value.slice(0, 90) : "amazon_audit_unclassified_failure";
}
function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function emptyStates() {
  return { PRESENT_ACTIVE: 0, PRESENT_INACTIVE: 0, PRESENT_UNKNOWN: 0,
    NOT_FOUND_IN_AMAZON_REPORT: 0, UNVERIFIED: 0, DUPLICATE_SHOPIFY_SKU: 0 };
}
function newMarketCounts() { return Object.fromEntries(MARKETS.map(m => [m, emptyStates()])); }

async function shopifyPage(token, cursor, fetchImpl) {
  const url = new URL(BASE + "/internal/amazon/shopify-eligible-page");
  if (cursor) url.searchParams.set("after", cursor);
  for (let attempt = 0; attempt <= SHOPIFY_RETRIES_MS.length; attempt++) {
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { Authorization: "Bearer " + token, Accept: "application/json" },
        signal: AbortSignal.timeout(45000)
      });
    } catch {
      if (attempt < SHOPIFY_RETRIES_MS.length) { await pause(SHOPIFY_RETRIES_MS[attempt]); continue; }
      throw new Error("shopify_page_network_error");
    }
    if ([429, 502, 503, 504].includes(response.status) && attempt < SHOPIFY_RETRIES_MS.length) {
      await pause(SHOPIFY_RETRIES_MS[attempt]); continue;
    }
    if (!response.ok) throw new Error("shopify_page_http_" + response.status);
    let data;
    try { data = await response.json(); } catch { throw new Error("shopify_page_invalid_json"); }
    if (!data || data.ok !== true || data.read_only !== true || data.source !== "shopify_live"
      || !Array.isArray(data.eligible_variants) || typeof data.has_more !== "boolean"
      || !Number.isInteger(data.products_scanned) || !Number.isInteger(data.variants_scanned)
      || !Number.isInteger(data.eligible_count) || data.eligible_count !== data.eligible_variants.length
      || data.sort_key !== "ID") throw new Error("shopify_page_contract_invalid");
    if (data.has_more && (!data.next_cursor || typeof data.next_cursor !== "string")) {
      throw new Error("shopify_page_next_cursor_missing");
    }
    return data;
  }
  throw new Error("shopify_page_retry_exhausted");
}

function summarizeSegments(rows, classifications, keys) {
  const groups = new Map();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const key = keys.map(k => String(row[k] || "Non specificato").slice(0, 120)).join(" | ");
    if (!groups.has(key)) {
      groups.set(key, { label: key, eligible_variants: 0, markets: newMarketCounts() });
    }
    const target = groups.get(key);
    target.eligible_variants++;
    for (const market of MARKETS) target.markets[market][classifications[i][market]]++;
  }
  return [...groups.values()].sort((a,b) => b.eligible_variants-a.eligible_variants || a.label.localeCompare(b.label));
}

/**
 * Read-only live reconciliation. The complete raw Shopify and Amazon SKU arrays
 * exist only in runner memory. Never serialize them into the returned receipt.
 */
export async function auditShopifyAgainstAmazon({
  bearer,
  amazonReader = null,
  shopifyFetch = fetch
}) {
  const report = {
    schema_version: 1, generated_at: new Date().toISOString(),
    source: "shopify_live_vs_amazon_reports",
    read_only: true, no_listing_writes: true,
    amazon: {}, shopify: { complete: false }, results: null, complete: false
  };
  if (!bearer) { report.error_code = "amazon_audit_bearer_missing"; return report; }
  const amazonIndexes = {};
  for (const market of MARKETS) {
    const index = new Map();
    let summary;
    try {
      if (amazonReader) {
        summary = await amazonReader(market, index);
      } else {
        summary = await summarizeAmazonReportStream(
          market, bearer, fetch, (sku, status) => { index.set(sku, status); }
        );
      }
    } catch { summary = { ok: false, error_code: "amazon_audit_report_read_failure" }; }
    const safe = summary?.ok === true && summary?.safe_for_missing_sku_classification === true &&
      summary?.unique_skus === index.size && summary?.duplicate_sku_rows === 0;
    report.amazon[market] = {
      ok: summary?.ok === true, compare_ready: safe,
      report_created_at: summary?.report_created_at || null,
      report_unique_skus: Number.isFinite(summary?.unique_skus) ? summary.unique_skus : null,
      report_active: Number.isFinite(summary?.active) ? summary.active : null,
      report_inactive: Number.isFinite(summary?.inactive) ? summary.inactive : null,
      error_code: safeCode(summary?.error_code)
    };
    if (safe) amazonIndexes[market] = index;
  }

  const started = Date.now();
  const rows = [];
  const cursors = new Set();
  let cursor = null, pageCount = 0, productsScanned = 0, variantsScanned = 0;
  const excluded = { p448: 0, not_active: 0, no_stock: 0, blank_sku: 0 };
  try {
    let hasMore = true;
    while (hasMore) {
      if (pageCount >= MAX_SHOPIFY_PAGES) throw new Error("shopify_scan_page_limit");
      const data = await shopifyPage(bearer, cursor, shopifyFetch);
      pageCount++;
      productsScanned += data.products_scanned;
      variantsScanned += data.variants_scanned;
      for (const key of Object.keys(excluded)) {
        if (!Number.isInteger(data.excluded?.[key]) || data.excluded[key] < 0) throw new Error("shopify_excluded_invalid");
        excluded[key] += data.excluded[key];
      }
      if (data.products_scanned === 0 && data.has_more) throw new Error("shopify_page_empty_progress");
      for (const item of data.eligible_variants) {
        if (!item || typeof item.sku !== "string" || !item.sku.trim()
          || !Number.isFinite(item.inventory_quantity) || item.inventory_quantity <= 0
          || String(item.vendor || "").trim().toUpperCase() === "P448"
          || typeof item.product_id !== "string" || typeof item.variant_id !== "string") {
          throw new Error("shopify_page_unsafe_item");
        }
        rows.push({
          sku: item.sku, vendor: typeof item.vendor === "string" ? item.vendor : "",
          product_type: typeof item.product_type === "string" ? item.product_type : "",
          product_id: item.product_id, variant_id: item.variant_id
        });
      }
      hasMore = data.has_more;
      if (hasMore) {
        if (cursors.has(data.next_cursor) || data.next_cursor === cursor) throw new Error("shopify_page_cursor_cycle");
        cursors.add(data.next_cursor);
        cursor = data.next_cursor;
      }
      // Respect Shopify API costs and avoid concentrated bursts against Cloudflare.
      if (hasMore) await pause(175);
    }
  } catch (error) {
    report.shopify = {
      complete: false, pages_scanned: pageCount, products_scanned: productsScanned,
      variants_scanned: variantsScanned, eligible_variants_partial: rows.length,
      error_code: safeCode(error instanceof Error ? error.message : null)
    };
    return report;
  }
  const durationSeconds = Math.round((Date.now() - started) / 1000);
  const skuCounts = new Map();
  for (const row of rows) skuCounts.set(row.sku, (skuCounts.get(row.sku) || 0) + 1);
  const duplicates = rows.filter(row => skuCounts.get(row.sku) > 1).length;
  report.shopify = {
    complete: true, pages_scanned: pageCount, products_scanned: productsScanned,
    variants_scanned: variantsScanned, eligible_variants: rows.length,
    eligible_unique_skus: skuCounts.size, ambiguous_duplicate_variant_rows: duplicates,
    excluded, duration_seconds: durationSeconds
  };

  const totalMarkets = newMarketCounts();
  const classifications = rows.map(row => {
    const states = {};
    for (const market of MARKETS) {
      let state;
      if (skuCounts.get(row.sku) > 1) state = "DUPLICATE_SHOPIFY_SKU";
      else if (!amazonIndexes[market]) state = "UNVERIFIED";
      else if (!amazonIndexes[market].has(row.sku)) state = "NOT_FOUND_IN_AMAZON_REPORT";
      else {
        const status = amazonIndexes[market].get(row.sku);
        state = status === "ACTIVE" ? "PRESENT_ACTIVE"
          : ["INACTIVE", "INCOMPLETE", "SUPPRESSED"].includes(status) ? "PRESENT_INACTIVE"
          : "PRESENT_UNKNOWN";
      }
      states[market] = state;
      totalMarkets[market][state]++;
    }
    return states;
  });
  report.results = {
    markets: totalMarkets,
    by_category: summarizeSegments(rows, classifications, ["product_type"]),
    by_vendor: summarizeSegments(rows, classifications, ["vendor"]),
    by_vendor_category: summarizeSegments(rows, classifications, ["vendor", "product_type"])
  };
  report.complete = durationSeconds <= 3600 &&
    MARKETS.every(m => report.amazon[m].compare_ready === true);
  report.shopify.duration_within_hour = durationSeconds <= 3600;
  return report;
}
