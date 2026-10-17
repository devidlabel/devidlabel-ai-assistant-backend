import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces";

const API_ROOT = "https://sellingpartnerapi-eu.amazon.com";
const TYPE = "GET_MERCHANT_LISTINGS_ALL_DATA";
const RETRY_DELAYS_MS = [2500, 10000, 20000];

/** Amazon metadata only, with bounded retries of throttled GETs. */
async function readJsonWithRetry(url: string, token: string, stage: string): Promise<any> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { method: "GET", headers: {
        "x-amz-access-token": token, Accept: "application/json"
      } });
    } catch { throw new Error("amazon_link_" + stage + "_network_error"); }
    if (response.status === 429 && attempt < RETRY_DELAYS_MS.length) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
      continue;
    }
    if (!response.ok) throw new Error("amazon_link_" + stage + "_http_" + response.status);
    try { return await response.json(); }
    catch { throw new Error("amazon_link_" + stage + "_invalid_json"); }
  }
  throw new Error("amazon_link_" + stage + "_retries_exhausted");
}

/**
 * Issue a 307 only to an authorized internal caller. Never fetch S3 from
 * Cloudflare; the client must follow the signed Location WITHOUT bearer auth.
 * The signed URL is never logged or placed into an artifact.
 */
export async function redirectAmazonLatestListingReport(
  env: AmazonCredentials,
  market: keyof typeof AMAZON_EU_MARKETPLACES
): Promise<Response> {
  const id = AMAZON_EU_MARKETPLACES[market];
  if (!id) throw new Error("amazon_invalid_marketplace");
  const token = await getAmazonAccessToken(env);
  const listUrl = new URL(API_ROOT + "/reports/2021-06-30/reports");
  listUrl.searchParams.set("reportTypes", TYPE);
  listUrl.searchParams.set("marketplaceIds", id);
  listUrl.searchParams.set("pageSize", "20");
  const reports = await readJsonWithRetry(listUrl.toString(), token, "reports") as {
    reports?: Array<{ reportType?: string; processingStatus?: string; reportDocumentId?: string; createdTime?: string }>;
  };
  const completed = (reports.reports || [])
    .filter(item => item.reportType === TYPE && item.processingStatus === "DONE" && item.reportDocumentId)
    .sort((a, b) => (b.createdTime || "").localeCompare(a.createdTime || ""));
  if (!completed.length) throw new Error("amazon_link_no_completed_report");
  const selected = completed[0];
  const document = await readJsonWithRetry(
    API_ROOT + "/reports/2021-06-30/documents/" + encodeURIComponent(selected.reportDocumentId!),
    token, "document"
  ) as { url?: string; compressionAlgorithm?: string };
  if (!document.url) throw new Error("amazon_link_url_missing");
  let signedUrl: URL;
  try { signedUrl = new URL(document.url); }
  catch { throw new Error("amazon_link_url_invalid"); }
  if (signedUrl.protocol !== "https:" || !signedUrl.hostname.endsWith(".amazonaws.com")
      || signedUrl.username || signedUrl.password) throw new Error("amazon_link_host_invalid");
  if (document.compressionAlgorithm && document.compressionAlgorithm !== "GZIP") {
    throw new Error("amazon_link_compression_unsupported");
  }
  const created = selected.createdTime && Number.isFinite(Date.parse(selected.createdTime))
    ? new Date(selected.createdTime).toISOString() : "";
  return new Response(null, { status: 307, headers: {
    Location: signedUrl.toString(),
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Amazon-Report-Marketplace": market,
    "X-Amazon-Report-Type": TYPE,
    "X-Amazon-Report-Compression": document.compressionAlgorithm || "NONE",
    "X-Amazon-Report-Created-At": created
  } });
}
