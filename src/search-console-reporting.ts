import { googleServiceAccountAccessToken, parseGoogleServiceAccount } from "./google-service-account.js";

const SEARCH_CONSOLE_BASE = "https://www.googleapis.com/webmasters/v3";
const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const SEARCH_CONSOLE_DATA_LAG_DAYS = 3;

type SearchConsoleEnv = {
  GOOGLE_ADS_SERVICE_ACCOUNT_JSON?: string;
  SEARCH_CONSOLE_SITE_URL?: string;
  GOOGLE_ORGANIC_REPORT_ACCESS_TOKEN?: string;
  GOOGLE_ADS_REPORT_ACCESS_TOKEN?: string;
  DAILY_PULSE_ACCESS_TOKEN?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
};

type JsonObject = Record<string, unknown>;
type TimeRange = { since: string; until: string; preset: string; lag_days: number };
type SearchDimension = "date" | "query" | "page" | "device" | "country";
type SearchRow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };

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

function reportToken(env: SearchConsoleEnv): string {
  return normalize(env.GOOGLE_ORGANIC_REPORT_ACCESS_TOKEN)
    || normalize(env.GOOGLE_ADS_REPORT_ACCESS_TOKEN)
    || normalize(env.DAILY_PULSE_ACCESS_TOKEN)
    || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);
}

function isAuthorized(request: Request, env: SearchConsoleEnv): boolean {
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
  const preset = normalize(url.searchParams.get("timeframe")) || "last_28_days";
  if (preset === "custom") {
    const since = normalize(url.searchParams.get("start"));
    const until = normalize(url.searchParams.get("end"));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until) || since > until) return null;
    return { since, until, preset, lag_days: 0 };
  }
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = addDays(today, -SEARCH_CONSOLE_DATA_LAG_DAYS);
  if (preset === "last_7_days") return { since: isoDate(addDays(end, -6)), until: isoDate(end), preset, lag_days: SEARCH_CONSOLE_DATA_LAG_DAYS };
  if (preset === "last_28_days") return { since: isoDate(addDays(end, -27)), until: isoDate(end), preset, lag_days: SEARCH_CONSOLE_DATA_LAG_DAYS };
  if (preset === "last_90_days") return { since: isoDate(addDays(end, -89)), until: isoDate(end), preset, lag_days: SEARCH_CONSOLE_DATA_LAG_DAYS };
  if (preset === "month_to_date") {
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    return { since: isoDate(start), until: isoDate(end), preset, lag_days: SEARCH_CONSOLE_DATA_LAG_DAYS };
  }
  return null;
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeRows(payload: JsonObject): SearchRow[] {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  return rows.flatMap((raw): SearchRow[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const row = raw as JsonObject;
    return [{
      keys: Array.isArray(row.keys) ? row.keys.map((key) => String(key ?? "")) : [],
      clicks: numberValue(row.clicks),
      impressions: numberValue(row.impressions),
      ctr: numberValue(row.ctr),
      position: numberValue(row.position),
    }];
  });
}

async function searchConsoleFetch(url: string, accessToken: string, init?: RequestInit): Promise<JsonObject> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });
  const payload = await response.json() as JsonObject;
  if (!response.ok) {
    const message = typeof payload.error === "object" && payload.error && !Array.isArray(payload.error)
      ? normalize((payload.error as JsonObject).message)
      : "";
    const error = new Error(message || `Search Console API request failed (${response.status})`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return payload;
}

async function querySearchAnalytics(
  siteUrl: string,
  accessToken: string,
  range: TimeRange,
  dimensions: SearchDimension[],
  rowLimit: number,
): Promise<{ dimensions: SearchDimension[]; rows: SearchRow[]; response_aggregation_type: string; metadata: unknown }> {
  const payload = await searchConsoleFetch(
    `${SEARCH_CONSOLE_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    accessToken,
    {
      method: "POST",
      body: JSON.stringify({
        startDate: range.since,
        endDate: range.until,
        dimensions,
        type: "web",
        dataState: "final",
        aggregationType: dimensions.includes("page") ? "auto" : "byProperty",
        rowLimit,
        startRow: 0,
      }),
    },
  );
  return {
    dimensions,
    rows: safeRows(payload),
    response_aggregation_type: normalize(payload.responseAggregationType),
    metadata: payload.metadata || null,
  };
}

function totals(rows: SearchRow[]): JsonObject {
  let clicks = 0;
  let impressions = 0;
  let weightedPosition = 0;
  for (const row of rows) {
    clicks += row.clicks;
    impressions += row.impressions;
    weightedPosition += row.position * row.impressions;
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weightedPosition / impressions : 0,
  };
}

export async function handleSearchConsoleReportingRequest(request: Request, env: SearchConsoleEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/internal/search-console/")) return null;

  const siteUrl = normalize(env.SEARCH_CONSOLE_SITE_URL) || "sc-domain:devidlabel.com";
  const configured = Boolean(parseGoogleServiceAccount(env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON) && siteUrl);

  if (path === "/internal/search-console/health") {
    if (request.method !== "GET") return jsonResponse({ ok: false, source: "search_console", message: "Metodo non supportato." }, 405);
    return jsonResponse({
      ok: true,
      source: "search_console",
      configured,
      auth_mode: configured ? "service_account" : "unconfigured",
      site_url: siteUrl,
      report_token_configured: Boolean(reportToken(env)),
      data_lag_days: SEARCH_CONSOLE_DATA_LAG_DAYS,
    });
  }

  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, source: "search_console", message: "Non autorizzato." }, 401);
  if (!configured) return jsonResponse({ ok: false, source: "search_console", message: "Configurazione Search Console incompleta." }, 503);
  if (request.method !== "GET") return jsonResponse({ ok: false, source: "search_console", message: "Metodo non supportato." }, 405);

  try {
    const accessToken = await googleServiceAccountAccessToken(env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON, SEARCH_CONSOLE_SCOPE);

    if (path === "/internal/search-console/sites") {
      const payload = await searchConsoleFetch(`${SEARCH_CONSOLE_BASE}/sites`, accessToken);
      const entries = Array.isArray(payload.siteEntry) ? payload.siteEntry : [];
      const sites = entries.flatMap((entry): JsonObject[] => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const item = entry as JsonObject;
        return [{ site_url: normalize(item.siteUrl), permission_level: normalize(item.permissionLevel) }];
      });
      return jsonResponse({ ok: true, source: "search_console", configured_site_url: siteUrl, sites });
    }

    if (path === "/internal/search-console/report") {
      const range = parseTimeRange(url);
      if (!range) return jsonResponse({ ok: false, source: "search_console", message: "Intervallo data non valido." }, 400);
      const overview = await querySearchAnalytics(siteUrl, accessToken, range, [], 1);
      const daily = await querySearchAnalytics(siteUrl, accessToken, range, ["date"], 5000);
      const queries = await querySearchAnalytics(siteUrl, accessToken, range, ["query"], 5000);
      const pages = await querySearchAnalytics(siteUrl, accessToken, range, ["page"], 5000);
      const devices = await querySearchAnalytics(siteUrl, accessToken, range, ["device"], 100);
      const countries = await querySearchAnalytics(siteUrl, accessToken, range, ["country"], 500);
      const summaryRows = overview.rows.length ? overview.rows : daily.rows;
      return jsonResponse({
        ok: true,
        source: "search_console",
        site_url: siteUrl,
        timeframe: range,
        generated_at: new Date().toISOString(),
        totals: totals(summaryRows),
        daily,
        queries,
        pages,
        devices,
        countries,
        limitations: ["Search Console may return top rows rather than every data row."],
      });
    }

    return jsonResponse({ ok: false, source: "search_console", message: "Endpoint non trovato." }, 404);
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error && typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : 502;
    return jsonResponse({
      ok: false,
      source: "search_console",
      message: error instanceof Error ? error.message : "Errore Search Console.",
    }, status >= 400 && status < 600 ? status : 502);
  }
}
