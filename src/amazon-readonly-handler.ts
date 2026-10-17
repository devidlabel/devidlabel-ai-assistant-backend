import { readAmazonMarketplaceParticipations } from "./amazon-readonly";
import { readAmazonListingReportMetadata } from "./amazon-listing-reports";
import { readAmazonLatestListingReportSummary } from "./amazon-listing-report-summary";
import { streamAmazonLatestListingsReport } from "./amazon-report-stream";
import { redirectAmazonLatestListingReport } from "./amazon-report-link";
import { readAmazonShopifyEligiblePage } from "./amazon-shopify-eligible-page";
import { readAmazonCatalogByEAN } from "./amazon-catalog-ean";
import { readAmazonCatalogByEANBatch } from "./amazon-catalog-ean-batch";
import { readAmazonCatalogByUPCBatch } from "./amazon-catalog-upc-batch";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces";
import type { AmazonCredentials } from "./amazon-auth";

type Env = AmazonCredentials & { DAILY_PULSE_ACCESS_TOKEN?: string };
function equal(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
export async function handleAmazonReadonlyRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!["/internal/amazon/marketplaces", "/internal/amazon/listing-reports", "/internal/amazon/listing-report-summary", "/internal/amazon/report-stream", "/internal/amazon/report-link", "/internal/amazon/shopify-eligible-page", "/internal/amazon/catalog-ean", "/internal/amazon/catalog-eans", "/internal/amazon/catalog-upcs"].includes(url.pathname)) return null;
  if (request.method !== "GET") return respond({ ok: false, error: "method_not_allowed" }, 405);
  const header = request.headers.get("Authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!equal(bearer, env.DAILY_PULSE_ACCESS_TOKEN || "")) return respond({ ok: false, error: "unauthorized" }, 401);
  try {
    if (url.pathname === "/internal/amazon/shopify-eligible-page") {
      const after = url.searchParams.get("after");
      return respond(await readAmazonShopifyEligiblePage(env as any, after));
    }
    const market = url.searchParams.get("marketplace") || "";
    if (url.pathname !== "/internal/amazon/marketplaces" && !Object.hasOwn(AMAZON_EU_MARKETPLACES, market)) return respond({ ok: false, error: "invalid_marketplace" }, 400);
    if (url.pathname === "/internal/amazon/catalog-upcs") {
      const raw = url.searchParams.get("upcs") || "";
      if (!/^\d{12}(,\d{12}){0,19}$/.test(raw)) {
        return respond({ ok: false, error: "invalid_upcs" }, 400);
      }
      return respond({ ok: true, read_only: true,
        result: await readAmazonCatalogByUPCBatch(env, market as keyof typeof AMAZON_EU_MARKETPLACES, raw.split(",")) });
    }
    if (url.pathname === "/internal/amazon/catalog-eans") {
      const raw = url.searchParams.get("eans") || "";
      if (!/^\d{13}(,\d{13}){0,19}$/.test(raw)) {
        return respond({ ok: false, error: "invalid_eans" }, 400);
      }
      return respond({ ok: true, read_only: true,
        result: await readAmazonCatalogByEANBatch(env, market as keyof typeof AMAZON_EU_MARKETPLACES, raw.split(",")) });
    }
    if (url.pathname === "/internal/amazon/catalog-ean") {
      const ean = url.searchParams.get("ean") || "";
      if (!/^\d{13}$/.test(ean)) return respond({ ok: false, error: "invalid_ean" }, 400);
      return respond({ ok: true, read_only: true, result: await readAmazonCatalogByEAN(env, market as keyof typeof AMAZON_EU_MARKETPLACES, ean) });
    }
    if (url.pathname === "/internal/amazon/report-link") return await redirectAmazonLatestListingReport(env, market as keyof typeof AMAZON_EU_MARKETPLACES);
    if (url.pathname === "/internal/amazon/report-stream") return await streamAmazonLatestListingsReport(env, market as keyof typeof AMAZON_EU_MARKETPLACES);
    const result = url.pathname === "/internal/amazon/marketplaces"
      ? await readAmazonMarketplaceParticipations(env)
      : url.pathname === "/internal/amazon/listing-reports"
      ? await readAmazonListingReportMetadata(env, market as keyof typeof AMAZON_EU_MARKETPLACES)
      : await readAmazonLatestListingReportSummary(env, market as keyof typeof AMAZON_EU_MARKETPLACES);
    return respond({ ok: true, service: "amazon_spapi", read_only: true, result });
  } catch (error) {
    const rawCode = error instanceof Error ? error.message : "amazon_read_failed";
    const code = /^amazon_[a-z0-9_]+$/.test(rawCode) ? rawCode : "amazon_unclassified_error";
    return respond({ ok: false, error: code }, 502);
  }
}
