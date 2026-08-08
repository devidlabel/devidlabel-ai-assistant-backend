import { handleDailyPulseRequest as handleBaseDailyPulseRequest } from "./daily-pulse";
import { handleGa4ReportingRequest } from "./ga4-reporting";
import { handleSearchConsoleReportingRequest } from "./search-console-reporting";
import { handleTikTokReportingRequest } from "./tiktok-reporting";
import { tiktokSafeAuthorizationStatus } from "./mare-business-tiktok-safe";
import { youtubeAuthorizationStatus } from "./mare-business-youtube";
import { handleYouTubeReportingRequest } from "./youtube-reporting";

type JsonObject = Record<string, unknown>;
type OrganicPulseEnv = {
  GOOGLE_ADS_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_ORGANIC_REPORT_ACCESS_TOKEN?: string;
  GOOGLE_ADS_REPORT_ACCESS_TOKEN?: string;
  DAILY_PULSE_ACCESS_TOKEN?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
  SEARCH_CONSOLE_SITE_URL?: string;
  GA4_PROPERTY_ID?: string;
  TIKTOK_ACCESS_TOKEN?: string;
  TIKTOK_ADVERTISER_ID?: string;
  TIKTOK_APP_ID?: string;
  TIKTOK_APP_SECRET?: string;
  YOUTUBE_CLIENT_ID?: string;
  YOUTUBE_CLIENT_SECRET?: string;
  YOUTUBE_REDIRECT_URI?: string;
  SHOPIFY_TOKENS_KV?: unknown;
  [key: string]: unknown;
};

type SourceResult = {
  ok: boolean;
  status: number;
  body: JsonObject;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function reportToken(env: OrganicPulseEnv): string {
  return normalize(env.GOOGLE_ORGANIC_REPORT_ACCESS_TOKEN)
    || normalize(env.GOOGLE_ADS_REPORT_ACCESS_TOKEN)
    || normalize(env.DAILY_PULSE_ACCESS_TOKEN)
    || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function rows(value: unknown, limit = 100): JsonObject[] {
  const table = asObject(value);
  return Array.isArray(table.rows)
    ? (table.rows as unknown[]).filter((row): row is JsonObject => Boolean(row && typeof row === "object" && !Array.isArray(row))).slice(0, limit)
    : [];
}

function objectRows(value: unknown, limit = 100): JsonObject[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((row): row is JsonObject => Boolean(row && typeof row === "object" && !Array.isArray(row))).slice(0, limit)
    : [];
}

function firstMetricRow(value: unknown): JsonObject {
  const table = asObject(value);
  const totals = Array.isArray(table.totals) ? table.totals : [];
  const tableRows = Array.isArray(table.rows) ? table.rows : [];
  const candidate = totals[0] || tableRows[0];
  return asObject(candidate);
}

async function parseResponse(response: Response | null): Promise<SourceResult> {
  if (!response) return { ok: false, status: 404, body: { ok: false, error: "handler_not_found" } };
  let body: JsonObject = {};
  try {
    body = await response.json() as JsonObject;
  } catch {
    body = { ok: false, error: "invalid_json_response" };
  }
  return { ok: response.ok && body.ok !== false, status: response.status, body };
}

async function invoke(
  handler: (request: Request, env: any) => Promise<Response | null>,
  path: string,
  request: Request,
  env: OrganicPulseEnv,
): Promise<SourceResult> {
  const suppliedAuthorization = request.headers.get("Authorization") || "";
  const fallbackToken = reportToken(env);
  const authorization = suppliedAuthorization || (fallbackToken ? `Bearer ${fallbackToken}` : "");
  if (!authorization) return { ok: false, status: 503, body: { ok: false, error: "internal_report_token_not_configured" } };
  try {
    return parseResponse(await handler(new Request(`https://internal.local${path}`, {
      method: "GET",
      headers: { Authorization: authorization },
    }), env));
  } catch (error) {
    return {
      ok: false,
      status: 500,
      body: { ok: false, error: error instanceof Error ? error.message : "internal_handler_error" },
    };
  }
}

function ga4Summary(source: SourceResult): JsonObject {
  if (!source.ok) return {
    ok: false,
    status: source.status,
    error: source.body.message || source.body.error || "unavailable",
  };
  return {
    ok: true,
    property_id: source.body.property_id || null,
    timeframe: source.body.timeframe || null,
    overview: firstMetricRow(source.body.overview),
    daily: rows(source.body.daily, 31),
    landing_pages: rows(source.body.landing_pages, 50),
    source_medium: rows(source.body.source_medium, 50),
    campaigns: rows(source.body.campaigns, 50),
    devices: rows(source.body.devices, 20),
    countries: rows(source.body.countries, 30),
    ecommerce_funnel: rows(source.body.ecommerce_funnel, 20),
  };
}

function searchConsoleSummary(source: SourceResult): JsonObject {
  if (!source.ok) return {
    ok: false,
    status: source.status,
    error: source.body.message || source.body.error || "unavailable",
  };
  return {
    ok: true,
    site_url: source.body.site_url || null,
    timeframe: source.body.timeframe || null,
    totals: source.body.totals || {},
    daily: rows(source.body.daily, 31),
    queries: rows(source.body.queries, 150),
    pages: rows(source.body.pages, 150),
    devices: rows(source.body.devices, 20),
    countries: rows(source.body.countries, 50),
    limitations: source.body.limitations || [],
  };
}

function tiktokSummary(source: SourceResult): JsonObject {
  if (!source.ok) return {
    ok: false,
    status: source.status,
    error: source.body.message || source.body.error || "unavailable",
  };
  return {
    ok: true,
    provider: "tiktok_ads",
    read_only: source.body.read_only !== false,
    timeframe: source.body.timeframe || null,
    time_range: source.body.time_range || null,
    totals: source.body.totals || {},
    campaigns: objectRows(source.body.rows, 250),
    fallback_core_metrics_used: source.body.fallback_core_metrics_used === true,
    limitations: source.body.limitations || [],
  };
}

function youtubeSectionData(source: SourceResult, name: string): JsonObject {
  const sections = asObject(source.body.sections);
  const section = asObject(sections[name]);
  return asObject(section.data);
}

function youtubeSummary(source: SourceResult): JsonObject {
  if (!source.ok) return {
    ok: false,
    status: source.status,
    error: source.body.message || source.body.error || "unavailable",
  };
  const channelData = youtubeSectionData(source, "channel");
  const summaryData = youtubeSectionData(source, "summary");
  const videosData = youtubeSectionData(source, "videos");
  const trafficData = youtubeSectionData(source, "traffic_sources");
  const searchData = youtubeSectionData(source, "search_terms");
  return {
    ok: true,
    provider: "youtube",
    read_only: source.body.read_only !== false,
    days: source.body.days || null,
    section_counts: source.body.section_counts || {},
    authorization: source.body.status || {},
    channel: channelData.channel || {},
    summary: summaryData.summary || {},
    top_videos: objectRows(videosData.videos, 25),
    traffic_sources: objectRows(trafficData.traffic_sources, 30),
    search_terms: objectRows(searchData.search_terms, 50),
    retrieved_at: source.body.retrieved_at || null,
  };
}

function attachGa4(windowValue: unknown, source: SourceResult): JsonObject {
  const window = asObject(windowValue);
  const sources = asObject(window.sources);
  const sourceStatus = asObject(window.source_status);
  return {
    ...window,
    sources: {
      ...sources,
      ga4: ga4Summary(source),
    },
    source_status: {
      ...sourceStatus,
      ga4: { ok: source.ok, status: source.status },
    },
  };
}

function combinedWithTikTok(windowValue: JsonObject, tiktok: JsonObject): JsonObject {
  const combined = asObject(windowValue.combined);
  const tiktokTotals = asObject(tiktok.totals);
  const metaSpend = numberValue(combined.meta_spend);
  const googleSpend = numberValue(combined.google_spend);
  const tiktokSpend = numberValue(tiktokTotals.spend);
  const legacyPaidSpend = numberValue(combined.paid_media_spend_meta_google) || metaSpend + googleSpend;
  const totalPaidSpend = legacyPaidSpend + tiktokSpend;
  const ecommerceRevenue = numberValue(combined.shopify_ecommerce_net_merchandise_revenue)
    || numberValue(combined.shopify_net_merchandise_revenue);
  const grossMarginBeforeAds = numberValue(combined.gross_margin_proxy_before_adv_fulfillment_and_fees)
    || numberValue(combined.contribution_proxy_before_adv_and_fulfillment);
  const mer = totalPaidSpend > 0 ? round(ecommerceRevenue / totalPaidSpend, 4) : 0;
  return {
    ...combined,
    tiktok_spend: round(tiktokSpend),
    paid_media_spend_meta_google_tiktok: round(totalPaidSpend),
    ecommerce_mer_meta_google_tiktok: mer,
    mer_meta_google_tiktok: mer,
    gross_margin_proxy_after_paid_media_before_fulfillment_and_fees: round(grossMarginBeforeAds - totalPaidSpend),
    gross_margin_proxy_after_meta_google_tiktok_before_fulfillment_and_fees: round(grossMarginBeforeAds - totalPaidSpend),
    contribution_proxy_after_meta_google_tiktok_before_fulfillment: round(grossMarginBeforeAds - totalPaidSpend),
    paid_media_primary_scope: "meta_google_tiktok",
  };
}

function attachTikTok(windowValue: unknown, source: SourceResult): JsonObject {
  const window = asObject(windowValue);
  const sources = asObject(window.sources);
  const sourceStatus = asObject(window.source_status);
  const tiktok = tiktokSummary(source);
  const withSource: JsonObject = {
    ...window,
    sources: {
      ...sources,
      tiktok_ads: tiktok,
    },
    source_status: {
      ...sourceStatus,
      tiktok_ads: { ok: source.ok, status: source.status },
    },
  };
  return {
    ...withSource,
    combined: combinedWithTikTok(withSource, tiktok),
  };
}

async function augmentHealth(base: Response, env: OrganicPulseEnv): Promise<Response> {
  const parsed = await parseResponse(base);
  if (!parsed.ok) return jsonResponse(parsed.body, parsed.status);
  const configured = asObject(parsed.body.configured);
  const [tiktokStatus, youtubeStatus] = await Promise.all([
    tiktokSafeAuthorizationStatus(env as any).catch(() => ({ authorized: false })),
    youtubeAuthorizationStatus(env as any).catch(() => ({ authorized: false })),
  ]);
  return jsonResponse({
    ...parsed.body,
    configured: {
      ...configured,
      search_console: Boolean(normalize(env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON) && normalize(env.SEARCH_CONSOLE_SITE_URL)),
      ga4: Boolean(normalize(env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON) && normalize(env.GA4_PROPERTY_ID)),
      tiktok_ads: asObject(tiktokStatus).authorized === true,
      youtube: asObject(youtubeStatus).authorized === true,
    },
  });
}

async function augmentReport(base: Response, request: Request, env: OrganicPulseEnv): Promise<Response> {
  const parsed = await parseResponse(base);
  if (!parsed.ok) return jsonResponse(parsed.body, parsed.status);

  const [
    ga4Yesterday,
    ga4Last7Days,
    searchConsoleLast7Days,
    tiktokYesterday,
    tiktokLast7Days,
    youtubeLast7Days,
    youtubeLast28Days,
  ] = await Promise.all([
    invoke(handleGa4ReportingRequest, "/internal/ga4/report?timeframe=yesterday", request, env),
    invoke(handleGa4ReportingRequest, "/internal/ga4/report?timeframe=last_7_days", request, env),
    invoke(handleSearchConsoleReportingRequest, "/internal/search-console/report?timeframe=last_7_days", request, env),
    invoke(handleTikTokReportingRequest, "/internal/tiktok-ads/report?timeframe=yesterday&daily=0", request, env),
    invoke(handleTikTokReportingRequest, "/internal/tiktok-ads/report?timeframe=last_7_days&daily=1", request, env),
    invoke(handleYouTubeReportingRequest, "/internal/youtube/report?days=7", request, env),
    invoke(handleYouTubeReportingRequest, "/internal/youtube/report?days=28", request, env),
  ]);

  const yesterday = attachGa4(attachTikTok(parsed.body.yesterday, tiktokYesterday), ga4Yesterday);
  const last7Days = attachGa4(attachTikTok(parsed.body.last_7_days, tiktokLast7Days), ga4Last7Days);
  const notes = Array.isArray(parsed.body.notes) ? parsed.body.notes : [];

  return jsonResponse({
    ...parsed.body,
    yesterday,
    last_7_days: last7Days,
    search_console: {
      last_7_days: searchConsoleSummary(searchConsoleLast7Days),
      source_status: { ok: searchConsoleLast7Days.ok, status: searchConsoleLast7Days.status },
    },
    youtube: {
      last_7_days: youtubeSummary(youtubeLast7Days),
      last_28_days: youtubeSummary(youtubeLast28Days),
      source_status: {
        last_7_days: { ok: youtubeLast7Days.ok, status: youtubeLast7Days.status },
        last_28_days: { ok: youtubeLast28Days.ok, status: youtubeLast28Days.status },
      },
    },
    notes: [
      ...notes,
      "GA4 is measurement-platform data and is reconciled separately from Shopify source-of-truth commerce revenue.",
      "Search Console uses finalized data with a default three-day reporting lag.",
      "Primary paid-media spend and MER now include Meta + Google + TikTok Ads; legacy Meta+Google fields remain for backward compatibility.",
      "TikTok Ads conversions, purchase value and ROAS are platform-attributed and must not be added to Shopify revenue as incremental revenue.",
      "YouTube Content Intelligence is read-only and includes rolling 7/28-day performance, top videos, traffic sources and search terms.",
    ],
  });
}

export async function handleDailyPulseRequest(request: Request, env: OrganicPulseEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/internal/daily-pulse")) return null;

  const base = await handleBaseDailyPulseRequest(request, env as any);
  if (!base) return null;
  if (url.pathname === "/internal/daily-pulse/health") return augmentHealth(base, env);
  if (url.pathname === "/internal/daily-pulse/report" && request.method === "GET") return augmentReport(base, request, env);
  return base;
}
