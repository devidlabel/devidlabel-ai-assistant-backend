import { handleDailyPulseRequest as handleBaseDailyPulseRequest } from "./daily-pulse";
import { handleGa4ReportingRequest } from "./ga4-reporting";
import { handleSearchConsoleReportingRequest } from "./search-console-reporting";

type JsonObject = Record<string, unknown>;
type OrganicPulseEnv = {
  GOOGLE_ADS_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_ORGANIC_REPORT_ACCESS_TOKEN?: string;
  GOOGLE_ADS_REPORT_ACCESS_TOKEN?: string;
  DAILY_PULSE_ACCESS_TOKEN?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
  SEARCH_CONSOLE_SITE_URL?: string;
  GA4_PROPERTY_ID?: string;
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

async function augmentHealth(base: Response, env: OrganicPulseEnv): Promise<Response> {
  const parsed = await parseResponse(base);
  if (!parsed.ok) return jsonResponse(parsed.body, parsed.status);
  const configured = asObject(parsed.body.configured);
  return jsonResponse({
    ...parsed.body,
    configured: {
      ...configured,
      search_console: Boolean(normalize(env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON) && normalize(env.SEARCH_CONSOLE_SITE_URL)),
      ga4: Boolean(normalize(env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON) && normalize(env.GA4_PROPERTY_ID)),
    },
  });
}

async function augmentReport(base: Response, request: Request, env: OrganicPulseEnv): Promise<Response> {
  const parsed = await parseResponse(base);
  if (!parsed.ok) return jsonResponse(parsed.body, parsed.status);

  const [ga4Yesterday, ga4Last7Days, searchConsoleLast7Days] = await Promise.all([
    invoke(handleGa4ReportingRequest, "/internal/ga4/report?timeframe=yesterday", request, env),
    invoke(handleGa4ReportingRequest, "/internal/ga4/report?timeframe=last_7_days", request, env),
    invoke(handleSearchConsoleReportingRequest, "/internal/search-console/report?timeframe=last_7_days", request, env),
  ]);

  const notes = Array.isArray(parsed.body.notes) ? parsed.body.notes : [];
  return jsonResponse({
    ...parsed.body,
    yesterday: attachGa4(parsed.body.yesterday, ga4Yesterday),
    last_7_days: attachGa4(parsed.body.last_7_days, ga4Last7Days),
    search_console: {
      last_7_days: searchConsoleSummary(searchConsoleLast7Days),
      source_status: { ok: searchConsoleLast7Days.ok, status: searchConsoleLast7Days.status },
    },
    notes: [
      ...notes,
      "GA4 is measurement-platform data and is reconciled separately from Shopify source-of-truth commerce revenue.",
      "Search Console uses finalized data with a default three-day reporting lag.",
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
