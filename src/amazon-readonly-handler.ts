import { readAmazonMarketplaceParticipations } from "./amazon-readonly";
import { readAmazonListingReportMetadata } from "./amazon-listing-reports";
import { readAmazonLatestListingReportSummary } from "./amazon-listing-report-summary";
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
  if (!["/internal/amazon/marketplaces", "/internal/amazon/listing-reports", "/internal/amazon/listing-report-summary"].includes(url.pathname)) return null;
  if (request.method !== "GET") return respond({ ok: false, error: "method_not_allowed" }, 405);
  const header = request.headers.get("Authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!equal(bearer, env.DAILY_PULSE_ACCESS_TOKEN || "")) return respond({ ok: false, error: "unauthorized" }, 401);
  try {
    const market = url.searchParams.get("marketplace") || "";
    if (url.pathname !== "/internal/amazon/marketplaces" && !Object.hasOwn(AMAZON_EU_MARKETPLACES, market)) return respond({ ok: false, error: "invalid_marketplace" }, 400);
    const result = url.pathname === "/internal/amazon/marketplaces"
      ? await readAmazonMarketplaceParticipations(env)
      : url.pathname === "/internal/amazon/listing-reports"
      ? await readAmazonListingReportMetadata(env, market as keyof typeof AMAZON_EU_MARKETPLACES)
      : await readAmazonLatestListingReportSummary(env, market as keyof typeof AMAZON_EU_MARKETPLACES);
    return respond({ ok: true, service: "amazon_spapi", read_only: true, result });
  } catch (error) {
    const code = error instanceof Error ? error.message : "amazon_read_failed";
    return respond({ ok: false, error: code }, 502);
  }
}
