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

/**
 * Parse TSV at byte level so non-UTF8 characters in human-readable title and
 * description columns cannot corrupt an otherwise exact seller-SKU match.
 * Never treat invalid seller-SKU bytes as verified identities.
 */
function parseReport(data) {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const permissive = new TextDecoder("utf-8", { fatal: false });
  const allText = permissive.decode(data);
  const documentUtf8Verified = !allText.includes("\uFFFD");
  const utf16le = data[0] === 0xff && data[1] === 0xfe;
  const utf16be = data[0] === 0xfe && data[1] === 0xff;
  let lines;
  let allCells;
  if (utf16le || utf16be) {
    let text;
    try {
      text = new TextDecoder(utf16le ? "utf-16le" : "utf-16be", { fatal: true }).decode(data);
    } catch {
      throw new Error("amazon_stream_utf16_decode_failed");
    }
    lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
    allCells = lines.map(line => line.split("\t").map(cell => ({ decoded: cell, valid: true })));
  } else {
    // 0x09 TAB and 0x0A LF are never UTF-8 continuation bytes.
    // Read only identifying columns with a strict decoder.
    const readCells = line => {
      const result = [];
      let offset = 0;
      while (offset <= line.length) {
        const next = line.indexOf(0x09, offset);
        const part = line.subarray(offset, next < 0 ? line.length : next);
        let decoded;
        let valid = true;
        try { decoded = utf8.decode(part); }
        catch {
          valid = false;
          // Legacy report bytes are retained as non-identifying placeholders,
          // never declared comparable with Shopify.
          decoded = "NON_UTF8_" + part.toString("hex");
        }
        result.push({ decoded, valid });
        if (next < 0) break;
        offset = next + 1;
      }
      return result;
    };
    const rawLines = [];
    let pos = 0;
    for (let i = 0; i <= data.length; i++) {
      if (i !== data.length && data[i] !== 0x0a) continue;
      let part = data.subarray(pos, i);
      if (part.length && part[part.length - 1] === 0x0d) part = part.subarray(0, part.length - 1);
      if (part.length) rawLines.push(part);
      pos = i + 1;
    }
    allCells = rawLines.map(readCells);
  }
  const headings = (allCells.shift() || []).map(x => x.decoded.replace(/^\uFEFF/, "").trim().toLowerCase());
  const skuIdx = ["seller-sku", "seller_sku", "sku"].map(s => headings.indexOf(s)).find(i => i >= 0) ?? -1;
  if (skuIdx < 0) throw new Error("amazon_stream_sku_header_missing");
  const statusIdx = ["status", "listing-status", "listing_status"].map(s => headings.indexOf(s)).find(i => i >= 0) ?? -1;
  const seen = new Set();
  let rows = 0, duplicates = 0, active = 0, inactive = 0, unknown = 0;
  let invalidSkuBytes = 0, invalidStatusBytes = 0;
  for (const cols of allCells) {
    const sku = cols[skuIdx];
    if (!sku || !sku.decoded) throw new Error("amazon_stream_blank_sku");
    rows++;
    if (!sku.valid) invalidSkuBytes++;
    if (seen.has(sku.decoded)) duplicates++;
    seen.add(sku.decoded);
    const statusCell = statusIdx >= 0 ? cols[statusIdx] : null;
    if (statusCell && !statusCell.valid) invalidStatusBytes++;
    const status = (statusCell?.decoded || "").trim().toUpperCase();
    if (status === "ACTIVE") active++;
    else if (["INACTIVE", "INCOMPLETE", "SUPPRESSED"].includes(status)) inactive++;
    else unknown++;
  }
  const skuEncodingVerified = invalidSkuBytes === 0;
  const statusEncodingVerified = invalidStatusBytes === 0;
  return {
    rows, unique_skus: seen.size, duplicate_sku_rows: duplicates,
    active, inactive, status_unknown: unknown,
    encoding_verified: skuEncodingVerified && statusEncodingVerified,
    document_utf8_verified: utf16le || utf16be ? null : documentUtf8Verified,
    sku_encoding_verified: skuEncodingVerified,
    invalid_sku_encoding_rows: invalidSkuBytes,
    invalid_status_encoding_rows: invalidStatusBytes,
    status_column_present: statusIdx >= 0
  };
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
      document_utf8_verified: counts.document_utf8_verified,
      sku_encoding_verified: counts.sku_encoding_verified,
      invalid_sku_encoding_rows: counts.invalid_sku_encoding_rows,
      invalid_status_encoding_rows: counts.invalid_status_encoding_rows,
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
