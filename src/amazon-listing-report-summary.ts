import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces";

const API_ROOT = "https://sellingpartnerapi-eu.amazon.com";
const TYPE = "GET_MERCHANT_LISTINGS_ALL_DATA";
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const MAX_DECODED_BYTES = 32 * 1024 * 1024;

async function getJson(url: string, token: string, label: string): Promise<any> {
  const response = await fetch(url, {
    method: "GET",
    headers: { "x-amz-access-token": token, Accept: "application/json" }
  });
  if (!response.ok) throw new Error("amazon_" + label + "_failed_" + response.status);
  return response.json();
}

async function boundedRead(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Error("amazon_report_too_large");
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function countSkuRows(content: string): {
  rows: number;
  unique_skus: number;
  duplicate_sku_rows: number;
  active: number;
  inactive: number;
  status_unknown: number;
} {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  const first = lines.shift() || "";
  const headers = first.split("\t").map(value => value.trim().toLowerCase());
  const skuColumn = ["seller-sku", "seller_sku", "sku"].map(name => headers.indexOf(name)).find(index => index >= 0) ?? -1;
  if (skuColumn < 0) throw new Error("amazon_report_sku_header_missing");
  const statusColumn = ["status", "listing-status", "listing_status"].map(name => headers.indexOf(name)).find(index => index >= 0) ?? -1;
  let rows = 0, active = 0, inactive = 0, status_unknown = 0, duplicate_sku_rows = 0;
  const knownSkus = new Set<string>();
  for (const line of lines) {
    if (!line) continue;
    const cells = line.split("\t");
    const sku = cells[skuColumn];
    if (typeof sku !== "string" || sku.length === 0) throw new Error("amazon_report_blank_sku");
    rows++;
    if (knownSkus.has(sku)) duplicate_sku_rows++;
    knownSkus.add(sku);
    const status = (statusColumn >= 0 ? cells[statusColumn] : "").trim().toUpperCase();
    if (status === "ACTIVE") active++;
    else if (status === "INACTIVE" || status === "INCOMPLETE" || status === "SUPPRESSED") inactive++;
    else status_unknown++;
  }
  return { rows, unique_skus: knownSkus.size, duplicate_sku_rows, active, inactive, status_unknown };
}

/** One completed existing report only. Never creates reports or publishes offers. */
export async function readAmazonLatestListingReportSummary(
  env: AmazonCredentials,
  market: keyof typeof AMAZON_EU_MARKETPLACES
): Promise<unknown> {
  const id = AMAZON_EU_MARKETPLACES[market];
  if (!id) throw new Error("amazon_invalid_marketplace");
  const token = await getAmazonAccessToken(env);
  const reportUrl = new URL(API_ROOT + "/reports/2021-06-30/reports");
  reportUrl.searchParams.set("reportTypes", TYPE);
  reportUrl.searchParams.set("marketplaceIds", id);
  reportUrl.searchParams.set("pageSize", "20");
  const listing = await getJson(reportUrl.toString(), token, "reports_read") as {
    reports?: Array<{ reportId?: string; reportType?: string; processingStatus?: string; reportDocumentId?: string; createdTime?: string; processingEndTime?: string }>;
  };
  const completed = (listing.reports || [])
    .filter(item => item.reportType === TYPE && item.processingStatus === "DONE" && item.reportDocumentId)
    .sort((a, b) => (b.createdTime || "").localeCompare(a.createdTime || ""));
  if (!completed.length) return { marketplace: market, report_available: false, snapshot_complete: false };
  const selected = completed[0];
  const document = await getJson(API_ROOT + "/reports/2021-06-30/documents/" + encodeURIComponent(selected.reportDocumentId!), token, "report_document_read") as {
    url?: string; compressionAlgorithm?: string;
  };
  if (!document.url) throw new Error("amazon_report_document_url_missing");
  const signedUrl = new URL(document.url);
  if (signedUrl.protocol !== "https:" || !signedUrl.hostname.endsWith(".amazonaws.com") || signedUrl.username || signedUrl.password) {
    throw new Error("amazon_report_document_host_invalid");
  }
  const download = await fetch(signedUrl.toString(), { method: "GET", redirect: "error" });
  if (!download.ok || !download.body) throw new Error("amazon_report_download_failed_" + download.status);
  const length = Number(download.headers.get("content-length") || 0);
  if (length > MAX_DOWNLOAD_BYTES) throw new Error("amazon_report_too_large");
  const bytes = await boundedRead(download.body, MAX_DOWNLOAD_BYTES);
  let decoded = bytes;
  if (document.compressionAlgorithm === "GZIP") {
    decoded = await boundedRead(
      new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip")),
      MAX_DECODED_BYTES
    );
  } else if (document.compressionAlgorithm) {
    throw new Error("amazon_report_unknown_compression");
  }
  if (decoded.byteLength > MAX_DECODED_BYTES) throw new Error("amazon_report_too_large");
  const content = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  const counts = countSkuRows(content);
  const createdAt = selected.createdTime || null;
  const createdTime = createdAt ? Date.parse(createdAt) : NaN;
  const ageHours = Number.isFinite(createdTime) ? (Date.now() - createdTime) / 3600000 : null;
  const freshWithin24h = ageHours !== null && ageHours >= 0 && ageHours <= 24;
  return {
    marketplace: market,
    marketplace_id: id,
    report_available: true,
    report_type: TYPE,
    report_created_at: createdAt,
    report_age_hours: ageHours !== null ? Math.round(ageHours * 10) / 10 : null,
    fresh_within_24h: freshWithin24h,
    snapshot_complete: true,
    safe_for_missing_sku_classification: freshWithin24h && counts.duplicate_sku_rows === 0,
    ...counts
  };
}
