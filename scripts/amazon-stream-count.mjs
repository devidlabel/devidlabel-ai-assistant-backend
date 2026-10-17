import { gunzipSync } from "node:zlib";

const MAX_RAW = 64 * 1024 * 1024;
const MAX_DECODED = 200 * 1024 * 1024;
const BASE = "https://devidlabel-ai-assistant-backend.devidlabel.workers.dev";

const safeError = value =>
  typeof value === "string" && /^amazon_[a-z0-9_]+$/.test(value)
    ? value.slice(0, 90) : "amazon_stream_analysis_error";

async function readLimited(stream, limit) {
  if (!stream) throw new Error("amazon_stream_body_missing");
  const reader = stream.getReader();
  let total = 0;
  const chunks = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) throw new Error("amazon_stream_too_large");
      chunks.push(Buffer.from(next.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

function parseReport(data) {
  let encodingVerified = true;
  let text;
  if (data[0] === 0xff && data[1] === 0xfe) {
    text = new TextDecoder("utf-16le", { fatal: true }).decode(data);
  } else if (data[0] === 0xfe && data[1] === 0xff) {
    text = new TextDecoder("utf-16be", { fatal: true }).decode(data);
  } else {
    text = new TextDecoder("utf-8", { fatal: false }).decode(data);
    encodingVerified = !text.includes("\uFFFD");
  }
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = (lines.shift() || "").split("\t").map(item => item.trim().toLowerCase());
  const skuIdx = ["seller-sku", "seller_sku", "sku"].map(s => header.indexOf(s)).find(n => n >= 0) ?? -1;
  if (skuIdx < 0) throw new Error("amazon_stream_sku_header_missing");
  const statusIdx = ["status", "listing-status", "listing_status"].map(s => header.indexOf(s)).find(n => n >= 0) ?? -1;
  const seen = new Set();
  let rows = 0, duplicates = 0, active = 0, inactive = 0, unknown = 0;
  for (const line of lines) {
    if (!line) continue;
    const columns = line.split("\t");
    const sku = columns[skuIdx];
    if (typeof sku !== "string" || !sku.length) throw new Error("amazon_stream_blank_sku");
    rows++;
    if (seen.has(sku)) duplicates++;
    seen.add(sku);
    const status = (statusIdx < 0 ? "" : columns[statusIdx] || "").trim().toUpperCase();
    if (status === "ACTIVE") active++;
    else if (["INACTIVE", "INCOMPLETE", "SUPPRESSED"].includes(status)) inactive++;
    else unknown++;
  }
  return { rows, unique_skus: seen.size, duplicate_sku_rows: duplicates,
    active, inactive, status_unknown: unknown, encoding_verified: encodingVerified,
    status_column_present: statusIdx >= 0 };
}

/** Fetch authenticated report stream. Never persist or log SKU rows. */
export async function summarizeAmazonReportStream(market, bearer, fetchImpl = fetch) {
  const result = { marketplace: market, http_status: 0, ok: false, report_available: false,
    error_code: null, rows: null, unique_skus: null,
    duplicate_sku_rows: null, active: null, inactive: null, status_unknown: null,
    report_created_at: null, report_age_hours: null, fresh_within_24h: false,
    snapshot_complete: false, safe_for_missing_sku_classification: false };
  try {
    if (!["IT", "DE", "FR", "ES"].includes(market)) throw new Error("amazon_stream_invalid_marketplace");
    if (!bearer) throw new Error("amazon_stream_bearer_missing");
    const handoff = await fetchImpl(BASE + "/internal/amazon/report-link?marketplace=" + market, {
      method: "GET", headers: { Authorization: "Bearer " + bearer, Accept: "application/json" },
      redirect: "manual", signal: AbortSignal.timeout(110000)
    });
    result.http_status = handoff.status;
    if (handoff.status !== 307) {
      let body = {};
      try { body = await handoff.json(); } catch {}
      result.error_code = safeError(body.error);
      return result;
    }
    if (handoff.headers.get("X-Amazon-Report-Marketplace") !== market ||
        handoff.headers.get("X-Amazon-Report-Type") !== "GET_MERCHANT_LISTINGS_ALL_DATA") {
      throw new Error("amazon_stream_report_identity_mismatch");
    }
    const signedLocation = handoff.headers.get("location");
    if (!signedLocation) throw new Error("amazon_link_location_missing");
    let signedUrl;
    try { signedUrl = new URL(signedLocation); }
    catch { throw new Error("amazon_link_location_invalid"); }
    if (signedUrl.protocol !== "https:" || !signedUrl.hostname.endsWith(".amazonaws.com") ||
        signedUrl.username || signedUrl.password) throw new Error("amazon_link_location_host_invalid");
    // Never forward the backend bearer token to Amazon S3.
    const response = await fetchImpl(signedUrl.toString(), {
      method: "GET", headers: { Accept: "application/octet-stream" },
      redirect: "error", signal: AbortSignal.timeout(110000)
    });
    result.http_status = response.status;
    if (!response.ok) throw new Error("amazon_link_s3_http_" + response.status);
    const raw = await readLimited(response.body, MAX_RAW);
    const rawDeclared = response.headers.get("content-length");
    if (rawDeclared && /^\d+$/.test(rawDeclared) && Number(rawDeclared) !== raw.length) {
      throw new Error("amazon_stream_length_mismatch");
    }
    const compression = handoff.headers.get("X-Amazon-Report-Compression") || "NONE";
    let decoded = raw;
    let compressionVerified = true;
    if (compression === "GZIP") {
      if (raw[0] === 0x1f && raw[1] === 0x8b) {
        try { decoded = gunzipSync(raw, { maxOutputLength: MAX_DECODED }); }
        catch { throw new Error("amazon_stream_gzip_failed"); }
      } else compressionVerified = false;
    } else if (compression !== "NONE") throw new Error("amazon_stream_unsupported_compression");
    if (decoded.length > MAX_DECODED) throw new Error("amazon_stream_decoded_too_large");
    const counts = parseReport(decoded);
    const date = handoff.headers.get("X-Amazon-Report-Created-At") || "";
    const parsedDate = date ? Date.parse(date) : NaN;
    const ageHours = Number.isFinite(parsedDate) ? (Date.now() - parsedDate) / 3600000 : null;
    const recent = ageHours !== null && ageHours >= 0 && ageHours <= 24;
    return { ...result, http_status: 200, ok: true, report_available: true,
      error_code: null, rows: counts.rows, unique_skus: counts.unique_skus,
      duplicate_sku_rows: counts.duplicate_sku_rows, active: counts.active,
      inactive: counts.inactive, status_unknown: counts.status_unknown,
      encoding_verified: counts.encoding_verified,
      status_column_present: counts.status_column_present,
      compression_verified: compressionVerified,
      report_created_at: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : null,
      report_age_hours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      fresh_within_24h: recent, snapshot_complete: true,
      safe_for_missing_sku_classification: recent && compressionVerified &&
        counts.encoding_verified && counts.status_column_present && counts.duplicate_sku_rows === 0
    };
  } catch (error) {
    result.error_code = safeError(error instanceof Error ? error.message : null);
    return result;
  }
}
