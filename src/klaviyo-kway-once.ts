type JsonObject = Record<string, unknown>;

type KwayKlaviyoEnv = {
  KLAVIYO_PRIVATE_API_KEY?: string;
  KLAVIYO_OPERATIONS_API_KEY?: string;
};

type GithubOidcClaims = {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  repository?: string;
  repository_owner?: string;
  ref?: string;
  event_name?: string;
  actor?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
};

const PATH = "/internal/ops/kway-klaviyo-2026-08-11";
const REVISION = "2026-07-15";
const API_BASE = "https://a.klaviyo.com";
const GITHUB_REPOSITORY = "devidlabel/devidlabel-ai-assistant-backend";
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const OIDC_AUDIENCE = "devidlabel-kway-klaviyo-2026-08-11";
const EXECUTION_REF = "refs/heads/ops/execute-kway-klaviyo-2026-08-11";
const EXECUTION_SUBJECT = `repo:${GITHUB_REPOSITORY}:ref:${EXECUTION_REF}`;

function json(body: JsonObject, status = 200): Response {
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

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function b64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64json<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(b64(value))) as T;
}

async function isOidc(token: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length < 100 || token.length > 12000) return false;
  try {
    const header = b64json<{ alg?: string; kid?: string }>(parts[0]);
    const claims = b64json<GithubOidcClaims>(parts[1]);
    if (header.alg !== "RS256" || !header.kid) return false;
    const now = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud.includes(OIDC_AUDIENCE) : claims.aud === OIDC_AUDIENCE;
    if (
      claims.iss !== OIDC_ISSUER || !aud || claims.repository !== GITHUB_REPOSITORY ||
      claims.repository_owner !== "devidlabel" || claims.ref !== EXECUTION_REF ||
      claims.sub !== EXECUTION_SUBJECT || claims.event_name !== "push" ||
      typeof claims.exp !== "number" || claims.exp < now - 30 || claims.exp > now + 900 ||
      typeof claims.iat !== "number" || claims.iat > now + 30 || claims.iat < now - 900 ||
      (typeof claims.nbf === "number" && claims.nbf > now + 30)
    ) return false;

    const cfgRes = await fetch(`${OIDC_ISSUER}/.well-known/openid-configuration`, { headers: { Accept: "application/json" } });
    if (!cfgRes.ok) return false;
    const cfg = await cfgRes.json() as { issuer?: string; jwks_uri?: string };
    if (cfg.issuer !== OIDC_ISSUER || !cfg.jwks_uri) return false;
    const jwksUrl = new URL(cfg.jwks_uri);
    if (jwksUrl.protocol !== "https:" || jwksUrl.hostname !== "token.actions.githubusercontent.com") return false;
    const jwksRes = await fetch(jwksUrl.toString(), { headers: { Accept: "application/json" } });
    if (!jwksRes.ok) return false;
    const jwks = await jwksRes.json() as { keys?: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }> };
    const jwk = (jwks.keys || []).find((key) => key.kid === header.kid && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, Uint8Array.from(b64(parts[2])).buffer, Uint8Array.from(signed).buffer);
  } catch {
    return false;
  }
}

async function authorized(request: Request): Promise<boolean> {
  const auth = request.headers.get("Authorization") || "";
  return auth.startsWith("Bearer ") && isOidc(auth.slice(7).trim());
}

async function kfetch(apiKey: string, path: string): Promise<{ ok: boolean; status: number; body: JsonObject }> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      Accept: "application/vnd.api+json",
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      revision: REVISION,
    },
  });
  let body: JsonObject = {};
  try { body = await response.json() as JsonObject; } catch { body = {}; }
  return { ok: response.ok, status: response.status, body };
}

async function getAllMetrics(apiKey: string): Promise<Array<{ id: string; name: string; integration: string }>> {
  const out: Array<{ id: string; name: string; integration: string }> = [];
  let path = "/api/metrics?page[size]=100";
  for (let page = 0; page < 10 && path; page += 1) {
    const result = await kfetch(apiKey, path);
    if (!result.ok) throw new Error(`metrics_${result.status}`);
    const data = Array.isArray(result.body.data) ? result.body.data : [];
    for (const item of data) {
      const row = asObject(item);
      const attrs = asObject(row.attributes);
      const integration = asObject(attrs.integration);
      out.push({ id: normalize(row.id), name: normalize(attrs.name), integration: normalize(integration.name) });
    }
    const links = asObject(result.body.links);
    const next = normalize(links.next);
    path = next ? next.replace(API_BASE, "") : "";
  }
  return out;
}

async function getKwaySegments(apiKey: string): Promise<JsonObject[]> {
  const result = await kfetch(apiKey, "/api/segments?page[size]=10&fields[segment]=name,definition,is_active,is_processing,created,updated");
  if (!result.ok) throw new Error(`segments_${result.status}`);
  const data = Array.isArray(result.body.data) ? result.body.data : [];
  const matches = data.filter((item) => {
    const attrs = asObject(asObject(item).attributes);
    return /k[\s-]?way/i.test(normalize(attrs.name));
  });
  const out: JsonObject[] = [];
  for (const item of matches) {
    const row = asObject(item);
    const id = normalize(row.id);
    const detail = await kfetch(apiKey, `/api/segments/${encodeURIComponent(id)}?additional-fields[segment]=profile_count&fields[segment]=name,definition,is_active,is_processing,profile_count,created,updated`);
    if (detail.ok) out.push(asObject(detail.body.data));
    else out.push({ id, error_status: detail.status, attributes: asObject(row.attributes) });
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  return out;
}

async function getCampaigns(apiKey: string): Promise<JsonObject[]> {
  const filter = encodeURIComponent("equals(messages.channel,'email')");
  const result = await kfetch(apiKey, `/api/campaigns?filter=${filter}&include=campaign-messages&page[size]=50&sort=-created_at`);
  if (!result.ok) throw new Error(`campaigns_${result.status}`);
  const data = Array.isArray(result.body.data) ? result.body.data : [];
  return data.slice(0, 40).map((item) => {
    const row = asObject(item);
    const attrs = asObject(row.attributes);
    return {
      id: normalize(row.id),
      name: normalize(attrs.name),
      status: normalize(attrs.status),
      created_at: attrs.created_at ?? null,
      updated_at: attrs.updated_at ?? null,
      send_strategy: attrs.send_strategy ?? null,
      audiences: attrs.audiences ?? null,
      send_options: attrs.send_options ?? null,
    };
  });
}

export async function handleKwayKlaviyoOnce(request: Request, env: KwayKlaviyoEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PATH) return null;
  if (request.method !== "GET") return json({ ok: false, operation: "kway_klaviyo", reason: "method_not_allowed" }, 405);
  if (!(await authorized(request))) return json({ ok: false, operation: "kway_klaviyo", reason: "not_found" }, 404);

  const privateKey = normalize(env.KLAVIYO_PRIVATE_API_KEY);
  const operationsKey = normalize(env.KLAVIYO_OPERATIONS_API_KEY);
  if (!privateKey && !operationsKey) return json({ ok: false, operation: "kway_klaviyo", reason: "klaviyo_keys_missing" }, 412);

  const readKey = privateKey || operationsKey;
  const campaignKey = operationsKey || privateKey;
  const result: JsonObject = {
    ok: true,
    operation: "kway_klaviyo",
    phase: "preflight",
    mutation_performed: false,
    generated_at: new Date().toISOString(),
    configured: { private_key: Boolean(privateKey), operations_key: Boolean(operationsKey) },
  };

  try {
    const metrics = await getAllMetrics(readKey);
    result.metrics = metrics.filter((metric) => /viewed product|added to cart|started checkout|placed order|ordered product|checkout/i.test(metric.name));
  } catch (error) {
    result.metrics_error = error instanceof Error ? error.message : "metrics_failed";
  }

  try { result.kway_segments = await getKwaySegments(readKey); }
  catch (error) { result.segments_error = error instanceof Error ? error.message : "segments_failed"; }

  try { result.campaigns = await getCampaigns(campaignKey); }
  catch (error) { result.campaigns_error = error instanceof Error ? error.message : "campaigns_failed"; }

  return json(result);
}
