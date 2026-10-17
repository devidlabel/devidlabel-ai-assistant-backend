import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces";

const API_ROOT = "https://sellingpartnerapi-eu.amazon.com";
const TYPE = "GET_MERCHANT_LISTINGS_ALL_DATA";

/**
 * Returns a streaming, authenticated, no-cache response. Does not buffer,
 * parse, persist or log Amazon listing data on the Cloudflare Worker.
 */
export async function streamAmazonLatestListingsReport(
  env: AmazonCredentials,
  market: keyof typeof AMAZON_EU_MARKETPLACES
): Promise<Response> {
  const marketplaceId = AMAZON_EU_MARKETPLACES[market];
  if (!marketplaceId) throw new Error("amazon_invalid_marketplace");
  const token = await getAmazonAccessToken(env);
  const url = new URL(API_ROOT + "/reports/2021-06-30/reports");
  url.searchParams.set("reportTypes", TYPE);
  url.searchParams.set("marketplaceIds", marketplaceId);
  url.searchParams.set("pageSize", "20");
  let reportsResponse: Response;
  try {
    reportsResponse = await fetch(url.toString(), { method: "GET", headers: { "x-amz-access-token": token, Accept: "application/json" } });
  } catch { throw new Error("amazon_stream_reports_network_error"); }
  if (!reportsResponse.ok) throw new Error("amazon_stream_reports_http_" + reportsResponse.status);
  let reportBody: { reports?: Array<{ reportType?: string; processingStatus?: string; reportDocumentId?: string; createdTime?: string }> };
  try { reportBody = await reportsResponse.json(); } catch { throw new Error("amazon_stream_reports_invalid_json"); }
  const available = (reportBody.reports || [])
    .filter(r => r.reportType === TYPE && r.processingStatus === "DONE" && r.reportDocumentId)
    .sort((a, b) => (b.createdTime || "").localeCompare(a.createdTime || ""));
  if (!available.length) throw new Error("amazon_stream_no_completed_report");
  const selected = available[0];
  let documentResponse: Response;
  try {
    documentResponse = await fetch(API_ROOT + "/reports/2021-06-30/documents/" + encodeURIComponent(selected.reportDocumentId!), {
      method: "GET", headers: { "x-amz-access-token": token, Accept: "application/json" }
    });
  } catch { throw new Error("amazon_stream_document_network_error"); }
  if (!documentResponse.ok) throw new Error("amazon_stream_document_http_" + documentResponse.status);
  let document: { url?: string; compressionAlgorithm?: string };
  try { document = await documentResponse.json(); } catch { throw new Error("amazon_stream_document_invalid_json"); }
  if (!document.url) throw new Error("amazon_stream_document_url_missing");
  let signedUrl: URL;
  try { signedUrl = new URL(document.url); } catch { throw new Error("amazon_stream_document_url_invalid"); }
  if (signedUrl.protocol !== "https:" || !signedUrl.hostname.endsWith(".amazonaws.com") || signedUrl.username || signedUrl.password) {
    throw new Error("amazon_stream_document_host_invalid");
  }
  if (document.compressionAlgorithm && document.compressionAlgorithm !== "GZIP") {
    throw new Error("amazon_stream_unsupported_compression");
  }
  let download: Response;
  try {
    download = await fetch(signedUrl.toString(), { method: "GET", redirect: "error" });
  } catch { throw new Error("amazon_stream_download_network_error"); }
  if (!download.ok || !download.body) throw new Error("amazon_stream_download_http_" + download.status);
  let createdAt = "";
  if (selected.createdTime && Number.isFinite(Date.parse(selected.createdTime))) {
    createdAt = new Date(selected.createdTime).toISOString();
  }
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Amazon-Report-Marketplace": market,
    "X-Amazon-Report-Type": TYPE,
    "X-Amazon-Report-Compression": document.compressionAlgorithm || "NONE",
    "X-Amazon-Report-Created-At": createdAt
  });
  const declaredLength = download.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength)) headers.set("X-Amazon-Report-Raw-Length", declaredLength);
  return new Response(download.body, { status: 200, headers });
}
