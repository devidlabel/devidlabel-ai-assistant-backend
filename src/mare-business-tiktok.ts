type JsonObject = Record<string, unknown>;

type KVNamespaceLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
};

export type MareBusinessTikTokEnv = {
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

async function loadStored(env: MareBusinessTikTokEnv): Promise<StoredTikTokAuthorization | null> {
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

async function storeAuthorization(env: MareBusinessTikTokEnv, authorization: StoredTikTokAuthorization): Promise<void> {
  if (!env.SHOPIFY_TOKENS_KV) throw new Error("tiktok_token_store_not_configured");
  await env.SHOPIFY_TOKENS_KV.put(TOKEN_KEY, JSON.stringify(authorization));
}

async function exchangeLongTermAccessToken(env: MareBusinessTikTokEnv, authCode: string): Promise<JsonObject> {
  const appId = normalize(env.TIKTOK_APP_ID);
  const secret = normalize(env.TIKTOK_APP_SECRET);
  if (!appId || !secret) throw new Error("tiktok_app_credentials_missing");
  const response = await fetch(`${API_BASE}/oauth2/access_token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, secret, auth_code: authCode }),
  });
  const body = await response.json() as JsonObject;
  if (!response.ok || Number(body.code) !== 0) throw new Error(`tiktok_token_error:${normalize(body.message) || response.status}`);
  return object(body.data);
}

async function resolveAuthorization(env: MareBusinessTikTokEnv): Promise<StoredTikTokAuthorization> {
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

function advertiserId(args: JsonObject, auth: StoredTikTokAuthorization, env: MareBusinessTikTokEnv): string {
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
  if (!response.ok || Number(body.code) !== 0) throw new Error(`tiktok_api_error:${normalize(body.message) || response.status}`);
  return body;
}

export async function tiktokAuthorizationStatus(env: MareBusinessTikTokEnv): Promise<JsonObject> {
  const stored = await loadStored(env);
  return {
    ok: true,
    app_configured: Boolean(normalize(env.TIKTOK_APP_ID) && normalize(env.TIKTOK_APP_SECRET)),
    authorization_url_configured: Boolean(normalize(env.TIKTOK_AUTHORIZATION_URL)),
    redirect_uri: normalize(env.TIKTOK_REDIRECT_URI) || DEFAULT_REDIRECT_URI,
    kv_store_configured: Boolean(env.SHOPIFY_TOKENS_KV),
    access_token_present: Boolean(stored?.access_token || normalize(env.TIKTOK_ACCESS_TOKEN)),
    advertiser_id_present: Boolean(stored?.advertiser_id || stored?.advertiser_ids?.length || normalize(env.TIKTOK_ADVERTISER_ID)),
    advertiser_ids_count: stored?.advertiser_ids?.length || 0,
    scope_count: stored?.scope?.length || 0,
    token_type: "marketing_api_long_term_access_token",
    raw_secret_values_exposed: false,
  };
}

export async function handleTikTokOAuthRequest(request: Request, env: MareBusinessTikTokEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/auth/tiktok/start" && url.pathname !== "/auth/tiktok/callback") return null;
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }
  const appId = normalize(env.TIKTOK_APP_ID);
  const appSecret = normalize(env.TIKTOK_APP_SECRET);
  const redirectUri = normalize(env.TIKTOK_REDIRECT_URI) || DEFAULT_REDIRECT_URI;
  if (!appId || !appSecret || !env.SHOPIFY_TOKENS_KV) {
    return new Response(JSON.stringify({ ok: false, error: "tiktok_oauth_configuration_missing" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (url.pathname === "/auth/tiktok/start") {
    const state = crypto.randomUUID().replace(/-/g, "");
    await env.SHOPIFY_TOKENS_KV.put(
      `${STATE_PREFIX}${state}`,
      JSON.stringify({ created_at: new Date().toISOString() }),
      { expirationTtl: STATE_TTL_SECONDS },
    );
    const configuredAuthorizationUrl = normalize(env.TIKTOK_AUTHORIZATION_URL);
    const authorize = new URL(configuredAuthorizationUrl || AUTH_BASE);
    if (!authorize.searchParams.get("app_id")) authorize.searchParams.set("app_id", appId);
    authorize.searchParams.set("state", state);
    if (!authorize.searchParams.get("redirect_uri")) authorize.searchParams.set("redirect_uri", redirectUri);
    return new Response(null, { status: 302, headers: { Location: authorize.toString(), "Cache-Control": "no-store" } });
  }

  const state = normalize(url.searchParams.get("state"));
  const authCode = normalize(url.searchParams.get("auth_code"));
  const stateRecord = state ? await env.SHOPIFY_TOKENS_KV.get(`${STATE_PREFIX}${state}`) : null;
  if (!state || !authCode || !stateRecord) {
    return new Response(JSON.stringify({ ok: false, error: "tiktok_oauth_state_or_code_invalid" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (env.SHOPIFY_TOKENS_KV.delete) await env.SHOPIFY_TOKENS_KV.delete(`${STATE_PREFIX}${state}`);
  const data = await exchangeLongTermAccessToken(env, authCode);
  const accessToken = normalize(data.access_token);
  if (!accessToken) {
    return new Response(JSON.stringify({ ok: false, error: "tiktok_oauth_token_missing" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  const advertiserIds = Array.isArray(data.advertiser_ids) ? data.advertiser_ids.map(normalize).filter(Boolean) : [];
  const scope = Array.isArray(data.scope)
    ? data.scope.map((item) => String(item)).filter(Boolean)
    : normalize(data.scope).split(",").map((item) => item.trim()).filter(Boolean);
  const stored: StoredTikTokAuthorization = {
    access_token: accessToken,
    advertiser_id: normalize(env.TIKTOK_ADVERTISER_ID) || advertiserIds[0] || undefined,
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

export async function readTikTokCampaigns(args: JsonObject, env: MareBusinessTikTokEnv): Promise<JsonObject> {
  const auth = await resolveAuthorization(env);
  const id = advertiserId(args, auth, env);
  return apiRequest("GET", "/campaign/get/", auth, {
    advertiser_id: id,
    page: integer(args.page, 1, 1, 10000),
    page_size: integer(args.page_size, 50, 1, 1000),
    filtering: object(args.filtering),
  });
}

export async function createTikTokCampaign(args: JsonObject, env: MareBusinessTikTokEnv): Promise<JsonObject> {
  if (normalize(args.approval_confirmation) !== "CREATE TIKTOK CAMPAIGN PAUSED") {
    throw new Error("tiktok_create_confirmation_required");
  }
  const auth = await resolveAuthorization(env);
  const id = advertiserId(args, auth, env);
  const payload = { ...object(args.payload), advertiser_id: id };
  delete payload.campaign_id;
  if (!normalize(payload.campaign_name)) throw new Error("tiktok_campaign_name_required");
  if (!normalize(payload.objective_type)) throw new Error("tiktok_objective_type_required");
  payload.operation_status = "DISABLE";
  const response = await apiRequest("POST", "/campaign/create/", auth, payload);
  return { ...response, safety: { forced_operation_status: "DISABLE", activation_performed: false } };
}

export async function updateTikTokCampaign(args: JsonObject, env: MareBusinessTikTokEnv): Promise<JsonObject> {
  const confirmation = normalize(args.approval_confirmation);
  if (!["UPDATE TIKTOK CAMPAIGN", "ENABLE TIKTOK CAMPAIGN", "PAUSE TIKTOK CAMPAIGN"].includes(confirmation)) {
    throw new Error("tiktok_update_confirmation_required");
  }
  const auth = await resolveAuthorization(env);
  const id = advertiserId(args, auth, env);
  const payload = { ...object(args.payload), advertiser_id: id };
  const campaignId = normalize(payload.campaign_id);
  if (!/^\d{5,40}$/.test(campaignId)) throw new Error("tiktok_campaign_id_required");
  const operationStatus = normalize(payload.operation_status).toUpperCase();

  if (operationStatus) {
    if (!new Set(["ENABLE", "DISABLE"]).has(operationStatus)) throw new Error("tiktok_operation_status_not_allowed");
    if (operationStatus === "ENABLE" && confirmation !== "ENABLE TIKTOK CAMPAIGN") throw new Error("tiktok_enable_confirmation_required");
    if (operationStatus === "DISABLE" && confirmation !== "PAUSE TIKTOK CAMPAIGN") throw new Error("tiktok_pause_confirmation_required");
    const response = await apiRequest("POST", "/campaign/status/update/", auth, {
      advertiser_id: id,
      campaign_ids: [campaignId],
      operation_status: operationStatus,
    });
    return { ...response, safety: { status_change_only: true, operation_status: operationStatus } };
  }

  if (confirmation !== "UPDATE TIKTOK CAMPAIGN") throw new Error("tiktok_field_update_confirmation_required");
  const response = await apiRequest("POST", "/campaign/update/", auth, payload);
  return { ...response, safety: { activation_performed: false, status_change_performed: false } };
}
