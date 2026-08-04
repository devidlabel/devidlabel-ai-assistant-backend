const KLAVIYO_API_BASE = "https://a.klaviyo.com";
const KLAVIYO_REVISION = "2026-07-15";
const KLAVIYO_MAX_RETRIES = 3;
const KLAVIYO_REPORT_CACHE_TTL_MS = 10 * 60 * 1000;

let cachedConversionMetricId: string | null = null;
const reportCache = new Map<string, { expiresAt: number; body: JsonObject }>();

const REPORT_STATISTICS = [
  "recipients",
  "delivered",
  "delivery_rate",
  "opens_unique",
  "open_rate",
  "clicks_unique",
  "click_rate",
  "conversions",
  "conversion_uniques",
  "conversion_rate",
  "conversion_value",
  "revenue_per_recipient",
  "average_order_value",
  "bounced",
  "bounce_rate",
  "unsubscribes",
  "unsubscribe_rate",
  "spam_complaints",
  "spam_complaint_rate",
] as const;

type KlaviyoReportingEnv = {
  KLAVIYO_PRIVATE_API_KEY?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
  KLAVIYO_CONVERSION_METRIC_ID?: string;
};

type JsonObject = Record<string, unknown>;

type KlaviyoMetric = {
  id?: string;
  attributes?: {
    name?: string;
    integration?: {
      name?: string;
      category?: string;
    };
  };
};

type Timeframe =
  | { key: string }
  | { start: string; end: string };

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
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

function isAuthorized(request: Request, env: KlaviyoReportingEnv): boolean {
  const expected = normalizeSecret(env.KLAVIYO_REPORT_ACCESS_TOKEN);
  if (!expected) return false;
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  return timingSafeEqualText(supplied, expected);
}

function lastSunday(year: number, monthIndex: number): number {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0));
  return lastDay.getUTCDate() - lastDay.getUTCDay();
}

function romeOffsetForDate(date: string): string {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "+00:00";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const marchSwitch = lastSunday(year, 2);
  const octoberSwitch = lastSunday(year, 9);
  const isDst = month > 3 && month < 10
    || (month === 3 && day >= marchSwitch)
    || (month === 10 && day < octoberSwitch);
  return isDst ? "+02:00" : "+01:00";
}

function dateBoundary(date: string, endOfDay = false): string {
  const offset = romeOffsetForDate(date);
  return `${date}T${endOfDay ? "23:59:59" : "00:00:00"}${offset}`;
}

function parseTimeframe(url: URL): Timeframe | null {
  const preset = (url.searchParams.get("timeframe") || "yesterday").trim();
  const supported = new Set([
    "today",
    "yesterday",
    "this_week",
    "last_7_days",
    "last_week",
    "this_month",
    "last_30_days",
    "last_month",
    "last_90_days",
    "last_3_months",
    "last_365_days",
    "last_12_months",
    "this_year",
    "last_year",
  ]);
  if (supported.has(preset)) return { key: preset };
  if (preset !== "custom") return null;

  const start = (url.searchParams.get("start") || "").trim();
  const end = (url.searchParams.get("end") || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  if (start > end) return null;
  return { start: dateBoundary(start), end: dateBoundary(end, true) };
}


function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function klaviyoFetch(
  path: string,
  apiKey: string,
  init: RequestInit = {},
): Promise<JsonObject> {
  let lastStatus = 0;
  let lastBody: JsonObject = {};

  for (let attempt = 0; attempt <= KLAVIYO_MAX_RETRIES; attempt += 1) {
    const response = await fetch(KLAVIYO_API_BASE + path, {
      ...init,
      headers: {
        Accept: "application/vnd.api+json",
        Authorization: "Klaviyo-API-Key " + apiKey,
        revision: KLAVIYO_REVISION,
        ...(init.body ? { "Content-Type": "application/vnd.api+json" } : {}),
        ...(init.headers || {}),
      },
    });

    let body: JsonObject = {};
    try {
      body = await response.json() as JsonObject;
    } catch {
      body = {};
    }

    if (response.ok) return body;
    lastStatus = response.status;
    lastBody = body;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= KLAVIYO_MAX_RETRIES) break;
    const retryAfterSeconds = Number(response.headers.get("Retry-After") || "0");
    const backoff = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : 300 * (2 ** attempt);
    await sleep(Math.min(backoff, 5000));
  }

  const error = new Error("Klaviyo API request failed (" + (lastStatus || "unknown") + ")");
  (error as Error & { status?: number; payload?: JsonObject }).status = lastStatus || undefined;
  (error as Error & { status?: number; payload?: JsonObject }).payload = lastBody;
  throw error;
}

function metricScore(metric: KlaviyoMetric): number {
  const name = metric.attributes?.name?.trim().toLowerCase() || "";
  const integrationName = metric.attributes?.integration?.name?.trim().toLowerCase() || "";
  if (name !== "placed order") return -1;
  if (integrationName === "shopify") return 100;
  if (integrationName.includes("shopify")) return 90;
  return 50;
}


async function resolveConversionMetricId(apiKey: string, env: KlaviyoReportingEnv): Promise<string> {
  const configured = normalizeSecret(env.KLAVIYO_CONVERSION_METRIC_ID);
  if (configured) return configured;
  if (cachedConversionMetricId) return cachedConversionMetricId;

  let path = "/api/metrics?fields[metric]=name,integration";
  let best: { id: string; score: number } | null = null;
  let pageCount = 0;

  while (path && pageCount < 10) {
    const payload = await klaviyoFetch(path, apiKey);
    const data = Array.isArray(payload.data) ? payload.data as KlaviyoMetric[] : [];
    for (const metric of data) {
      const id = typeof metric.id === "string" ? metric.id : "";
      const score = metricScore(metric);
      if (id && score >= 0 && (!best || score > best.score)) best = { id, score };
    }
    if (best?.score === 100) {
      cachedConversionMetricId = best.id;
      return best.id;
    }

    const links = payload.links && typeof payload.links === "object" ? payload.links as JsonObject : {};
    const next = typeof links.next === "string" ? links.next : "";
    if (!next) break;
    const nextUrl = new URL(next);
    path = nextUrl.pathname + nextUrl.search;
    pageCount += 1;
  }

  if (!best) throw new Error("Placed Order metric not found. Configure KLAVIYO_CONVERSION_METRIC_ID explicitly.");
  cachedConversionMetricId = best.id;
  return best.id;
}

function buildReportBody(
  type: "campaign-values-report" | "flow-values-report",
  timeframe: Timeframe,
  conversionMetricId: string,
): JsonObject {
  const groupBy = type === "campaign-values-report"
    ? ["campaign_message_id", "campaign_id", "campaign_message_name", "send_channel"]
    : ["flow_message_id", "flow_id", "flow_name", "flow_message_name", "send_channel"];

  return {
    data: {
      type,
      attributes: {
        timeframe,
        conversion_metric_id: conversionMetricId,
        statistics: [...REPORT_STATISTICS],
        group_by: groupBy,
      },
    },
  };
}

async function queryValuesReport(
  apiKey: string,
  resource: "campaign" | "flow",
  timeframe: Timeframe,
  conversionMetricId: string,
): Promise<JsonObject> {
  const type = resource === "campaign" ? "campaign-values-report" : "flow-values-report";
  const path = resource === "campaign" ? "/api/campaign-values-reports/" : "/api/flow-values-reports/";
  return klaviyoFetch(path, apiKey, {
    method: "POST",
    body: JSON.stringify(buildReportBody(type, timeframe, conversionMetricId)),
  });
}

function reportResults(payload: JsonObject): unknown[] {
  if (!payload.data || typeof payload.data !== "object") return [];
  const attributes = (payload.data as JsonObject).attributes;
  if (!attributes || typeof attributes !== "object") return [];
  return Array.isArray((attributes as JsonObject).results) ? (attributes as JsonObject).results as unknown[] : [];
}

function safeError(error: unknown): { message: string; status?: number } {
  const candidate = error as Error & { status?: number };
  return {
    message: candidate?.message || "Unknown Klaviyo reporting error",
    ...(typeof candidate?.status === "number" ? { status: candidate.status } : {}),
  };
}

export async function handleKlaviyoReportingRequest(
  request: Request,
  env: KlaviyoReportingEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/internal/klaviyo/")) return null;

  if (request.method !== "GET") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  if (url.pathname === "/internal/klaviyo/health") {
    return jsonResponse({
      ok: true,
      service: "klaviyo_reporting",
      revision: KLAVIYO_REVISION,
      configured: {
        api_key: Boolean(normalizeSecret(env.KLAVIYO_PRIVATE_API_KEY)),
        access_token: Boolean(normalizeSecret(env.KLAVIYO_REPORT_ACCESS_TOKEN)),
        conversion_metric_id: Boolean(normalizeSecret(env.KLAVIYO_CONVERSION_METRIC_ID)),
      },
      resilience: {
        retry_429_and_5xx: true,
        maximum_retries: KLAVIYO_MAX_RETRIES,
        report_cache_ttl_seconds: KLAVIYO_REPORT_CACHE_TTL_MS / 1000,
        conversion_metric_memory_cache: true,
      },
    });
  }

  if (url.pathname !== "/internal/klaviyo/report") {
    return jsonResponse({ ok: false, error: "not_found" }, 404);
  }

  if (!isAuthorized(request, env)) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  const apiKey = normalizeSecret(env.KLAVIYO_PRIVATE_API_KEY);
  if (!apiKey) {
    return jsonResponse({ ok: false, error: "klaviyo_api_key_not_configured" }, 503);
  }

  const timeframe = parseTimeframe(url);
  if (!timeframe) {
    return jsonResponse({
      ok: false,
      error: "invalid_timeframe",
      hint: "Use a Klaviyo preset or timeframe=custom&start=YYYY-MM-DD&end=YYYY-MM-DD",
    }, 400);
  }

  try {
    const conversionMetricId = await resolveConversionMetricId(apiKey, env);
    const cacheKey = JSON.stringify({ timeframe, conversionMetricId });
    const cached = reportCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return jsonResponse({ ...cached.body, cache: { hit: true, ttl_seconds: KLAVIYO_REPORT_CACHE_TTL_MS / 1000 } });
    }

    const campaignPayload = await queryValuesReport(apiKey, "campaign", timeframe, conversionMetricId);
    await sleep(250);
    const flowPayload = await queryValuesReport(apiKey, "flow", timeframe, conversionMetricId);
    const responseBody: JsonObject = {
      ok: true,
      service: "klaviyo_reporting",
      revision: KLAVIYO_REVISION,
      generated_at: new Date().toISOString(),
      timeframe,
      conversion_metric: {
        id: conversionMetricId,
        name: "Placed Order",
      },
      statistics: [...REPORT_STATISTICS],
      campaigns: reportResults(campaignPayload),
      flows: reportResults(flowPayload),
      cache: { hit: false, ttl_seconds: KLAVIYO_REPORT_CACHE_TTL_MS / 1000 },
    };
    reportCache.set(cacheKey, { expiresAt: Date.now() + KLAVIYO_REPORT_CACHE_TTL_MS, body: responseBody });
    return jsonResponse(responseBody);
  } catch (error) {
    const detail = safeError(error);
    return jsonResponse({
      ok: false,
      error: "klaviyo_reporting_failed",
      detail,
    }, detail.status === 429 ? 429 : 502);
  }
}
