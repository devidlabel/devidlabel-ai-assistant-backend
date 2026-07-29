const DEFAULT_META_GRAPH_API_VERSION = "v25.0";
const META_GRAPH_BASE = "https://graph.facebook.com";

const VALID_LEVELS = new Set(["account", "campaign", "adset", "ad"]);

type MetaReportingEnv = {
  META_ADS_ACCESS_TOKEN?: string;
  META_AD_ACCOUNT_ID?: string;
  META_GRAPH_API_VERSION?: string;
  META_REPORT_ACCESS_TOKEN?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
};

type JsonObject = Record<string, unknown>;
type MetaAction = { action_type?: unknown; value?: unknown };

type MetaInsightsRow = JsonObject & {
  actions?: unknown;
  action_values?: unknown;
  video_thruplay_watched_actions?: unknown;
  video_avg_time_watched_actions?: unknown;
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
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function reportingToken(env: MetaReportingEnv): string {
  // META_REPORT_ACCESS_TOKEN is preferred. During rollout the existing internal
  // reporting token can be reused without exposing it to the client/storefront.
  return normalizeSecret(env.META_REPORT_ACCESS_TOKEN)
    || normalizeSecret(env.KLAVIYO_REPORT_ACCESS_TOKEN);
}

function isAuthorized(request: Request, env: MetaReportingEnv): boolean {
  const expected = reportingToken(env);
  if (!expected) return false;
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  return timingSafeEqualText(supplied, expected);
}

function graphVersion(env: MetaReportingEnv): string {
  const configured = normalizeSecret(env.META_GRAPH_API_VERSION);
  return /^v\d+\.\d+$/.test(configured) ? configured : DEFAULT_META_GRAPH_API_VERSION;
}

function normalizeAdAccountId(value: unknown): string {
  const raw = normalizeSecret(value).replace(/^act_/i, "");
  return /^\d{5,30}$/.test(raw) ? raw : "";
}

function dateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseTimeRange(url: URL): { since: string; until: string } | null {
  const preset = (url.searchParams.get("timeframe") || "yesterday").trim();
  const now = new Date();
  // Build completed-day ranges in UTC only for preset selection. Meta interprets
  // date-only values in the ad account timezone, which is what we want.
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const addDays = (date: Date, days: number) => {
    const copy = new Date(date);
    copy.setUTCDate(copy.getUTCDate() + days);
    return copy;
  };

  if (preset === "custom") {
    const since = (url.searchParams.get("start") || "").trim();
    const until = (url.searchParams.get("end") || "").trim();
    if (!dateOnly(since) || !dateOnly(until) || since > until) return null;
    return { since, until };
  }

  const yesterday = addDays(today, -1);
  if (preset === "yesterday") return { since: iso(yesterday), until: iso(yesterday) };
  if (preset === "last_7_days") return { since: iso(addDays(yesterday, -6)), until: iso(yesterday) };
  if (preset === "last_14_days") return { since: iso(addDays(yesterday, -13)), until: iso(yesterday) };
  if (preset === "month_to_yesterday") {
    const monthStart = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), 1));
    return { since: iso(monthStart), until: iso(yesterday) };
  }
  return null;
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function actions(value: unknown): MetaAction[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is MetaAction => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
    : [];
}

function actionMetric(value: unknown, priority: string[]): number {
  const map = new Map<string, number>();
  for (const entry of actions(value)) {
    const type = typeof entry.action_type === "string" ? entry.action_type : "";
    if (type) map.set(type, numberValue(entry.value));
  }
  for (const type of priority) {
    if (map.has(type)) return map.get(type) || 0;
  }
  return 0;
}

function normalizedMetrics(row: MetaInsightsRow): JsonObject {
  const purchaseTypes = ["offsite_conversion.fb_pixel_purchase", "omni_purchase", "purchase"];
  const checkoutTypes = ["offsite_conversion.fb_pixel_initiate_checkout", "omni_initiated_checkout", "initiate_checkout"];
  const cartTypes = ["offsite_conversion.fb_pixel_add_to_cart", "omni_add_to_cart", "add_to_cart"];
  const viewTypes = ["offsite_conversion.fb_pixel_view_content", "omni_view_content", "view_content"];
  const spend = numberValue(row.spend);
  const purchases = actionMetric(row.actions, purchaseTypes);
  const purchaseValue = actionMetric(row.action_values, purchaseTypes);

  return {
    spend,
    impressions: numberValue(row.impressions),
    reach: numberValue(row.reach),
    frequency: numberValue(row.frequency),
    clicks: numberValue(row.clicks),
    link_clicks: numberValue(row.inline_link_clicks),
    ctr: numberValue(row.ctr),
    cpc: numberValue(row.cpc),
    cpm: numberValue(row.cpm),
    view_content: actionMetric(row.actions, viewTypes),
    add_to_cart: actionMetric(row.actions, cartTypes),
    initiate_checkout: actionMetric(row.actions, checkoutTypes),
    purchases,
    purchase_value: purchaseValue,
    cost_per_purchase: purchases > 0 ? spend / purchases : 0,
    purchase_roas: spend > 0 ? purchaseValue / spend : 0,
    video_thruplays: actionMetric(row.video_thruplay_watched_actions, ["video_view", "video_thruplay"]),
    video_avg_time_watched_seconds: actionMetric(row.video_avg_time_watched_actions, ["video_view", "video_avg_time_watched"]),
  };
}

function safeRow(row: MetaInsightsRow): JsonObject {
  return {
    date_start: typeof row.date_start === "string" ? row.date_start : "",
    date_stop: typeof row.date_stop === "string" ? row.date_stop : "",
    account_id: typeof row.account_id === "string" ? row.account_id : "",
    account_name: typeof row.account_name === "string" ? row.account_name : "",
    campaign_id: typeof row.campaign_id === "string" ? row.campaign_id : "",
    campaign_name: typeof row.campaign_name === "string" ? row.campaign_name : "",
    adset_id: typeof row.adset_id === "string" ? row.adset_id : "",
    adset_name: typeof row.adset_name === "string" ? row.adset_name : "",
    ad_id: typeof row.ad_id === "string" ? row.ad_id : "",
    ad_name: typeof row.ad_name === "string" ? row.ad_name : "",
    metrics: normalizedMetrics(row),
    // Aggregated action arrays are retained so we can diagnose attribution/action
    // naming changes without ever returning customer-level data.
    actions: actions(row.actions),
    action_values: actions(row.action_values),
  };
}

async function metaFetch(url: URL, token: string): Promise<JsonObject> {
  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "DevidLabelReportingWorker/1.0",
    },
  });
  let payload: JsonObject = {};
  try {
    payload = await response.json() as JsonObject;
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const error = new Error(`Meta Marketing API request failed (${response.status})`);
    (error as Error & { status?: number; payload?: JsonObject }).status = response.status;
    (error as Error & { status?: number; payload?: JsonObject }).payload = payload;
    throw error;
  }
  return payload;
}

async function fetchAllInsights(url: URL, token: string): Promise<MetaInsightsRow[]> {
  const rows: MetaInsightsRow[] = [];
  let current: URL | null = url;
  let pages = 0;
  while (current && pages < 50) {
    const payload = await metaFetch(current, token);
    if (Array.isArray(payload.data)) {
      for (const row of payload.data) {
        if (row && typeof row === "object" && !Array.isArray(row)) rows.push(row as MetaInsightsRow);
      }
    }
    const paging = payload.paging && typeof payload.paging === "object" ? payload.paging as JsonObject : {};
    const next = typeof paging.next === "string" ? paging.next : "";
    if (!next) break;
    const nextUrl = new URL(next);
    if (nextUrl.hostname !== "graph.facebook.com") throw new Error("Unexpected Meta pagination host");
    current = nextUrl;
    pages += 1;
  }
  return rows;
}

function safeError(error: unknown): JsonObject {
  const candidate = error as Error & { status?: number; payload?: JsonObject };
  const metaError = candidate?.payload?.error;
  const cleanMetaError = metaError && typeof metaError === "object"
    ? {
        message: typeof (metaError as JsonObject).message === "string" ? (metaError as JsonObject).message : "",
        type: typeof (metaError as JsonObject).type === "string" ? (metaError as JsonObject).type : "",
        code: numberValue((metaError as JsonObject).code),
        error_subcode: numberValue((metaError as JsonObject).error_subcode),
      }
    : undefined;
  return {
    message: candidate?.message || "Unknown Meta reporting error",
    ...(typeof candidate?.status === "number" ? { status: candidate.status } : {}),
    ...(cleanMetaError ? { meta_error: cleanMetaError } : {}),
  };
}

export async function handleMetaReportingRequest(request: Request, env: MetaReportingEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/internal/meta/")) return null;
  if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);

  if (url.pathname === "/internal/meta/health") {
    return jsonResponse({
      ok: true,
      service: "meta_ads_reporting",
      graph_api_version: graphVersion(env),
      configured: {
        access_token: Boolean(normalizeSecret(env.META_ADS_ACCESS_TOKEN)),
        ad_account_id: Boolean(normalizeAdAccountId(env.META_AD_ACCOUNT_ID)),
        report_access_token: Boolean(reportingToken(env)),
      },
    });
  }

  if (url.pathname !== "/internal/meta/report") return jsonResponse({ ok: false, error: "not_found" }, 404);
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

  const token = normalizeSecret(env.META_ADS_ACCESS_TOKEN);
  const accountId = normalizeAdAccountId(env.META_AD_ACCOUNT_ID);
  if (!token || !accountId) return jsonResponse({ ok: false, error: "meta_reporting_not_configured" }, 503);

  const timeRange = parseTimeRange(url);
  if (!timeRange) {
    return jsonResponse({
      ok: false,
      error: "invalid_timeframe",
      hint: "Use yesterday, last_7_days, last_14_days, month_to_yesterday, or custom with start/end YYYY-MM-DD",
    }, 400);
  }

  const level = (url.searchParams.get("level") || "campaign").trim();
  if (!VALID_LEVELS.has(level)) return jsonResponse({ ok: false, error: "invalid_level" }, 400);
  const daily = url.searchParams.get("daily") === "1";

  const fields = [
    "date_start", "date_stop", "account_id", "account_name",
    "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name",
    "spend", "impressions", "reach", "frequency", "clicks", "inline_link_clicks",
    "ctr", "cpc", "cpm", "actions", "action_values",
    "video_thruplay_watched_actions", "video_avg_time_watched_actions",
  ].join(",");

  const endpoint = new URL(`${META_GRAPH_BASE}/${graphVersion(env)}/act_${accountId}/insights`);
  endpoint.searchParams.set("fields", fields);
  endpoint.searchParams.set("level", level);
  endpoint.searchParams.set("time_range", JSON.stringify(timeRange));
  endpoint.searchParams.set("action_report_time", "conversion");
  endpoint.searchParams.set("use_account_attribution_setting", "true");
  endpoint.searchParams.set("limit", "500");
  if (daily) endpoint.searchParams.set("time_increment", "1");

  try {
    const rawRows = await fetchAllInsights(endpoint, token);
    return jsonResponse({
      ok: true,
      service: "meta_ads_reporting",
      graph_api_version: graphVersion(env),
      generated_at: new Date().toISOString(),
      account_id: accountId,
      level,
      daily,
      time_range: timeRange,
      attribution: {
        action_report_time: "conversion",
        use_account_attribution_setting: true,
      },
      rows: rawRows.map(safeRow),
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: "meta_reporting_failed", detail: safeError(error) }, 502);
  }
}
