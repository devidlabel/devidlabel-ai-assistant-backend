const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ADS_BASE = "https://googleads.googleapis.com";
const DEFAULT_GOOGLE_ADS_API_VERSION = "v24";

type GoogleAdsReportingEnv = {
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
  GOOGLE_ADS_REFRESH_TOKEN?: string;
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  GOOGLE_ADS_CUSTOMER_ID?: string;
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;
  GOOGLE_ADS_API_VERSION?: string;
  GOOGLE_ADS_REPORT_ACCESS_TOKEN?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
};

type JsonObject = Record<string, unknown>;

type TimeRange = { since: string; until: string };

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

function digits(value: unknown): string {
  return normalize(value).replace(/-/g, "").replace(/\s/g, "");
}

function timingSafeEqualText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

function reportToken(env: GoogleAdsReportingEnv): string {
  return normalize(env.GOOGLE_ADS_REPORT_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);
}

function isAuthorized(request: Request, env: GoogleAdsReportingEnv): boolean {
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  return timingSafeEqualText(supplied, reportToken(env));
}

function apiVersion(env: GoogleAdsReportingEnv): string {
  const configured = normalize(env.GOOGLE_ADS_API_VERSION);
  return /^v\d+$/.test(configured) ? configured : DEFAULT_GOOGLE_ADS_API_VERSION;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function parseTimeRange(url: URL): TimeRange | null {
  const preset = (url.searchParams.get("timeframe") || "yesterday").trim();
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = addDays(today, -1);

  if (preset === "custom") {
    const since = (url.searchParams.get("start") || "").trim();
    const until = (url.searchParams.get("end") || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until) || since > until) return null;
    return { since, until };
  }
  if (preset === "yesterday") return { since: isoDate(yesterday), until: isoDate(yesterday) };
  if (preset === "last_7_days") return { since: isoDate(addDays(yesterday, -6)), until: isoDate(yesterday) };
  if (preset === "last_14_days") return { since: isoDate(addDays(yesterday, -13)), until: isoDate(yesterday) };
  if (preset === "month_to_yesterday") {
    const start = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), 1));
    return { since: isoDate(start), until: isoDate(yesterday) };
  }
  return null;
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function micros(value: unknown): number {
  return numberValue(value) / 1_000_000;
}

async function oauthAccessToken(env: GoogleAdsReportingEnv): Promise<string> {
  const body = new URLSearchParams({
    client_id: normalize(env.GOOGLE_ADS_CLIENT_ID),
    client_secret: normalize(env.GOOGLE_ADS_CLIENT_SECRET),
    refresh_token: normalize(env.GOOGLE_ADS_REFRESH_TOKEN),
    grant_type: "refresh_token",
  });
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json() as JsonObject;
  if (!response.ok || typeof payload.access_token !== "string") {
    const error = new Error(`Google OAuth refresh failed (${response.status})`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return payload.access_token;
}

async function googleAdsSearchStream(env: GoogleAdsReportingEnv, query: string): Promise<JsonObject[]> {
  const customerId = digits(env.GOOGLE_ADS_CUSTOMER_ID);
  const accessToken = await oauthAccessToken(env);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": normalize(env.GOOGLE_ADS_DEVELOPER_TOKEN),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const loginCustomerId = digits(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;

  const response = await fetch(`${GOOGLE_ADS_BASE}/${apiVersion(env)}/customers/${customerId}/googleAds:searchStream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });
  const payload = await response.json() as unknown;
  if (!response.ok) {
    const error = new Error(`Google Ads API request failed (${response.status})`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  const batches = Array.isArray(payload) ? payload : [payload];
  const rows: JsonObject[] = [];
  for (const batch of batches) {
    if (!batch || typeof batch !== "object" || Array.isArray(batch)) continue;
    const results = (batch as JsonObject).results;
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      if (result && typeof result === "object" && !Array.isArray(result)) rows.push(result as JsonObject);
    }
  }
  return rows;
}

function safeCampaignRow(row: JsonObject): JsonObject {
  const campaign = row.campaign && typeof row.campaign === "object" ? row.campaign as JsonObject : {};
  const metrics = row.metrics && typeof row.metrics === "object" ? row.metrics as JsonObject : {};
  const segments = row.segments && typeof row.segments === "object" ? row.segments as JsonObject : {};
  const cost = micros(metrics.costMicros);
  const conversionValue = numberValue(metrics.conversionsValue);
  return {
    date: typeof segments.date === "string" ? segments.date : "",
    campaign_id: typeof campaign.id === "string" ? campaign.id : String(campaign.id || ""),
    campaign_name: typeof campaign.name === "string" ? campaign.name : "",
    status: typeof campaign.status === "string" ? campaign.status : "",
    channel_type: typeof campaign.advertisingChannelType === "string" ? campaign.advertisingChannelType : "",
    metrics: {
      spend: Math.round(cost * 100) / 100,
      impressions: numberValue(metrics.impressions),
      clicks: numberValue(metrics.clicks),
      ctr: numberValue(metrics.ctr),
      average_cpc: Math.round(micros(metrics.averageCpc) * 100) / 100,
      conversions: numberValue(metrics.conversions),
      conversion_value: conversionValue,
      all_conversions: numberValue(metrics.allConversions),
      all_conversion_value: numberValue(metrics.allConversionsValue),
      conversion_roas: cost > 0 ? conversionValue / cost : 0,
    },
  };
}

function aggregate(rows: JsonObject[]): JsonObject {
  const totals = {
    spend: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    conversion_value: 0,
    all_conversions: 0,
    all_conversion_value: 0,
  };
  for (const row of rows) {
    const metrics = row.metrics && typeof row.metrics === "object" ? row.metrics as JsonObject : {};
    totals.spend += numberValue(metrics.spend);
    totals.impressions += numberValue(metrics.impressions);
    totals.clicks += numberValue(metrics.clicks);
    totals.conversions += numberValue(metrics.conversions);
    totals.conversion_value += numberValue(metrics.conversion_value);
    totals.all_conversions += numberValue(metrics.all_conversions);
    totals.all_conversion_value += numberValue(metrics.all_conversion_value);
  }
  return {
    ...totals,
    ctr: totals.impressions > 0 ? totals.clicks / totals.impressions * 100 : 0,
    cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0,
    conversion_roas: totals.spend > 0 ? totals.conversion_value / totals.spend : 0,
  };
}

function safeError(error: unknown): JsonObject {
  const candidate = error as Error & { status?: number };
  return {
    message: candidate?.message || "Unknown Google Ads reporting error",
    ...(typeof candidate?.status === "number" ? { status: candidate.status } : {}),
  };
}

export async function handleGoogleAdsReportingRequest(request: Request, env: GoogleAdsReportingEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/internal/google-ads/")) return null;

  if (url.pathname === "/internal/google-ads/health") {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    return jsonResponse({
      ok: true,
      service: "google_ads_reporting",
      api_version: apiVersion(env),
      configured: {
        client_id: Boolean(normalize(env.GOOGLE_ADS_CLIENT_ID)),
        client_secret: Boolean(normalize(env.GOOGLE_ADS_CLIENT_SECRET)),
        refresh_token: Boolean(normalize(env.GOOGLE_ADS_REFRESH_TOKEN)),
        developer_token: Boolean(normalize(env.GOOGLE_ADS_DEVELOPER_TOKEN)),
        customer_id: /^\d{5,20}$/.test(digits(env.GOOGLE_ADS_CUSTOMER_ID)),
        report_access_token: Boolean(reportToken(env)),
      },
    });
  }

  if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  if (url.pathname !== "/internal/google-ads/report") return jsonResponse({ ok: false, error: "not_found" }, 404);

  const customerId = digits(env.GOOGLE_ADS_CUSTOMER_ID);
  if (!customerId || !normalize(env.GOOGLE_ADS_CLIENT_ID) || !normalize(env.GOOGLE_ADS_CLIENT_SECRET)
      || !normalize(env.GOOGLE_ADS_REFRESH_TOKEN) || !normalize(env.GOOGLE_ADS_DEVELOPER_TOKEN)) {
    return jsonResponse({ ok: false, error: "google_ads_not_configured" }, 503);
  }
  const range = parseTimeRange(url);
  if (!range) return jsonResponse({ ok: false, error: "invalid_timeframe" }, 400);

  const query = `
    SELECT
      segments.date,
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc,
      metrics.conversions,
      metrics.conversions_value,
      metrics.all_conversions,
      metrics.all_conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${range.since}' AND '${range.until}'
    ORDER BY segments.date DESC, metrics.cost_micros DESC
  `.trim();

  try {
    const rawRows = await googleAdsSearchStream(env, query);
    const rows = rawRows.map(safeCampaignRow);
    return jsonResponse({
      ok: true,
      service: "google_ads_reporting",
      api_version: apiVersion(env),
      generated_at: new Date().toISOString(),
      customer_id: customerId,
      time_range: range,
      totals: aggregate(rows),
      rows,
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: "google_ads_reporting_failed", detail: safeError(error) }, 502);
  }
}
