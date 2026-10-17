import fs from "node:fs";
import { summarizeAmazonReportStream } from "./amazon-stream-count.mjs";

const token = process.env.DAILY_PULSE_ACCESS_TOKEN || "";
const base = "https://devidlabel-ai-assistant-backend.devidlabel.workers.dev";
const marketIds = {
  IT: "APJ6JRA9NG5V4",
  DE: "A1PA6795UKMFR9",
  FR: "A13V1IB3VIYZZH",
  ES: "A1RKKUPIHCS9HS"
};
const allowedError = value =>
  typeof value === "string" && /^amazon_[a-z0-9_]+$/.test(value)
    ? value.slice(0, 80) : null;

async function request(path) {
  try {
    const response = await fetch(base + path, {
      method: "GET",
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      signal: AbortSignal.timeout(35000)
    });
    let body = {};
    try { body = await response.json(); } catch {}
    return { status: response.status, body };
  } catch {
    return { status: 0, body: {} };
  }
}

const report = {
  schema_version: 3,
  generated_at: new Date().toISOString(),
  kind: "amazon_eu_stream_listing_counts",
  no_listing_writes: true,
  marketplaces: {},
  reports: {},
  listing_summaries: {},
  complete: false
};
if (!token) {
  report.error = "probe_bearer_missing";
} else {
  const participation = await request("/internal/amazon/marketplaces");
  const payload = Array.isArray(participation.body?.result?.payload)
    ? participation.body.result.payload : [];
  const found = new Set(payload.map(entry => entry.marketplace?.id).filter(Boolean));
  report.marketplaces = {
    http_status: participation.status,
    ok: participation.status === 200 && participation.body?.ok === true,
    account_marketplace_count: found.size,
    target_marketplaces_present: Object.fromEntries(
      Object.entries(marketIds).map(([market, id]) => [market, found.has(id)])
    ),
    error_code: allowedError(participation.body?.error)
  };
  for (const market of Object.keys(marketIds)) {
    const data = await request("/internal/amazon/listing-reports?marketplace=" + market);
    const body = data.body || {};
    const list = Array.isArray(body.result?.reports) ? body.result.reports : [];
    report.reports[market] = {
      http_status: data.status,
      ok: data.status === 200 && body.ok === true && body.read_only === true,
      metadata_reports_found: list.length,
      done_reports: list.filter(item => item.processingStatus === "DONE").length,
      done_documents_available: list.filter(item => item.processingStatus === "DONE" && item.reportDocumentAvailable).length,
      has_more_metadata: body.result?.has_more === true,
      error_code: allowedError(body.error)
    };
    report.listing_summaries[market] = await summarizeAmazonReportStream(market, token);
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  report.complete = report.marketplaces.ok === true
    && Object.values(report.marketplaces.target_marketplaces_present).every(Boolean)
    && Object.values(report.reports).every(item => item.ok === true)
    && Object.values(report.listing_summaries).length === 4
    && Object.values(report.listing_summaries).every(item => item.ok === true);
}
fs.writeFileSync("/tmp/amazon-eu-status-receipt.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
