import {
  handleTikTokOAuthCallbackRequest,
  type MareBusinessTikTokSafeEnv,
} from "./mare-business-tiktok-safe.js";

type JsonObject = Record<string, unknown>;
type StoredTikTokAuthorization = {
  access_token: string;
  advertiser_id?: string;
  advertiser_ids?: string[];
  scope?: string[];
  updated_at: string;
};

const API_BASE = "https://business-api.tiktok.com/open_api/v1.3";
const TOKEN_KEY = "mare-business:tiktok:authorization";
const STATE_PREFIX = "mare-business:tiktok:oauth-state:";

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function handleTikTokOAuthFinalCallbackRequest(
  request: Request,
  env: MareBusinessTikTokSafeEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/auth/tiktok/start") return handleTikTokOAuthCallbackRequest(request, env);
  if (url.pathname !== "/auth/tiktok/callback") return null;
  if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);

  const appId = normalize(env.TIKTOK_APP_ID);
  const appSecret = normalize(env.TIKTOK_APP_SECRET);
  if (!appId || !appSecret || !env.SHOPIFY_TOKENS_KV) {
    return json({ ok: false, error: "tiktok_oauth_configuration_missing" }, 500);
  }

  const state = normalize(url.searchParams.get("state"));
  const authCode = normalize(url.searchParams.get("auth_code"));
  const stateKey = `${STATE_PREFIX}${state}`;
  const stateRaw = state ? await env.SHOPIFY_TOKENS_KV.get(stateKey) : null;
  if (!state || !authCode || !stateRaw) return json({ ok: false, error: "tiktok_oauth_state_or_code_invalid" }, 400);

  let stateRecord: { expected_advertiser_id?: string | null } = {};
  try { stateRecord = JSON.parse(stateRaw) as typeof stateRecord; } catch { stateRecord = {}; }
  if (env.SHOPIFY_TOKENS_KV.delete) await env.SHOPIFY_TOKENS_KV.delete(stateKey);

  const tokenResponse = await fetch(`${API_BASE}/oauth2/access_token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, secret: appSecret, auth_code: authCode }),
  });
  const tokenBody = await tokenResponse.json() as JsonObject;
  if (!tokenResponse.ok || Number(tokenBody.code) !== 0) {
    return json({ ok: false, error: `tiktok_token_error:${normalize(tokenBody.message) || tokenResponse.status}` }, 502);
  }

  const data = object(tokenBody.data);
  const accessToken = normalize(data.access_token);
  if (!accessToken) return json({ ok: false, error: "tiktok_oauth_token_missing" }, 502);

  const advertiserIds = Array.isArray(data.advertiser_ids)
    ? data.advertiser_ids.map((item) => normalize(item)).filter(Boolean)
    : [];
  const expectedAdvertiser = normalize(env.TIKTOK_ADVERTISER_ID) || normalize(stateRecord.expected_advertiser_id);

  if (expectedAdvertiser && !advertiserIds.includes(expectedAdvertiser)) {
    return json({
      ok: false,
      error: "tiktok_authorized_advertiser_not_proven",
      expected_advertiser_configured: true,
      advertiser_ids_returned: advertiserIds.length,
      authorization_persisted: false,
      raw_secret_values_exposed: false,
    }, 403);
  }

  const selectedAdvertiser = expectedAdvertiser || advertiserIds[0] || "";
  if (!selectedAdvertiser) {
    return json({
      ok: false,
      error: "tiktok_authorized_advertiser_missing",
      authorization_persisted: false,
      raw_secret_values_exposed: false,
    }, 403);
  }

  const scope = Array.isArray(data.scope)
    ? data.scope.map((item) => String(item)).filter(Boolean)
    : normalize(data.scope).split(",").map((item) => item.trim()).filter(Boolean);

  const stored: StoredTikTokAuthorization = {
    access_token: accessToken,
    advertiser_id: selectedAdvertiser,
    advertiser_ids: advertiserIds,
    scope,
    updated_at: new Date().toISOString(),
  };
  await env.SHOPIFY_TOKENS_KV.put(TOKEN_KEY, JSON.stringify(stored));

  return json({
    ok: true,
    source: "tiktok_marketing_api_oauth",
    authorized: true,
    advertiser_ids_found: advertiserIds,
    selected_advertiser_id: selectedAdvertiser,
    scope_count: scope.length,
    authorization_persisted: true,
    raw_secret_values_exposed: false,
    message: "TikTok Marketing API autorizzata. Puoi chiudere questa finestra.",
  }, 200);
}
