type JsonObject = Record<string, unknown>;

type KVNamespaceLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
};

export type MareBusinessTikTokSafeEnv = {
  MARE_BUSINESS_ACCESS_TOKEN?: string;
  TIKTOK_APP_ID?: string;
  TIKTOK_APP_SECRET?: string;
  TIKTOK_REDIRECT_URI?: string;
  TIKTOK_AUTHORIZATION_URL?: string;
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
  updated_at: string;
};

const API_BASE = "https://business-api.tiktok.com/open_api/v1.3";
const AUTH_BASE = "https://ads.tiktok.com/marketing_api/auth";
const TOKEN_KEY = "mare-business:tiktok:authorization";
const STATE_PREFIX = "mare-business:tiktok:oauth-state:";
const DEFAULT_REDIRECT_URI = "https://devidlabel-ai-assistant-backend.devidlabel.workers.dev/auth/tiktok/callback";
const STATE_TTL_SECONDS = 10 * 60;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function safeMarker(value: unknown): string {
  const cleaned = normalize(value).replace(/[^A-Za-z0-9]/g, "");
  if (cleaned.length < 8) throw new Error("tiktok_idempotency_key_required");
  return `MARE-${cleaned.slice(-16)}`;
}

function timingSafeEqualText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function loadStored(env: MareBusinessTikTokSafeEnv): Promise<StoredTikTokAuthorization | null> {
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

async function storeAuthorization(env: MareBusinessTikTokSafeEnv, authorization: StoredTikTokAuthorization): Promise<void> {
  if (!env.SHOPIFY_TOKENS_KV) throw new Error("tiktok_token_store_not_configured");
  await env.SHOPIFY_TOKENS_KV.put(TOKEN_KEY, JSON.stringify(authorization));
}

async function resolveAuthorization(env: MareBusinessTikTokSafeEnv): Promise<StoredTikTokAuthorization> {
  const stored = await loadStored(env);
  if (stored) return stored;
  const envToken = normalize(env.TIKTOK_ACCESS_TOKEN);
  if (!envToken) throw new Error("tiktok_not_authorized");
  return {
    access_token: envToken,
    advertiser_id: normalize(env.TIKTOK_ADVERTISER_ID) || undefined,
    updated_at: new Date().toISOString(),
  };
}

function resolveAdvertiserId(args: JsonObject, auth: StoredTikTokAuthorization, env: MareBusinessTikTokSafeEnv): string {
  const id = normalize(args.advertiser_id)
    || normalize(auth.advertiser_id)
    || normalize(env.TIKTOK_ADVERTISER_ID)
    || normalize(auth.advertiser_ids?.[0]);
  if (!/^\d{5,40}$/.test(id)) throw new Error("tiktok_advertiser_id_missing");
  return id;
}

async function apiRequest(
  method: "GET" | "POST",
  path: string,
  auth: StoredTikTokAuthorization,
  queryOrBody: JsonObject,
): Promise<JsonObject> {
  const url = new URL(`${API_BASE}${path}`);
  const init: RequestInit = {
    method,
    headers: { "Access-Token": auth.access_token, "Content-Type": "application/json" },
  };
  if (method === "GET") {
    for (const [key, value] of Object.entries(queryOrBody)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
  } else {
    init.body = JSON.stringify(queryOrBody);
  }
  const response = await fetch(url.toString(), init);
  const body = await response.json() as JsonObject;
  if (!response.ok || Number(body.code) !== 0) {
    throw new Error(`tiktok_api_error:${normalize(body.message) || response.status}`);
  }
  return body;
}

function campaignList(response: JsonObject): JsonObject[] {
  const data = object(response.data);
  return Array.isArray(data.list)
    ? data.list.filter((item) => item && typeof item === "object").map((item) => item as JsonObject)
    : [];
}

export async function tiktokSafeAuthorizationStatus(env: MareBusinessTikTokSafeEnv): Promise<JsonObject> {
  const stored = await loadStored(env);
  const configuredAdvertiser = normalize(env.TIKTOK_ADVERTISER_ID);
  const selectedAdvertiser = normalize(stored?.advertiser_id) || configuredAdvertiser || normalize(stored?.advertiser_ids?.[0]);
  return {
    ok: true,
    app_configured: Boolean(normalize(env.TIKTOK_APP_ID) && normalize(env.TIKTOK_APP_SECRET)),
    authorization_url_configured: Boolean(normalize(env.TIKTOK_AUTHORIZATION_URL)),
    redirect_uri: normalize(env.TIKTOK_REDIRECT_URI) || DEFAULT_REDIRECT_URI,
    kv_store_configured: Boolean(env.SHOPIFY_TOKENS_KV),
    access_token_present: Boolean(stored?.access_token || normalize(env.TIKTOK_ACCESS_TOKEN)),
    advertiser_id_present: Boolean(selectedAdvertiser),
    selected_advertiser_id: selectedAdvertiser || null,
    advertiser_ids_count: stored?.advertiser_ids?.length || 0,
    scope_count: stored?.scope?.length || 0,
    authorized: Boolean((stored?.access_token || normalize(env.TIKTOK_ACCESS_TOKEN)) && selectedAdvertiser),
    token_type: "marketing_api_long_term_access_token",
    raw_secret_values_exposed: false,
  };
}

export async function createTikTokAuthorizationUrl(env: MareBusinessTikTokSafeEnv): Promise<JsonObject> {
  const appId = normalize(env.TIKTOK_APP_ID);
  const appSecret = normalize(env.TIKTOK_APP_SECRET);
  const redirectUri = normalize(env.TIKTOK_REDIRECT_URI) || DEFAULT_REDIRECT_URI;
  if (!appId || !appSecret || !env.SHOPIFY_TOKENS_KV) throw new Error("tiktok_oauth_configuration_missing");
  const state = crypto.randomUUID().replace(/-/g, "");
  await env.SHOPIFY_TOKENS_KV.put(
    `${STATE_PREFIX}${state}`,
    JSON.stringify({ created_at: new Date().toISOString(), expected_advertiser_id: normalize(env.TIKTOK_ADVERTISER_ID) || null }),
    { expirationTtl: STATE_TTL_SECONDS },
  );
  const configuredAuthorizationUrl = normalize(env.TIKTOK_AUTHORIZATION_URL);
  const authorize = new URL(configuredAuthorizationUrl || AUTH_BASE);
  if (!authorize.searchParams.get("app_id")) authorize.searchParams.set("app_id", appId);
  authorize.searchParams.set("state", state);
  if (!authorize.searchParams.get("redirect_uri")) authorize.searchParams.set("redirect_uri", redirectUri);
  return {
    ok: true,
    authorization_url: authorize.toString(),
    expires_in_seconds: STATE_TTL_SECONDS,
    callback_uri: redirectUri,
    external_write_performed: false,
    raw_secret_values_exposed: false,
  };
}

export async function handleTikTokOAuthCallbackRequest(
  request: Request,
  env: MareBusinessTikTokSafeEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/auth/tiktok/start") {
    return new Response(JSON.stringify({
      ok: false,
      error: "tiktok_oauth_start_requires_authenticated_mare_prepare",
      instruction: "Use MARE Business OS capability tiktok.authorization.start.",
    }), { status: 401, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (url.pathname !== "/auth/tiktok/callback") return null;
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const appId = normalize(env.TIKTOK_APP_ID);
  const appSecret = normalize(env.TIKTOK_APP_SECRET);
  if (!appId || !appSecret || !env.SHOPIFY_TOKENS_KV) {
    return new Response(JSON.stringify({ ok: false, error: "tiktok_oauth_configuration_missing" }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const state = normalize(url.searchParams.get("state"));
  const authCode = normalize(url.searchParams.get("auth_code"));
  const stateKey = `${STATE_PREFIX}${state}`;
  const stateRaw = state ? await env.SHOPIFY_TOKENS_KV.get(stateKey) : null;
  if (!state || !authCode || !stateRaw) {
    return new Response(JSON.stringify({ ok: false, error: "tiktok_oauth_state_or_code_invalid" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if (env.SHOPIFY_TOKENS_KV.delete) await env.SHOPIFY_TOKENS_KV.delete(stateKey);
  let stateRecord: { expected_advertiser_id?: string | null } = {};
  try { stateRecord = JSON.parse(stateRaw) as typeof stateRecord; } catch { stateRecord = {}; }

  const response = await fetch(`${API_BASE}/oauth2/access_token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, secret: appSecret, auth_code: authCode }),
  });
  const body = await response.json() as JsonObject;
  if (!response.ok || Number(body.code) !== 0) {
    return new Response(JSON.stringify({ ok: false, error: `tiktok_token_error:${normalize(body.message) || response.status}` }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const data = object(body.data);
  const accessToken = normalize(data.access_token);
  const advertiserIds = Array.isArray(data.advertiser_ids) ? data.advertiser_ids.map((item) => normalize(item)).filter(Boolean) : [];
  const configuredExpected = normalize(env.TIKTOK_ADVERTISER_ID) || normalize(stateRecord.expected_advertiser_id);
  if (!accessToken) {
    return new Response(JSON.stringify({ ok: false, error: "tiktok_oauth_token_missing" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if (configuredExpected && advertiserIds.length && !advertiserIds.includes(configuredExpected)) {
    return new Response(JSON.stringify({ ok: false, error: "tiktok_authorized_advertiser_mismatch" }), {
      status: 403,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const scope = Array.isArray(data.scope)
    ? data.scope.map((item) => String(item)).filter(Boolean)
    : normalize(data.scope).split(",").map((item) => item.trim()).filter(Boolean);
  const stored: StoredTikTokAuthorization = {
    access_token: accessToken,
    advertiser_id: configuredExpected || advertiserIds[0] || undefined,
    advertiser_ids: advertiserIds,
    scope,
    updated_at: new Date().toISOString(),
  };
  await storeAuthorization(env, stored);
  return new Response(JSON.stringify({
    ok: true,
    source: "tiktok_marketing_api_oauth",
    authorized: true,
    advertiser_ids_found: advertiserIds,
    selected_advertiser_id: stored.advertiser_id || null,
    scope_count: scope.length,
    raw_secret_values_exposed: false,
    message: "TikTok Marketing API autorizzata. Puoi chiudere questa finestra.",
  }), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function readTikTokCampaignsSafe(args: JsonObject, env: MareBusinessTikTokSafeEnv): Promise<JsonObject> {
  const auth = await resolveAuthorization(env);
  const advertiserId = resolveAdvertiserId(args, auth, env);
  return apiRequest("GET", "/campaign/get/", auth, {
    advertiser_id: advertiserId,
    page: integer(args.page, 1, 1, 10000),
    page_size: integer(args.page_size, 50, 1, 1000),
    filtering: object(args.filtering),
  });
}

export async function createTikTokCampaignSafe(args: JsonObject, env: MareBusinessTikTokSafeEnv): Promise<JsonObject> {
  if (normalize(args.approval_confirmation) !== "CREATE TIKTOK CAMPAIGN PAUSED") {
    throw new Error("tiktok_create_confirmation_required");
  }
  const auth = await resolveAuthorization(env);
  const advertiserId = resolveAdvertiserId(args, auth, env);
  const marker = safeMarker(args.idempotency_key);
  const existingResponse = await apiRequest("GET", "/campaign/get/", auth, {
    advertiser_id: advertiserId,
    page: 1,
    page_size: 1000,
  });
  const existing = campaignList(existingResponse).find((campaign) => normalize(campaign.campaign_name).includes(marker));
  if (existing) {
    return {
      ok: true,
      status: "existing_campaign",
      idempotent_replay: true,
      data: existing,
      safety: { forced_operation_status: "DISABLE", activation_performed: false, marker },
    };
  }
  const payload: JsonObject = { ...object(args.payload), advertiser_id: advertiserId };
  delete payload.campaign_id;
  const requestedName = normalize(payload.campaign_name);
  if (!requestedName) throw new Error("tiktok_campaign_name_required");
  if (!normalize(payload.objective_type)) throw new Error("tiktok_objective_type_required");
  payload.campaign_name = `${requestedName} [${marker}]`.slice(0, 512);
  payload.operation_status = "DISABLE";
  const response = await apiRequest("POST", "/campaign/create/", auth, payload);
  return { ...response, safety: { forced_operation_status: "DISABLE", activation_performed: false, marker } };
}

export async function updateTikTokCampaignSafe(args: JsonObject, env: MareBusinessTikTokSafeEnv): Promise<JsonObject> {
  const confirmation = normalize(args.approval_confirmation);
  if (!["UPDATE TIKTOK CAMPAIGN", "ENABLE TIKTOK CAMPAIGN", "PAUSE TIKTOK CAMPAIGN"].includes(confirmation)) {
    throw new Error("tiktok_update_confirmation_required");
  }
  const auth = await resolveAuthorization(env);
  const advertiserId = resolveAdvertiserId(args, auth, env);
  const payload: JsonObject = { ...object(args.payload), advertiser_id: advertiserId };
  const campaignId = normalize(payload.campaign_id);
  if (!/^\d{5,40}$/.test(campaignId)) throw new Error("tiktok_campaign_id_required");
  const operationStatus = normalize(payload.operation_status).toUpperCase();
  if (operationStatus) {
    if (!new Set(["ENABLE", "DISABLE"]).has(operationStatus)) throw new Error("tiktok_operation_status_not_allowed");
    if (operationStatus === "ENABLE" && confirmation !== "ENABLE TIKTOK CAMPAIGN") throw new Error("tiktok_enable_confirmation_required");
    if (operationStatus === "DISABLE" && confirmation !== "PAUSE TIKTOK CAMPAIGN") throw new Error("tiktok_pause_confirmation_required");
    const response = await apiRequest("POST", "/campaign/status/update/", auth, {
      advertiser_id: advertiserId,
      campaign_ids: [campaignId],
      operation_status: operationStatus,
    });
    return { ...response, safety: { status_change_only: true, operation_status: operationStatus } };
  }
  if (confirmation !== "UPDATE TIKTOK CAMPAIGN") throw new Error("tiktok_field_update_confirmation_required");
  const response = await apiRequest("POST", "/campaign/update/", auth, payload);
  return { ...response, safety: { activation_performed: false, status_change_performed: false } };
}

export function businessTokenMatches(request: Request, env: MareBusinessTikTokSafeEnv): boolean {
  const expected = normalize(env.MARE_BUSINESS_ACCESS_TOKEN);
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : normalize(request.headers.get("X-MARE-BUSINESS-Key"));
  return Boolean(expected) && timingSafeEqualText(expected, supplied);
}
