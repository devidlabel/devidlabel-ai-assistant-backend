import {
  handleTikTokOAuthCallbackRequest,
  type MareBusinessTikTokSafeEnv,
} from "./mare-business-tiktok-safe.js";

type JsonObject = Record<string, unknown>;

const TOKEN_KEY = "mare-business:tiktok:authorization";

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function handleTikTokOAuthFinalCallbackRequest(
  request: Request,
  env: MareBusinessTikTokSafeEnv,
): Promise<Response | null> {
  const response = await handleTikTokOAuthCallbackRequest(request, env);
  if (!response) return null;

  const url = new URL(request.url);
  const expectedAdvertiser = normalize(env.TIKTOK_ADVERTISER_ID);
  if (url.pathname !== "/auth/tiktok/callback" || !response.ok || !expectedAdvertiser) return response;

  let body: JsonObject = {};
  try { body = await response.clone().json() as JsonObject; } catch { body = {}; }
  const advertiserIds = Array.isArray(body.advertiser_ids_found)
    ? body.advertiser_ids_found.map((item) => normalize(item)).filter(Boolean)
    : [];

  if (!advertiserIds.includes(expectedAdvertiser)) {
    if (env.SHOPIFY_TOKENS_KV?.delete) {
      await env.SHOPIFY_TOKENS_KV.delete(TOKEN_KEY);
    }
    return new Response(JSON.stringify({
      ok: false,
      error: "tiktok_authorized_advertiser_not_proven",
      expected_advertiser_configured: true,
      advertiser_ids_returned: advertiserIds.length,
      authorization_persisted: false,
      raw_secret_values_exposed: false,
    }), {
      status: 403,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  return response;
}
