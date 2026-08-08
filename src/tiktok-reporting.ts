type JsonObject = Record<string, unknown>;

type KVNamespaceLike = {
  get(key: string): Promise<string | null>;
};

type TikTokReportingEnv = {
  DAILY_PULSE_ACCESS_TOKEN?: string;
  TIKTOK_ACCESS_TOKEN?: string;
  TIKTOK_ADVERTISER_ID?: string;
  SHOPIFY_TOKENS_KV?: KVNamespaceLike;
  [key: string]: unknown;
};

type StoredTikTokAuthorization = {
  access_token: string;
  advertiser_id?: string;
  advertiser_ids?: string[];
  scope?: string[];
  updated_at?: string;
};

type TikTokAuthorization = {
  accessToken: string;
  advertiserId: string;
  source: "kv_oauth" | "environment";
  scopeCount: number;
};

const API_BASE = "https://business-api.tiktok.com/open_api/v1.3";
const TOKEN_KEY = "mare-business:tiktok:authorization";
const RICH_METRICS = [
  "campaign_name",
  "spend",
  "impressions",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "conversion",
  "cost_per_conversion",
  "complete_payment",
  "cost_per_complete_payment",
  "complete_payment_roas",
  "value_per_complete_payment",
  "total_complete_payment_rate",
] as const;
const CORE_METRICS = [
  "spend",
  "impressions",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "conversion",
  "cost_per_conversion",
] as const;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function list(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonObject => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
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

function timingSafeEqualText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function isAuthorized(request: Request, env: TikTokReportingEnv): boolean {
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  return timingSafeEqualText(supplied, normalize(env.DAILY_PULSE_ACCESS_TOKEN));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
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

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function timeframeRange(timeframe: string): { start: string; end: string; timeframe: string } {
  const today = dateInRome();
  const yesterday = addDays(today, -1);
  if (timeframe === "last_7_days") return { start: addDays(yesterday, -6), end: yesterday, timeframe };
  return { start: yesterday, end: yesterday, timeframe: "yesterday" };
}

async function loadStoredAuthorization(env: TikTokReportingEnv): Promise<StoredTikTokAuthorization | null> {
  if (!env.SHOPIFY_TOKENS_KV) return null;
  const raw = await env.SHOPIFY_TOKENS_KV.get(TOKEN_KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as StoredTikTokAuthorization;
    return normalize(stored.access_token) ? stored : null;
  } catch {
    return null;
  }
}

async function resolveAuthorization(env: TikTokReportingEnv): Promise<TikTokAuthorization> {
  const stored = await loadStoredAuthorization(env);
  if (stored) {
    const advertiserId = normalize(stored.advertiser_id)
      || normalize(env.TIKTOK_ADVERTISER_ID)
      || normalize(stored.advertiser_ids?.[0]);
    if (!/^\d{5,40}$/.test(advertiserId)) throw new Error("tiktok_advertiser_id_missing");
    return {
      accessToken: normalize(stored.access_token),
      advertiserId,
      source: "kv_oauth",
      scopeCount: Array.isArray(stored.scope) ? stored.scope.length : 0,
    };
  }

  const accessToken = normalize(env.TIKTOK_ACCESS_TOKEN);
  const advertiserId = normalize(env.TIKTOK_ADVERTISER_ID);
  if (!accessToken) throw new Error("tiktok_not_authorized");
  if (!/^\d{5,40}$/.test(advertiserId)) throw new Error("tiktok_advertiser_id_missing");
  return { accessToken, advertiserId, source: "environment", scopeCount: 0 };
}

async function apiGet(path: string, auth: TikTokAuthorization, params: JsonObject): Promise<JsonObject> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { "Access-Token": auth.accessToken, Accept: "application/json" },
  });
  let body: JsonObject;
  try {
    body = await response.json() as JsonObject;
  } catch {
    throw new Error(`tiktok_reporting_invalid_response:${response.status}`);
  }
  if (!response.ok || Number(body.code) !== 0) {
    throw new Error(`tiktok_reporting_api_error:${normalize(body.message) || response.status}`);
  }
  return body;
}

async function reportPage(
  auth: TikTokAuthorization,
  range: { start: string; end: string },
  daily: boolean,
  metrics: readonly string[],
  page: number,
): Promise<JsonObject> {
  return apiGet("/report/integrated/get/", auth, {
    advertiser_id: auth.advertiserId,
    report_type: "BASIC",
    service_type: "AUCTION",
    data_level: "AUCTION_CAMPAIGN",
    dimensions: daily ? ["campaign_id", "stat_time_day"] : ["campaign_id"],
    metrics: [...metrics],
    start_date: range.start,
    end_date: range.end,
    page,
    page_size: 1000,
    enable_total_metrics: true,
  });
}

function totalPages(body: JsonObject): number {
  const pageInfo = object(object(body.data).page_info);
  const parsed = numberValue(pageInfo.total_page);
  return Math.max(1, Math.min(20, Math.trunc(parsed || 1)));
}

async function fetchAllRows(
  auth: TikTokAuthorization,
  range: { start: string; end: string },
  daily: boolean,
): Promise<{ rows: JsonObject[]; fallback: boolean; apiTotalMetrics: JsonObject }> {
  let metrics: readonly string[] = RICH_METRICS;
  let first: JsonObject;
  let fallback = false;
  try {
    first = await reportPage(auth, range, daily, metrics, 1);
  } catch {
    metrics = CORE_METRICS;
    fallback = true;
    first = await reportPage(auth, range, daily, metrics, 1);
  }

  const firstData = object(first.data);
  const collected = list(firstData.list);
  const pages = totalPages(first);
  for (let page = 2; page <= pages; page += 1) {
    const current = await reportPage(auth, range, daily, metrics, page);
    collected.push(...list(object(current.data).list));
  }
  return {
    rows: collected,
    fallback,
    apiTotalMetrics: object(firstData.total_metrics),
  };
}

function normalizeRows(rows: JsonObject[]): JsonObject[] {
  return rows.map((row) => {
    const dimensions = object(row.dimensions);
    const metrics = object(row.metrics);
    return {
      campaign_id: dimensions.campaign_id || null,
      date: dimensions.stat_time_day || null,
      campaign_name: metrics.campaign_name || null,
      metrics,
    };
  });
}

function summarizeRows(rows: JsonObject[]): JsonObject {
  let spend = 0;
  let impressions = 0;
  let clicks = 0;
  let conversions = 0;
  let purchases = 0;
  let purchaseValue = 0;
  let roasValueFromRows = 0;

  for (const row of rows) {
    const metrics = object(row.metrics);
    const rowSpend = numberValue(metrics.spend);
    spend += rowSpend;
    impressions += numberValue(metrics.impressions);
    clicks += numberValue(metrics.clicks);
    conversions += numberValue(metrics.conversion);
    const rowPurchases = numberValue(metrics.complete_payment);
    purchases += rowPurchases;
    const explicitValue = numberValue(metrics.total_complete_payment_rate);
    const averageValue = numberValue(metrics.value_per_complete_payment);
    purchaseValue += explicitValue || (rowPurchases > 0 && averageValue > 0 ? rowPurchases * averageValue : 0);
    const rowRoas = numberValue(metrics.complete_payment_roas);
    if (rowSpend > 0 && rowRoas > 0) roasValueFromRows += rowSpend * rowRoas;
  }

  if (purchaseValue <= 0 && roasValueFromRows > 0) purchaseValue = roasValueFromRows;

  return {
    spend: round(spend),
    impressions,
    clicks,
    ctr: impressions > 0 ? round((clicks / impressions) * 100, 4) : 0,
    cpc: clicks > 0 ? round(spend / clicks, 4) : 0,
    cpm: impressions > 0 ? round((spend / impressions) * 1000, 4) : 0,
    conversions,
    purchases,
    purchase_value: round(purchaseValue),
    purchase_roas: spend > 0 ? round(purchaseValue / spend, 4) : 0,
    cpa_purchase: purchases > 0 ? round(spend / purchases, 4) : 0,
    cpa_conversion: conversions > 0 ? round(spend / conversions, 4) : 0,
  };
}

export async function handleTikTokReportingRequest(request: Request, env: TikTokReportingEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/internal/tiktok-ads/report" && url.pathname !== "/internal/tiktok-ads/status") return null;
  if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

  let auth: TikTokAuthorization;
  try {
    auth = await resolveAuthorization(env);
  } catch (error) {
    return jsonResponse({
      ok: false,
      provider: "tiktok_ads",
      authorized: false,
      error: error instanceof Error ? error.message : "tiktok_not_authorized",
      raw_secret_values_exposed: false,
    }, 409);
  }

  if (url.pathname === "/internal/tiktok-ads/status") {
    return jsonResponse({
      ok: true,
      provider: "tiktok_ads",
      authorized: true,
      advertiser_id_present: true,
      authorization_source: auth.source,
      scope_count: auth.scopeCount,
      raw_secret_values_exposed: false,
      retrieved_at: new Date().toISOString(),
    });
  }

  const timeframe = normalize(url.searchParams.get("timeframe")) || "yesterday";
  const range = timeframeRange(timeframe);
  const daily = url.searchParams.get("daily") === "1" || range.timeframe === "last_7_days";

  try {
    const report = await fetchAllRows(auth, range, daily);
    const rows = normalizeRows(report.rows);
    return jsonResponse({
      ok: true,
      provider: "tiktok_ads",
      read_only: true,
      authorized: true,
      timeframe: range.timeframe,
      time_range: { start: range.start, end: range.end },
      data_level: "AUCTION_CAMPAIGN",
      totals: summarizeRows(rows),
      rows,
      api_total_metrics: report.apiTotalMetrics,
      fallback_core_metrics_used: report.fallback,
      limitations: [
        "TikTok Ads conversions and ROAS are platform-attributed and must not be added to Shopify revenue.",
        "The purchase-value field is normalized from TikTok website purchase metrics when available.",
      ],
      raw_secret_values_exposed: false,
      retrieved_at: new Date().toISOString(),
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      provider: "tiktok_ads",
      authorized: true,
      error: error instanceof Error ? error.message : "tiktok_reporting_failed",
      raw_secret_values_exposed: false,
    }, 502);
  }
}
