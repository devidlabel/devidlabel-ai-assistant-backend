const DEFAULT_META_GRAPH_API_VERSION = "v26.0";
const META_GRAPH_BASE = "https://graph.facebook.com";

const VALID_LEVELS = new Set(["account", "campaign", "adset", "ad"]);
const ENTITY_FIELDS: Record<string, string> = {
  campaigns: "id,name,objective,status,effective_status,created_time,updated_time,daily_budget,lifetime_budget,bid_strategy",
  adsets: "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,bid_strategy,billing_event,optimization_goal,promoted_object,targeting,created_time,updated_time",
  ads: "id,name,adset_id,campaign_id,status,effective_status,creative,created_time,updated_time",
};

type MetaReportingEnv = {
  META_ADS_ACCESS_TOKEN?: string;
  META_AD_ACCOUNT_ID?: string;
  META_GRAPH_API_VERSION?: string;
  META_REPORT_ACCESS_TOKEN?: string;
  META_WRITE_ACCESS_TOKEN?: string;
  META_PIXEL_ID?: string;
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

type MetaApiError = Error & { status?: number; payload?: JsonObject };

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

function bearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function reportingToken(env: MetaReportingEnv): string {
  return normalizeSecret(env.META_REPORT_ACCESS_TOKEN)
    || normalizeSecret(env.KLAVIYO_REPORT_ACCESS_TOKEN);
}

function isReadAuthorized(request: Request, env: MetaReportingEnv): boolean {
  return timingSafeEqualText(bearerToken(request), reportingToken(env));
}

function isWriteAuthorized(request: Request, env: MetaReportingEnv): boolean {
  return timingSafeEqualText(bearerToken(request), normalizeSecret(env.META_WRITE_ACCESS_TOKEN));
}

function graphVersion(env: MetaReportingEnv): string {
  const configured = normalizeSecret(env.META_GRAPH_API_VERSION);
  return /^v\d+\.\d+$/.test(configured) ? configured : DEFAULT_META_GRAPH_API_VERSION;
}

function normalizeAdAccountId(value: unknown): string {
  const raw = normalizeSecret(value).replace(/^act_/i, "");
  return /^\d{5,30}$/.test(raw) ? raw : "";
}

function normalizeObjectId(value: unknown): string {
  const raw = normalizeSecret(value);
  return /^\d{5,40}$/.test(raw) ? raw : "";
}

function dateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseTimeRange(url: URL): { since: string; until: string } | null {
  const preset = (url.searchParams.get("timeframe") || "yesterday").trim();
  const now = new Date();
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
    actions: actions(row.actions),
    action_values: actions(row.action_values),
  };
}

async function readJsonBody(request: Request): Promise<JsonObject | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as JsonObject : null;
  } catch {
    return null;
  }
}

async function metaRequest(
  url: URL,
  token: string,
  init: RequestInit = {},
): Promise<JsonObject> {
  const headers = new Headers(init.headers || {});
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("User-Agent", "MARECommerceWorker/1.0");
  if (init.body) headers.set("Content-Type", "application/json");

  const response = await fetch(url.toString(), { ...init, headers });
  let payload: JsonObject = {};
  try {
    payload = await response.json() as JsonObject;
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const error = new Error(`Meta Marketing API request failed (${response.status})`) as MetaApiError;
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function fetchAllData(url: URL, token: string, maxPages = 50): Promise<JsonObject[]> {
  const rows: JsonObject[] = [];
  let current: URL | null = url;
  let pages = 0;
  while (current && pages < maxPages) {
    const payload = await metaRequest(current, token);
    if (Array.isArray(payload.data)) {
      for (const row of payload.data) {
        if (row && typeof row === "object" && !Array.isArray(row)) rows.push(row as JsonObject);
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
  const candidate = error as MetaApiError;
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
    message: candidate?.message || "Unknown Meta API error",
    ...(typeof candidate?.status === "number" ? { status: candidate.status } : {}),
    ...(cleanMetaError ? { meta_error: cleanMetaError } : {}),
  };
}

function stringField(body: JsonObject, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanField(body: JsonObject, key: string): boolean | undefined {
  return typeof body[key] === "boolean" ? body[key] as boolean : undefined;
}

function copyAllowed(body: JsonObject, keys: string[]): JsonObject {
  const payload: JsonObject = {};
  for (const key of keys) {
    const value = body[key];
    if (value !== undefined && value !== null) payload[key] = value;
  }
  return payload;
}

function safeStatus(body: JsonObject, defaultStatus?: string): { status?: string; error?: string } {
  const status = stringField(body, "status") || defaultStatus;
  if (!status) return {};
  const allowed = new Set(["ACTIVE", "PAUSED", "ARCHIVED", "DELETED"]);
  if (!allowed.has(status)) return { error: "invalid_status" };
  if (status === "ACTIVE" && body.confirm_active !== true) return { error: "active_requires_confirm_active_true" };
  return { status };
}

function objectEndpoint(env: MetaReportingEnv, id: string): URL {
  return new URL(`${META_GRAPH_BASE}/${graphVersion(env)}/${id}`);
}

function accountEndpoint(env: MetaReportingEnv, accountId: string, resource: string): URL {
  return new URL(`${META_GRAPH_BASE}/${graphVersion(env)}/act_${accountId}/${resource}`);
}

async function handleEntityList(url: URL, env: MetaReportingEnv, resource: string): Promise<Response> {
  const token = normalizeSecret(env.META_ADS_ACCESS_TOKEN);
  const accountId = normalizeAdAccountId(env.META_AD_ACCOUNT_ID);
  if (!token || !accountId) return jsonResponse({ ok: false, error: "meta_not_configured" }, 503);

  const endpoint = accountEndpoint(env, accountId, resource);
  endpoint.searchParams.set("fields", ENTITY_FIELDS[resource]);
  endpoint.searchParams.set("limit", "100");

  try {
    const rows = await fetchAllData(endpoint, token);
    return jsonResponse({
      ok: true,
      service: "meta_marketing",
      graph_api_version: graphVersion(env),
      account_id: accountId,
      resource,
      rows,
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: "meta_entity_read_failed", detail: safeError(error) }, 502);
  }
}

async function handleCampaignCreate(request: Request, env: MetaReportingEnv): Promise<Response> {
  const token = normalizeSecret(env.META_ADS_ACCESS_TOKEN);
  const accountId = normalizeAdAccountId(env.META_AD_ACCOUNT_ID);
  if (!token || !accountId) return jsonResponse({ ok: false, error: "meta_not_configured" }, 503);
  const body = await readJsonBody(request);
  if (!body) return jsonResponse({ ok: false, error: "invalid_json" }, 400);

  const name = stringField(body, "name");
  const objective = stringField(body, "objective");
  if (!name || !objective) return jsonResponse({ ok: false, error: "name_and_objective_required" }, 400);
  const statusResult = safeStatus(body, "PAUSED");
  if (statusResult.error) return jsonResponse({ ok: false, error: statusResult.error }, 400);

  const payload: JsonObject = {
    name,
    objective,
    status: statusResult.status,
    special_ad_categories: body.special_ad_categories ?? ["NONE"],
    buying_type: stringField(body, "buying_type") || "AUCTION",
    is_adset_budget_sharing_enabled: booleanField(body, "is_adset_budget_sharing_enabled") ?? false,
    ...copyAllowed(body, ["daily_budget", "lifetime_budget", "bid_strategy"]),
  };

  try {
    const result = await metaRequest(accountEndpoint(env, accountId, "campaigns"), token, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return jsonResponse({ ok: true, operation: "campaign_create", result }, 201);
  } catch (error) {
    return jsonResponse({ ok: false, error: "meta_campaign_create_failed", detail: safeError(error) }, 502);
  }
}

async function handleCampaignUpdate(request: Request, env: MetaReportingEnv, campaignId: string): Promise<Response> {
  const token = normalizeSecret(env.META_ADS_ACCESS_TOKEN);
  if (!token) return jsonResponse({ ok: false, error: "meta_not_configured" }, 503);
  const body = await readJsonBody(request);
  if (!body) return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  const statusResult = safeStatus(body);
  if (statusResult.error) return jsonResponse({ ok: false, error: statusResult.error }, 400);

  const payload = copyAllowed(body, ["name", "daily_budget", "lifetime_budget", "bid_strategy"]);
  if (statusResult.status) payload.status = statusResult.status;
  if (Object.keys(payload).length === 0) return jsonResponse({ ok: false, error: "no_mutable_fields" }, 400);

  try {
    const result = await metaRequest(objectEndpoint(env, campaignId), token, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return jsonResponse({ ok: true, operation: "campaign_update", campaign_id: campaignId, result });
  } catch (error) {
    return jsonResponse({ ok: false, error: "meta_campaign_update_failed", detail: safeError(error) }, 502);
  }
}

async function handleAdsetCreate(request: Request, env: MetaReportingEnv): Promise<Response> {
  const token = normalizeSecret(env.META_ADS_ACCESS_TOKEN);
  const accountId = normalizeAdAccountId(env.META_AD_ACCOUNT_ID);
  if (!token || !accountId) return jsonResponse({ ok: false, error: "meta_not_configured" }, 503);
  const body = await readJsonBody(request);
  if (!body) return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  const required = ["name", "campaign_id", "billing_event", "optimization_goal"];
  if (required.some((key) => !stringField(body, key))) return jsonResponse({ ok: false, error: "missing_required_adset_fields" }, 400);
  if (!body.targeting || typeof body.targeting !== "object") return jsonResponse({ ok: false, error: "targeting_required" }, 400);

  const statusResult = safeStatus(body, "PAUSED");
  if (statusResult.error) return jsonResponse({ ok: false, error: statusResult.error }, 400);
  const payload: JsonObject = {
    ...copyAllowed(body, [
      "name", "campaign_id", "billing_event", "optimization_goal", "targeting", "promoted_object",
      "daily_budget", "lifetime_budget", "bid_amount", "bid_strategy", "attribution_spec", "destination_type",
      "start_time", "end_time",
    ]),
    status: statusResult.status,
  };

  try {
    const result = await metaRequest(accountEndpoint(env, accountId, "adsets"), token, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return jsonResponse({ ok: true, operation: "adset_create", result }, 201);
  } catch (error) {
    return jsonResponse({ ok: false, error: "meta_adset_create_failed", detail: safeError(error) }, 502);
  }
}

async function handleAdsetUpdate(request: Request, env: MetaReportingEnv, adsetId: string): Promise<Response> {
  const token = normalizeSecret(env.META_ADS_ACCESS_TOKEN);
  if (!token) return jsonResponse({ ok: false, error: "meta_not_configured" }, 503);
  const body = await readJsonBody(request);
  if (!body) return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  const statusResult = safeStatus(body);
  if (statusResult.error) return jsonResponse({ ok: false, error: statusResult.error }, 400);

  const payload = copyAllowed(body, [
    "name", "daily_budget", "lifetime_budget", "bid_amount", "bid_strategy", "billing_event",
    "optimization_goal", "targeting", "promoted_object", "attribution_spec", "destination_type",
    "start_time", "end_time",
  ]);
  if (statusResult.status) payload.status = statusResult.status;
  if (Object.keys(payload).length === 0) return jsonResponse({ ok: false, error: "no_mutable_fields" }, 400);

  try {
    const result = await metaRequest(objectEndpoint(env, adsetId), token, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return jsonResponse({ ok: true, operation: "adset_update", adset_id: adsetId, result });
  } catch (error) {
    return jsonResponse({ ok: false, error: "meta_adset_update_failed", detail: safeError(error) }, 502);
  }
}

async function handleAdCreate(request: Request, env: MetaReportingEnv): Promise<Response> {
  const token = normalizeSecret(env.META_ADS_ACCESS_TOKEN);
  const accountId = normalizeAdAccountId(env.META_AD_ACCOUNT_ID);
  if (!token || !accountId) return jsonResponse({ ok: false, error: "meta_not_configured" }, 503);
  const body = await readJsonBody(request);
  if (!body) return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  if (!stringField(body, "name") || !stringField(body, "adset_id") || !body.creative) {
    return jsonResponse({ ok: false, error: "name_adset_id_creative_required" }, 400);
  }
  const statusResult = safeStatus(body, "PAUSED");
  if (statusResult.error) return jsonResponse({ ok: false, error: statusResult.error }, 400);
  const payload: JsonObject = {
    ...copyAllowed(body, ["name", "adset_id", "creative", "tracking_specs", "conversion_domain", "url_tags"]),
    status: statusResult.status,
  };

  try {
    const result = await metaRequest(accountEndpoint(env, accountId, "ads"), token, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return jsonResponse({ ok: true, operation: "ad_create", result }, 201);
  } catch (error) {
    return jsonResponse({ ok: false, error: "meta_ad_create_failed", detail: safeError(error) }, 502);
  }
}

async function handleAdUpdate(request: Request, env: MetaReportingEnv, adId: string): Promise<Response> {
  const token = normalizeSecret(env.META_ADS_ACCESS_TOKEN);
  if (!token) return jsonResponse({ ok: false, error: "meta_not_configured" }, 503);
  const body = await readJsonBody(request);
  if (!body) return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  const statusResult = safeStatus(body);
  if (statusResult.error) return jsonResponse({ ok: false, error: statusResult.error }, 400);
  const payload = copyAllowed(body, ["name"]);
  if (statusResult.status) payload.status = statusResult.status;
  if (Object.keys(payload).length === 0) return jsonResponse({ ok: false, error: "no_mutable_fields" }, 400);

  try {
    const result = await metaRequest(objectEndpoint(env, adId), token, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return jsonResponse({ ok: true, operation: "ad_update", ad_id: adId, result });
  } catch (error) {
    return jsonResponse({ ok: false, error: "meta_ad_update_failed", detail: safeError(error) }, 502);
  }
}

async function handleReport(url: URL, env: MetaReportingEnv): Promise<Response> {
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

  const endpoint = accountEndpoint(env, accountId, "insights");
  endpoint.searchParams.set("fields", fields);
  endpoint.searchParams.set("level", level);
  endpoint.searchParams.set("time_range", JSON.stringify(timeRange));
  endpoint.searchParams.set("action_report_time", "conversion");
  endpoint.searchParams.set("use_account_attribution_setting", "true");
  endpoint.searchParams.set("limit", "500");
  if (daily) endpoint.searchParams.set("time_increment", "1");

  try {
    const rawRows = await fetchAllData(endpoint, token);
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
      rows: rawRows.map((row) => safeRow(row as MetaInsightsRow)),
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: "meta_reporting_failed", detail: safeError(error) }, 502);
  }
}

export async function handleMetaReportingRequest(request: Request, env: MetaReportingEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/internal/meta/")) return null;

  if (url.pathname === "/internal/meta/health") {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    return jsonResponse({
      ok: true,
      service: "meta_marketing_bridge",
      graph_api_version: graphVersion(env),
      configured: {
        access_token: Boolean(normalizeSecret(env.META_ADS_ACCESS_TOKEN)),
        ad_account_id: Boolean(normalizeAdAccountId(env.META_AD_ACCOUNT_ID)),
        report_access_token: Boolean(reportingToken(env)),
        write_access_token: Boolean(normalizeSecret(env.META_WRITE_ACCESS_TOKEN)),
        pixel_id: Boolean(normalizeObjectId(env.META_PIXEL_ID)),
      },
    });
  }

  if (request.method === "GET") {
    if (!isReadAuthorized(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    if (url.pathname === "/internal/meta/report") return handleReport(url, env);
    for (const resource of Object.keys(ENTITY_FIELDS)) {
      if (url.pathname === `/internal/meta/${resource}`) return handleEntityList(url, env, resource);
    }
    return jsonResponse({ ok: false, error: "not_found" }, 404);
  }

  if (!isWriteAuthorized(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

  if (request.method === "POST" && url.pathname === "/internal/meta/campaigns") return handleCampaignCreate(request, env);
  if (request.method === "POST" && url.pathname === "/internal/meta/adsets") return handleAdsetCreate(request, env);
  if (request.method === "POST" && url.pathname === "/internal/meta/ads") return handleAdCreate(request, env);

  const campaignMatch = url.pathname.match(/^\/internal\/meta\/campaigns\/(\d{5,40})$/);
  if ((request.method === "PATCH" || request.method === "POST") && campaignMatch) {
    return handleCampaignUpdate(request, env, campaignMatch[1]);
  }
  const adsetMatch = url.pathname.match(/^\/internal\/meta\/adsets\/(\d{5,40})$/);
  if ((request.method === "PATCH" || request.method === "POST") && adsetMatch) {
    return handleAdsetUpdate(request, env, adsetMatch[1]);
  }
  const adMatch = url.pathname.match(/^\/internal\/meta\/ads\/(\d{5,40})$/);
  if ((request.method === "PATCH" || request.method === "POST") && adMatch) {
    return handleAdUpdate(request, env, adMatch[1]);
  }

  return jsonResponse({ ok: false, error: "not_found" }, 404);
}
