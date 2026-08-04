import { googleServiceAccountAccessToken, parseGoogleServiceAccount } from "./google-service-account.js";

const GA4_BASE = "https://analyticsdata.googleapis.com/v1beta";
const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

type Ga4Env = {
  GOOGLE_ADS_SERVICE_ACCOUNT_JSON?: string;
  GA4_PROPERTY_ID?: string;
  GOOGLE_ORGANIC_REPORT_ACCESS_TOKEN?: string;
  GOOGLE_ADS_REPORT_ACCESS_TOKEN?: string;
  DAILY_PULSE_ACCESS_TOKEN?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
};

type JsonObject = Record<string, unknown>;
type TimeRange = { since: string; until: string; preset: string };
type Ga4Table = {
  dimensions: string[];
  metrics: string[];
  rows: Array<Record<string, string | number>>;
  row_count: number;
  totals: Array<Record<string, string | number>>;
  property_quota: unknown;
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

function digits(value: unknown): string {
  return normalize(value).replace(/\D/g, "");
}

function timingSafeEqualText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

function reportToken(env: Ga4Env): string {
  return normalize(env.GOOGLE_ORGANIC_REPORT_ACCESS_TOKEN)
    || normalize(env.GOOGLE_ADS_REPORT_ACCESS_TOKEN)
    || normalize(env.DAILY_PULSE_ACCESS_TOKEN)
    || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);
}

function isAuthorized(request: Request, env: Ga4Env): boolean {
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  return timingSafeEqualText(supplied, reportToken(env));
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
  const preset = normalize(url.searchParams.get("timeframe")) || "last_7_days";
  if (preset === "custom") {
    const since = normalize(url.searchParams.get("start"));
    const until = normalize(url.searchParams.get("end"));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until) || since > until) return null;
    return { since, until, preset };
  }
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = addDays(today, -1);
  if (preset === "yesterday") return { since: isoDate(yesterday), until: isoDate(yesterday), preset };
  if (preset === "last_7_days") return { since: isoDate(addDays(yesterday, -6)), until: isoDate(yesterday), preset };
  if (preset === "last_14_days") return { since: isoDate(addDays(yesterday, -13)), until: isoDate(yesterday), preset };
  if (preset === "last_30_days") return { since: isoDate(addDays(yesterday, -29)), until: isoDate(yesterday), preset };
  if (preset === "month_to_yesterday") {
    const start = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), 1));
    return { since: isoDate(start), until: isoDate(yesterday), preset };
  }
  return null;
}

function numberOrText(value: unknown): string | number {
  const text = normalize(value);
  if (!text) return "";
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : text;
}

function safeTable(payload: JsonObject): Ga4Table {
  const dimensionHeaders = Array.isArray(payload.dimensionHeaders) ? payload.dimensionHeaders : [];
  const metricHeaders = Array.isArray(payload.metricHeaders) ? payload.metricHeaders : [];
  const dimensions = dimensionHeaders.map((header) => header && typeof header === "object" && !Array.isArray(header) ? normalize((header as JsonObject).name) : "");
  const metrics = metricHeaders.map((header) => header && typeof header === "object" && !Array.isArray(header) ? normalize((header as JsonObject).name) : "");

  const parseRow = (raw: unknown): Record<string, string | number> => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const row = raw as JsonObject;
    const dimensionValues = Array.isArray(row.dimensionValues) ? row.dimensionValues : [];
    const metricValues = Array.isArray(row.metricValues) ? row.metricValues : [];
    const output: Record<string, string | number> = {};
    dimensions.forEach((name, index) => {
      const value = dimensionValues[index];
      output[name || `dimension_${index}`] = value && typeof value === "object" && !Array.isArray(value) ? normalize((value as JsonObject).value) : "";
    });
    metrics.forEach((name, index) => {
      const value = metricValues[index];
      output[name || `metric_${index}`] = value && typeof value === "object" && !Array.isArray(value) ? numberOrText((value as JsonObject).value) : "";
    });
    return output;
  };

  const rows = Array.isArray(payload.rows) ? payload.rows.map(parseRow) : [];
  const totals = Array.isArray(payload.totals) ? payload.totals.map(parseRow) : [];
  return {
    dimensions,
    metrics,
    rows,
    row_count: typeof payload.rowCount === "number" ? payload.rowCount : Number(payload.rowCount || rows.length),
    totals,
    property_quota: payload.propertyQuota || null,
  };
}

async function ga4Fetch(url: string, accessToken: string, body: JsonObject): Promise<JsonObject> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as JsonObject;
  if (!response.ok) {
    const message = typeof payload.error === "object" && payload.error && !Array.isArray(payload.error)
      ? normalize((payload.error as JsonObject).message)
      : "";
    const error = new Error(message || `GA4 Data API request failed (${response.status})`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return payload;
}

async function runReport(propertyId: string, accessToken: string, range: TimeRange, body: JsonObject): Promise<Ga4Table> {
  const payload = await ga4Fetch(`${GA4_BASE}/properties/${propertyId}:runReport`, accessToken, {
    dateRanges: [{ startDate: range.since, endDate: range.until }],
    keepEmptyRows: false,
    returnPropertyQuota: true,
    ...body,
  });
  return safeTable(payload);
}

function dimensions(...names: string[]): JsonObject[] {
  return names.map((name) => ({ name }));
}

function metrics(...names: string[]): JsonObject[] {
  return names.map((name) => ({ name }));
}

export async function handleGa4ReportingRequest(request: Request, env: Ga4Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/internal/ga4/")) return null;

  const propertyId = digits(env.GA4_PROPERTY_ID);
  const configured = Boolean(parseGoogleServiceAccount(env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON) && propertyId);

  if (path === "/internal/ga4/health") {
    if (request.method !== "GET") return jsonResponse({ ok: false, source: "ga4", message: "Metodo non supportato." }, 405);
    return jsonResponse({
      ok: true,
      source: "ga4",
      configured,
      auth_mode: configured ? "service_account" : "unconfigured",
      property_id: propertyId,
      report_token_configured: Boolean(reportToken(env)),
    });
  }

  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, source: "ga4", message: "Non autorizzato." }, 401);
  if (!configured) return jsonResponse({ ok: false, source: "ga4", message: "Configurazione GA4 incompleta." }, 503);
  if (request.method !== "GET") return jsonResponse({ ok: false, source: "ga4", message: "Metodo non supportato." }, 405);

  try {
    const accessToken = await googleServiceAccountAccessToken(env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON, GA4_SCOPE);

    if (path === "/internal/ga4/realtime") {
      const payload = await ga4Fetch(`${GA4_BASE}/properties/${propertyId}:runRealtimeReport`, accessToken, {
        dimensions: dimensions("country"),
        metrics: metrics("activeUsers", "eventCount"),
        limit: "100",
        returnPropertyQuota: true,
      });
      return jsonResponse({
        ok: true,
        source: "ga4",
        property_id: propertyId,
        generated_at: new Date().toISOString(),
        realtime: safeTable(payload),
      });
    }

    if (path === "/internal/ga4/report") {
      const range = parseTimeRange(url);
      if (!range) return jsonResponse({ ok: false, source: "ga4", message: "Intervallo data non valido." }, 400);

      const overview = await runReport(propertyId, accessToken, range, {
        metrics: metrics("activeUsers", "newUsers", "sessions", "engagedSessions", "engagementRate", "screenPageViews", "eventCount", "ecommercePurchases", "purchaseRevenue", "totalRevenue"),
        metricAggregations: ["TOTAL"],
        limit: "1",
      });
      const daily = await runReport(propertyId, accessToken, range, {
        dimensions: dimensions("date"),
        metrics: metrics("activeUsers", "sessions", "engagedSessions", "ecommercePurchases", "purchaseRevenue"),
        orderBys: [{ dimension: { dimensionName: "date" } }],
        limit: "500",
      });
      const landing_pages = await runReport(propertyId, accessToken, range, {
        dimensions: dimensions("landingPagePlusQueryString"),
        metrics: metrics("sessions", "activeUsers", "engagementRate", "ecommercePurchases", "purchaseRevenue"),
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: "250",
      });
      const source_medium = await runReport(propertyId, accessToken, range, {
        dimensions: dimensions("sessionSourceMedium"),
        metrics: metrics("sessions", "activeUsers", "ecommercePurchases", "purchaseRevenue"),
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: "250",
      });
      const campaigns = await runReport(propertyId, accessToken, range, {
        dimensions: dimensions("sessionCampaignName"),
        metrics: metrics("sessions", "activeUsers", "ecommercePurchases", "purchaseRevenue"),
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: "250",
      });
      const devices = await runReport(propertyId, accessToken, range, {
        dimensions: dimensions("deviceCategory"),
        metrics: metrics("sessions", "activeUsers", "ecommercePurchases", "purchaseRevenue"),
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: "20",
      });
      const countries = await runReport(propertyId, accessToken, range, {
        dimensions: dimensions("country"),
        metrics: metrics("sessions", "activeUsers", "ecommercePurchases", "purchaseRevenue"),
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: "100",
      });
      const ecommerce_funnel = await runReport(propertyId, accessToken, range, {
        dimensions: dimensions("eventName"),
        metrics: metrics("eventCount", "activeUsers"),
        dimensionFilter: {
          filter: {
            fieldName: "eventName",
            inListFilter: { values: ["view_item", "add_to_cart", "begin_checkout", "purchase"], caseSensitive: true },
          },
        },
        orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
        limit: "20",
      });

      return jsonResponse({
        ok: true,
        source: "ga4",
        property_id: propertyId,
        timeframe: range,
        generated_at: new Date().toISOString(),
        overview,
        daily,
        landing_pages,
        source_medium,
        campaigns,
        devices,
        countries,
        ecommerce_funnel,
      });
    }

    return jsonResponse({ ok: false, source: "ga4", message: "Endpoint non trovato." }, 404);
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error && typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : 502;
    return jsonResponse({
      ok: false,
      source: "ga4",
      message: error instanceof Error ? error.message : "Errore GA4.",
    }, status >= 400 && status < 600 ? status : 502);
  }
}
