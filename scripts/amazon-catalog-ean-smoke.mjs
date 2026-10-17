import fs from "node:fs";

const BASE = "https://devidlabel-ai-assistant-backend.devidlabel.workers.dev";
const MARKETS = ["IT", "DE", "FR", "ES"];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function validEAN(ean) {
  if (typeof ean !== "string" || !/^\d{13}$/.test(ean)) return false;
  const sum = [...ean.slice(0,12)].reduce((value,digit,i) => value + Number(digit) * (i % 2 ? 3 : 1), 0);
  return (10 - sum % 10) % 10 === Number(ean[12]);
}
function sanitizedError(value) {
  return typeof value === "string" && /^amazon_[a-z0-9_]+$/.test(value)
    ? value.slice(0, 90) : null;
}

/** A bounded, read-only smoke test. Never saves the selected SKU or EAN. */
export async function probeAmazonCatalogEAN({ token, fetchImpl = fetch }) {
  const report = { generated_at: new Date().toISOString(),
    type: "amazon_catalog_ean_readonly_pilot", complete: false, read_only: true,
    source: "shopify_active_positive_stock_excluding_p448",
    sample_category: null, sample_vendor: null, valid_ean_checksum: false,
    markets: {}, errors: [] };
  if (!token) { report.errors.push("amazon_probe_missing_bearer"); return report; }
  let candidate = null, fallback = null, cursor = null;
  for (let page = 0; page < 15; page++) {
    const url = new URL(BASE + "/internal/amazon/shopify-eligible-page");
    if (cursor) url.searchParams.set("after", cursor);
    let data;
    try {
      const response = await fetchImpl(url, {
        method: "GET", headers: { Authorization: "Bearer " + token, Accept: "application/json" },
        signal: AbortSignal.timeout(35000)
      });
      if (!response.ok) throw new Error("amazon_probe_shopify_page_http_" + response.status);
      data = await response.json();
    } catch { report.errors.push("amazon_probe_shopify_unavailable"); return report; }
    if (!data || data.ok !== true || data.read_only !== true || !Array.isArray(data.eligible_variants)) {
      report.errors.push("amazon_probe_shopify_invalid"); return report;
    }
    for (const row of data.eligible_variants) {
      if (!validEAN(row.barcode) || !row.sku || row.inventory_quantity <= 0 ||
          String(row.vendor || "").trim().toUpperCase() === "P448") continue;
      if (!fallback) fallback = row;
      if (/sneakers|giacche e cappotti/i.test(row.product_type || "")) {
        candidate = row; break;
      }
    }
    if (candidate) break;
    if (!data.has_more) break;
    if (!data.next_cursor || data.next_cursor === cursor) { report.errors.push("amazon_probe_shopify_cursor_invalid"); return report; }
    cursor = data.next_cursor;
  }
  candidate ||= fallback;
  if (!candidate) { report.errors.push("amazon_probe_ean_not_found"); return report; }
  report.sample_category = String(candidate.product_type || "").slice(0, 100);
  report.sample_vendor = String(candidate.vendor || "").slice(0, 100);
  report.valid_ean_checksum = true;
  for (const market of MARKETS) {
    try {
      const url = new URL(BASE + "/internal/amazon/catalog-ean");
      url.searchParams.set("marketplace", market);
      url.searchParams.set("ean", candidate.barcode);
      const response = await fetchImpl(url, {
        method: "GET", headers: { Authorization: "Bearer " + token, Accept: "application/json" },
        signal: AbortSignal.timeout(35000)
      });
      let body = {};
      try { body = await response.json(); } catch {}
      const ok = response.status === 200 && body.ok === true && body.read_only === true;
      report.markets[market] = { http_status: response.status, ok,
        catalog_candidates: ok ? body.result?.catalog_candidates ?? null : null,
        exact_ean_matches: ok ? body.result?.exact_ean_matches ?? null : null,
        error_code: ok ? null : sanitizedError(body.error) };
    } catch {
      report.markets[market] = { ok: false, http_status: 0, error_code: "amazon_probe_catalog_network_error" };
    }
    await pause(1500);
  }
  report.complete = MARKETS.every(m => report.markets[m]?.ok === true);
  return report;
}

if (process.env.AMAZON_CATALOG_PROBE_RUN === "true") {
  const receipt = await probeAmazonCatalogEAN({ token: process.env.DAILY_PULSE_ACCESS_TOKEN || "" });
  fs.writeFileSync("/tmp/amazon-catalog-ean-probe.json", JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt, null, 2));
}
