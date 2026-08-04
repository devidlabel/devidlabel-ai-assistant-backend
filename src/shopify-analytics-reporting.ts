import { shopifyGraphQL } from "./index";

const SCHEMA_VERSION = 1;
const MAX_SYNC_DAYS = 31;

type JsonObject = Record<string, unknown>;

type ShopifyAnalyticsEnv = {
  SHOPIFY_SHOP_DOMAIN?: string;
  SHOPIFY_ADMIN_ACCESS_TOKEN?: string;
  SHOPIFY_API_VERSION?: string;
  SHOPIFY_REPORT_ACCESS_TOKEN?: string;
  COMMERCE_TENANT_ID?: string;
};

type ScopeData = {
  currentAppInstallation: { accessScopes: Array<{ handle: string }> };
};

type ShopifyQlColumn = {
  name: string;
  dataType: string;
  displayName: string;
};

type ShopifyQlTableData = {
  columns: ShopifyQlColumn[];
  rows: JsonObject[];
};

type ShopifyQlParseError = {
  message: string;
};

type ShopifyQlData = {
  shopifyqlQuery: {
    parseErrors: ShopifyQlParseError[];
    tableData: ShopifyQlTableData | null;
  };
};

type Window = {
  key: string;
  startDate: string;
  endDate: string;
  days: number;
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

function normalizeSecret(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function timingSafeEqualText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

function isAuthorized(request: Request, env: ShopifyAnalyticsEnv): boolean {
  const expected = normalizeSecret(env.SHOPIFY_REPORT_ACCESS_TOKEN);
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  return Boolean(expected) && timingSafeEqualText(supplied, expected);
}

function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : parsed;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function todayInRome(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseWindow(url: URL): Window | null {
  const today = parseDate(todayInRome());
  if (!today) return null;
  const yesterday = addDays(today, -1);
  const timeframe = (url.searchParams.get("timeframe") || "yesterday").trim();
  let start: Date;
  let end: Date;
  let key = timeframe;

  if (timeframe === "yesterday") {
    start = yesterday;
    end = yesterday;
  } else if (timeframe === "last_3_days") {
    start = addDays(yesterday, -2);
    end = yesterday;
  } else if (timeframe === "last_7_days") {
    start = addDays(yesterday, -6);
    end = yesterday;
  } else if (timeframe === "last_14_days") {
    start = addDays(yesterday, -13);
    end = yesterday;
  } else if (timeframe === "last_30_days") {
    start = addDays(yesterday, -29);
    end = yesterday;
  } else if (timeframe === "custom") {
    const customStart = parseDate((url.searchParams.get("start") || "").trim());
    const customEnd = parseDate((url.searchParams.get("end") || "").trim());
    if (!customStart || !customEnd || customStart > customEnd) return null;
    start = customStart;
    end = customEnd;
    key = "custom";
  } else {
    return null;
  }

  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days < 1 || days > MAX_SYNC_DAYS) return null;
  return { key, startDate: isoDate(start), endDate: isoDate(end), days };
}

async function grantedScopes(env: ShopifyAnalyticsEnv): Promise<string[]> {
  const data = await shopifyGraphQL<ScopeData>(env, `
    query ShopifyAnalyticsAccessScopes {
      currentAppInstallation { accessScopes { handle } }
    }
  `);
  return data.currentAppInstallation.accessScopes.map((scope) => scope.handle).sort();
}

function dateClause(window: Window): string {
  return `SINCE ${window.startDate} UNTIL ${window.endDate}`;
}

async function runShopifyQl(env: ShopifyAnalyticsEnv, label: string, query: string): Promise<ShopifyQlTableData> {
  const data = await shopifyGraphQL<ShopifyQlData>(env, `
    query ShopifyAnalyticsQuery($query: String!) {
      shopifyqlQuery(query: $query) {
        tableData {
          columns { name dataType displayName }
          rows
        }
        parseErrors { message }
      }
    }
  `, { query });

  const result = data.shopifyqlQuery;
  if (result.parseErrors.length) {
    throw new Error(`shopifyql_parse_error:${label}:${result.parseErrors.map((error) => error.message).join(" | ")}`);
  }
  if (!result.tableData) throw new Error(`shopifyql_empty_table:${label}`);
  return result.tableData;
}

function firstRow(table: ShopifyQlTableData): JsonObject {
  return table.rows[0] || {};
}

function sessionMetrics(window: Window, botFilter?: "human" | "bot"): string {
  const filter = botFilter ? `WHERE human_or_bot_session = '${botFilter}'` : "";
  return `FROM sessions
    SHOW sessions, online_store_visitors, pageviews, pageviews_per_session,
      average_session_duration, bounces, bounce_rate, sessions_with_cart_additions,
      sessions_that_reached_checkout, sessions_that_completed_checkout,
      added_to_cart_rate, reached_checkout_rate, conversion_rate
    ${filter}
    ${dateClause(window)}`;
}

function sourceBreakdown(window: Window, botFilter: "human" | "bot"): string {
  return `FROM sessions
    SHOW sessions, online_store_visitors, sessions_that_completed_checkout, conversion_rate
    WHERE human_or_bot_session = '${botFilter}'
    GROUP BY referrer_source, referrer_name
    ${dateClause(window)}
    ORDER BY sessions DESC
    LIMIT 100`;
}

function utmBreakdown(window: Window): string {
  return `FROM sessions
    SHOW sessions, online_store_visitors, sessions_that_completed_checkout, conversion_rate
    WHERE human_or_bot_session = 'human'
    GROUP BY utm_source, utm_medium
    ${dateClause(window)}
    ORDER BY sessions DESC
    LIMIT 100`;
}

function landingPageBreakdown(window: Window): string {
  return `FROM sessions
    SHOW sessions, online_store_visitors, sessions_that_completed_checkout, conversion_rate,
      bounce_rate, average_session_duration
    WHERE human_or_bot_session = 'human'
    GROUP BY landing_page_path, landing_page_type
    ${dateClause(window)}
    ORDER BY sessions DESC
    LIMIT 50`;
}

function dailyHumanBot(window: Window): string {
  return `FROM sessions
    SHOW sessions, online_store_visitors, sessions_that_completed_checkout, conversion_rate
    GROUP BY human_or_bot_session
    TIMESERIES day
    ${dateClause(window)}
    ORDER BY day ASC`;
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/read_reports|access denied|forbidden/i.test(message)) return "read_reports_or_protected_data_access_required";
  if (/shopifyql_parse_error/i.test(message)) return "shopifyql_parse_error";
  if (/429|rate.?limit/i.test(message)) return "rate_limited";
  if (/timeout|abort/i.test(message)) return "timeout";
  if (/unauthorized|401/i.test(message)) return "unauthorized";
  if (/graphql|query|validation/i.test(message)) return "graphql_error";
  return "upstream_unavailable";
}

async function buildReport(env: ShopifyAnalyticsEnv, window: Window, scopes: string[]): Promise<JsonObject> {
  const [allSessions, humanSessions, botSessions, humanSources, botSources, humanUtm, humanLandingPages, dailyClassification] = await Promise.all([
    runShopifyQl(env, "all_sessions", sessionMetrics(window)),
    runShopifyQl(env, "human_sessions", sessionMetrics(window, "human")),
    runShopifyQl(env, "bot_sessions", sessionMetrics(window, "bot")),
    runShopifyQl(env, "human_sources", sourceBreakdown(window, "human")),
    runShopifyQl(env, "bot_sources", sourceBreakdown(window, "bot")),
    runShopifyQl(env, "human_utm", utmBreakdown(window)),
    runShopifyQl(env, "human_landing_pages", landingPageBreakdown(window)),
    runShopifyQl(env, "daily_human_bot", dailyHumanBot(window)),
  ]);

  return {
    ok: true,
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    source: "shopifyql_admin_graphql",
    tenant: normalizeSecret(env.COMMERCE_TENANT_ID) || null,
    timeframe: {
      key: window.key,
      start: window.startDate,
      end: window.endDate,
      days: window.days,
      timezone: "Europe/Rome",
    },
    access: {
      scopes,
      read_reports: scopes.includes("read_reports"),
    },
    methodology: {
      primary_business_kpis: "Shopify sessions filtered with human_or_bot_session = 'human'",
      bot_diagnostics: "Bot sessions remain separately visible and are excluded from human conversion KPIs.",
      bot_classifier: "Shopify native session-level human/bot classification.",
      bot_history_available_from: "2025-10-07",
      conversion_rate_formula: "sessions_that_completed_checkout / sessions",
      visitors_definition: "Unique online store visitors; one visitor can have multiple sessions.",
    },
    totals: {
      all: firstRow(allSessions),
      human: firstRow(humanSessions),
      bot: firstRow(botSessions),
    },
    breakdowns: {
      human_traffic_source: humanSources.rows,
      bot_traffic_source: botSources.rows,
      human_utm: humanUtm.rows,
      human_landing_page: humanLandingPages.rows,
      daily_human_bot: dailyClassification.rows,
    },
    columns: {
      session_totals: humanSessions.columns,
      traffic_source: humanSources.columns,
      utm: humanUtm.columns,
      landing_page: humanLandingPages.columns,
      daily_human_bot: dailyClassification.columns,
    },
    warnings: [],
  };
}

export async function handleShopifyAnalyticsReportingRequest(
  request: Request,
  env: ShopifyAnalyticsEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/internal/shopify-analytics/")) return null;

  if (url.pathname === "/internal/shopify-analytics/health") {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    return jsonResponse({
      ok: true,
      service: "shopify_analytics_reporting",
      schema_version: SCHEMA_VERSION,
      configured: {
        report_access_token: Boolean(normalizeSecret(env.SHOPIFY_REPORT_ACCESS_TOKEN)),
        tenant_id: Boolean(normalizeSecret(env.COMMERCE_TENANT_ID)),
      },
      capabilities: {
        shopifyql_sessions: true,
        native_human_bot_split: true,
        human_conversion_rate: true,
        human_traffic_sources: true,
        human_utm_breakdown: true,
        human_landing_pages: true,
      },
    });
  }

  if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  if (url.pathname !== "/internal/shopify-analytics/report") return jsonResponse({ ok: false, error: "not_found" }, 404);

  const window = parseWindow(url);
  if (!window) return jsonResponse({ ok: false, error: "invalid_timeframe", hint: `Maximum range is ${MAX_SYNC_DAYS} days.` }, 400);

  try {
    const scopes = await grantedScopes(env);
    if (!scopes.includes("read_reports")) {
      return jsonResponse({
        ok: false,
        error: "read_reports_required",
        granted_scopes: scopes,
        reinstall_required: true,
      }, 403);
    }
    return jsonResponse(await buildReport(env, window, scopes));
  } catch (error) {
    const detail = safeErrorCode(error);
    console.warn("shopify_analytics_reporting_error", { detail, timeframe: window.key });
    return jsonResponse({
      ok: false,
      error: "shopify_analytics_reporting_unavailable",
      detail,
      message: error instanceof Error && error.message.startsWith("shopifyql_parse_error") ? error.message : undefined,
    }, detail === "read_reports_or_protected_data_access_required" ? 403 : 503);
  }
}
