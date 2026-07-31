import { handleGoogleAdsReportingRequest } from "./google-ads-reporting";
import { handleKlaviyoReportingRequest } from "./klaviyo-reporting";
import { handleMetaReportingRequest } from "./meta-reporting";
import { handleShopifyReportingRequest } from "./shopify-reporting";

type DailyPulseEnv = {
  DAILY_PULSE_ACCESS_TOKEN?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
  KLAVIYO_PRIVATE_API_KEY?: string;
  KLAVIYO_CONVERSION_METRIC_ID?: string;
  SHOPIFY_REPORT_ACCESS_TOKEN?: string;
  META_REPORT_ACCESS_TOKEN?: string;
  META_ADS_ACCESS_TOKEN?: string;
  META_AD_ACCOUNT_ID?: string;
  META_GRAPH_API_VERSION?: string;
  META_WRITE_ACCESS_TOKEN?: string;
  META_PIXEL_ID?: string;
  GOOGLE_ADS_REPORT_ACCESS_TOKEN?: string;
  GOOGLE_ADS_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
  GOOGLE_ADS_REFRESH_TOKEN?: string;
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  GOOGLE_ADS_CUSTOMER_ID?: string;
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;
  GOOGLE_ADS_API_VERSION?: string;
  [key: string]: unknown;
};

type JsonObject = Record<string, unknown>;
type Handler = (request: Request, env: any) => Promise<Response | null>;

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

function timingSafeEqualText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

function pulseToken(env: DailyPulseEnv): string {
  return normalize(env.DAILY_PULSE_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);
}

function isAuthorized(request: Request, env: DailyPulseEnv): boolean {
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  return timingSafeEqualText(supplied, pulseToken(env));
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

function dateInRome(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateOnlyToUtc(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

function addDays(date: string, days: number): string {
  const parsed = dateOnlyToUtc(date);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function timeframeRange(timeframe: "yesterday" | "last_7_days"): { start: string; end: string } {
  const today = dateInRome();
  const end = addDays(today, -1);
  return timeframe === "yesterday" ? { start: end, end } : { start: addDays(end, -6), end };
}

async function invoke(
  handler: Handler,
  path: string,
  token: string,
  env: DailyPulseEnv,
): Promise<SourceResult> {
  if (!token) return { ok: false, status: 503, body: { ok: false, error: "internal_report_token_not_configured" } };
  try {
    const response = await handler(new Request(`https://internal.local${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }), env);
    if (!response) return { ok: false, status: 404, body: { ok: false, error: "handler_not_found" } };
    let body: JsonObject = {};
    try {
      body = await response.json() as JsonObject;
    } catch {
      body = { ok: false, error: "invalid_json_response" };
    }
    return { ok: response.ok && body.ok !== false, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      body: { ok: false, error: error instanceof Error ? error.message : "internal_handler_error" },
    };
  }
}

function shopifySummary(source: SourceResult): JsonObject {
  if (!source.ok) return { ok: false, status: source.status, error: source.body.error || "unavailable" };
  return {
    ok: true,
    timeframe: source.body.timeframe || null,
    metrics: source.body.metrics || {},
    breakdowns: source.body.breakdowns || {},
    warnings: source.body.warnings || [],
  };
}

function metaSummary(source: SourceResult): JsonObject {
  if (!source.ok) return { ok: false, status: source.status, error: source.body.error || "unavailable" };
  const rows = Array.isArray(source.body.rows) ? source.body.rows as JsonObject[] : [];
  const totals = {
    spend: 0,
    impressions: 0,
    reach: 0,
    clicks: 0,
    link_clicks: 0,
    purchases: 0,
    purchase_value: 0,
  };
  const campaigns: JsonObject[] = [];
  for (const row of rows) {
    const metrics = row.metrics && typeof row.metrics === "object" ? row.metrics as JsonObject : {};
    totals.spend += numberValue(metrics.spend);
    totals.impressions += numberValue(metrics.impressions);
    totals.reach += numberValue(metrics.reach);
    totals.clicks += numberValue(metrics.clicks);
    totals.link_clicks += numberValue(metrics.link_clicks);
    totals.purchases += numberValue(metrics.purchases);
    totals.purchase_value += numberValue(metrics.purchase_value);
    campaigns.push({
      date_start: row.date_start || "",
      date_stop: row.date_stop || "",
      campaign_id: row.campaign_id || "",
      campaign_name: row.campaign_name || "",
      metrics,
    });
  }
  return {
    ok: true,
    time_range: source.body.time_range || null,
    totals: {
      spend: round(totals.spend),
      impressions: totals.impressions,
      reach: totals.reach,
      clicks: totals.clicks,
      link_clicks: totals.link_clicks,
      purchases: totals.purchases,
      purchase_value: round(totals.purchase_value),
      purchase_roas: totals.spend > 0 ? round(totals.purchase_value / totals.spend, 4) : 0,
      cpa: totals.purchases > 0 ? round(totals.spend / totals.purchases) : 0,
    },
    campaigns,
  };
}

function googleSummary(source: SourceResult): JsonObject {
  if (!source.ok) return { ok: false, status: source.status, error: source.body.error || "unavailable" };
  return {
    ok: true,
    time_range: source.body.time_range || null,
    totals: source.body.totals || {},
    campaigns: source.body.rows || [],
  };
}

function klaviyoStatistics(results: unknown[]): JsonObject {
  const keys = [
    "recipients", "delivered", "opens_unique", "clicks_unique", "conversions",
    "conversion_uniques", "conversion_value", "bounced", "unsubscribes", "spam_complaints",
  ];
  const totals: JsonObject = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const entry of results) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as JsonObject;
    const statistics = row.statistics && typeof row.statistics === "object" ? row.statistics as JsonObject : row;
    for (const key of keys) totals[key] = numberValue(totals[key]) + numberValue(statistics[key]);
  }
  return totals;
}

function klaviyoSummary(source: SourceResult): JsonObject {
  if (!source.ok) return { ok: false, status: source.status, error: source.body.error || "unavailable" };
  const campaigns = Array.isArray(source.body.campaigns) ? source.body.campaigns as unknown[] : [];
  const flows = Array.isArray(source.body.flows) ? source.body.flows as unknown[] : [];
  return {
    ok: true,
    timeframe: source.body.timeframe || null,
    campaign_totals: klaviyoStatistics(campaigns),
    flow_totals: klaviyoStatistics(flows),
    campaigns,
    flows,
  };
}

function combinedKpis(sources: { shopify: JsonObject; meta: JsonObject; google: JsonObject }): JsonObject {
  const shopifyMetrics = sources.shopify.metrics && typeof sources.shopify.metrics === "object" ? sources.shopify.metrics as JsonObject : {};
  const metaTotals = sources.meta.totals && typeof sources.meta.totals === "object" ? sources.meta.totals as JsonObject : {};
  const googleTotals = sources.google.totals && typeof sources.google.totals === "object" ? sources.google.totals as JsonObject : {};

  const revenue = numberValue(shopifyMetrics.net_merchandise_revenue);
  const contributionBeforeAds = numberValue(shopifyMetrics.contribution_margin_proxy_before_adv_and_fulfillment);
  const metaSpend = numberValue(metaTotals.spend);
  const googleSpend = numberValue(googleTotals.spend);
  const paidSpend = metaSpend + googleSpend;
  return {
    shopify_net_merchandise_revenue: round(revenue),
    meta_spend: round(metaSpend),
    google_spend: round(googleSpend),
    paid_media_spend_meta_google: round(paidSpend),
    mer_meta_google: paidSpend > 0 ? round(revenue / paidSpend, 4) : 0,
    contribution_proxy_before_adv_and_fulfillment: round(contributionBeforeAds),
    contribution_proxy_after_meta_google_before_fulfillment: round(contributionBeforeAds - paidSpend),
  };
}

async function buildWindow(timeframe: "yesterday" | "last_7_days", env: DailyPulseEnv): Promise<JsonObject> {
  const range = timeframeRange(timeframe);
  const commonQuery = `timeframe=${timeframe}`;
  const metaQuery = `${commonQuery}&level=campaign&daily=${timeframe === "last_7_days" ? "1" : "0"}`;

  const shopifyToken = normalize(env.SHOPIFY_REPORT_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);
  const klaviyoToken = normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);
  const metaToken = normalize(env.META_REPORT_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);
  const googleToken = normalize(env.GOOGLE_ADS_REPORT_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);

  const [shopifyRaw, metaRaw, googleRaw, klaviyoRaw] = await Promise.all([
    invoke(handleShopifyReportingRequest, `/internal/shopify/report?${commonQuery}`, shopifyToken, {
      ...env,
      SHOPIFY_REPORT_ACCESS_TOKEN: shopifyToken,
    }),
    invoke(handleMetaReportingRequest, `/internal/meta/report?${metaQuery}`, metaToken, env),
    invoke(handleGoogleAdsReportingRequest, `/internal/google-ads/report?${commonQuery}`, googleToken, env),
    invoke(handleKlaviyoReportingRequest,
      timeframe === "last_7_days"
        ? `/internal/klaviyo/report?timeframe=last_7_days`
        : `/internal/klaviyo/report?timeframe=yesterday`,
      klaviyoToken,
      env),
  ]);

  const sources = {
    shopify: shopifySummary(shopifyRaw),
    meta: metaSummary(metaRaw),
    google: googleSummary(googleRaw),
    klaviyo: klaviyoSummary(klaviyoRaw),
  };
  return {
    timeframe,
    range,
    sources,
    combined: combinedKpis(sources),
    source_status: {
      shopify: { ok: shopifyRaw.ok, status: shopifyRaw.status },
      meta: { ok: metaRaw.ok, status: metaRaw.status },
      google: { ok: googleRaw.ok, status: googleRaw.status },
      klaviyo: { ok: klaviyoRaw.ok, status: klaviyoRaw.status },
    },
  };
}

export async function handleDailyPulseRequest(request: Request, env: DailyPulseEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/internal/daily-pulse")) return null;

  if (url.pathname === "/internal/daily-pulse/health") {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    const googleServiceAccount = Boolean(normalize(env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON));
    const googleUserOauth = Boolean(normalize(env.GOOGLE_ADS_REFRESH_TOKEN)
      && normalize(env.GOOGLE_ADS_CLIENT_ID)
      && normalize(env.GOOGLE_ADS_CLIENT_SECRET));
    return jsonResponse({
      ok: true,
      service: "daily_pulse",
      configured: {
        access_token: Boolean(pulseToken(env)),
        shopify: Boolean(normalize(env.SHOPIFY_REPORT_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN)),
        meta: Boolean(normalize(env.META_ADS_ACCESS_TOKEN)),
        google: Boolean((googleServiceAccount || googleUserOauth) && normalize(env.GOOGLE_ADS_DEVELOPER_TOKEN)),
        klaviyo: Boolean(normalize(env.KLAVIYO_PRIVATE_API_KEY)),
      },
    });
  }

  if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  if (url.pathname !== "/internal/daily-pulse/report") return jsonResponse({ ok: false, error: "not_found" }, 404);

  const [yesterday, last7Days] = await Promise.all([
    buildWindow("yesterday", env),
    buildWindow("last_7_days", env),
  ]);
  return jsonResponse({
    ok: true,
    service: "daily_pulse",
    generated_at: new Date().toISOString(),
    timezone: "Europe/Rome",
    yesterday,
    last_7_days: last7Days,
    notes: [
      "Shopify COGS uses current InventoryItem.unitCost as a proxy, not historical unit cost at sale time.",
      "Combined paid-media MER currently includes Meta + Google only.",
      "Klaviyo attribution remains platform-reported and should not be added to Shopify revenue as incremental revenue.",
    ],
  });
}
