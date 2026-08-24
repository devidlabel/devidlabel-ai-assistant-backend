type JsonObject = Record<string, unknown>;

type KlaviyoAudienceInventoryEnv = {
  KLAVIYO_PRIVATE_API_KEY?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
  DAILY_PULSE_ACCESS_TOKEN?: string;
};

const KLAVIYO_API_BASE = "https://a.klaviyo.com";
const KLAVIYO_REVISION = "2026-07-15";
const MAX_PAGES = 100;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

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

function timingSafeEqualText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function isAuthorized(request: Request, env: KlaviyoAudienceInventoryEnv): boolean {
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const accepted = [normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN), normalize(env.DAILY_PULSE_ACCESS_TOKEN)].filter(Boolean);
  return accepted.some((expected) => timingSafeEqualText(supplied, expected));
}

async function klaviyoGet(pathOrUrl: string, apiKey: string): Promise<JsonObject> {
  const url = pathOrUrl.startsWith("http") ? new URL(pathOrUrl) : new URL(KLAVIYO_API_BASE + pathOrUrl);
  if (url.protocol !== "https:" || url.hostname !== "a.klaviyo.com" || !url.pathname.startsWith("/api/")) {
    throw new Error("klaviyo_pagination_url_rejected");
  }
  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/vnd.api+json",
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      revision: KLAVIYO_REVISION,
    },
  });
  let body: JsonObject = {};
  try { body = await response.json() as JsonObject; } catch {}
  if (!response.ok) {
    const error = new Error(`klaviyo_audience_inventory_failed_${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return body;
}

async function collect(kind: "lists" | "segments", apiKey: string): Promise<JsonObject[]> {
  const rows: JsonObject[] = [];
  let next: string | null = `/api/${kind}?page[size]=100&sort=-updated`;
  let pages = 0;
  while (next && pages < MAX_PAGES) {
    const body = await klaviyoGet(next, apiKey);
    if (Array.isArray(body.data)) rows.push(...body.data.map((row) => asObject(row)));
    next = normalize(asObject(body.links).next) || null;
    pages += 1;
  }
  return rows;
}

function compact(kind: "list" | "segment", row: JsonObject): JsonObject {
  const attributes = asObject(row.attributes);
  return {
    id: normalize(row.id) || null,
    type: kind,
    name: normalize(attributes.name) || null,
    created: attributes.created || attributes.created_at || null,
    updated: attributes.updated || attributes.updated_at || null,
    is_active: attributes.is_active ?? null,
    is_processing: attributes.is_processing ?? null,
  };
}

export async function handleKlaviyoAudienceInventoryRequest(
  request: Request,
  env: KlaviyoAudienceInventoryEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/internal/klaviyo/audience-inventory") return null;
  if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

  const apiKey = normalize(env.KLAVIYO_PRIVATE_API_KEY);
  if (!apiKey) return jsonResponse({ ok: false, error: "klaviyo_private_api_key_not_configured" }, 503);

  try {
    const [lists, segments] = await Promise.all([collect("lists", apiKey), collect("segments", apiKey)]);
    return jsonResponse({
      ok: true,
      service: "klaviyo_audience_inventory",
      revision: KLAVIYO_REVISION,
      generated_at: new Date().toISOString(),
      counts: { lists: lists.length, segments: segments.length },
      audiences: [
        ...lists.map((row) => compact("list", row)),
        ...segments.map((row) => compact("segment", row)),
      ],
      notes: ["Read-only metadata only; no individual profile data is returned."],
    });
  } catch (error) {
    const candidate = error as Error & { status?: number };
    return jsonResponse({ ok: false, error: candidate.message || "klaviyo_audience_inventory_failed", status: candidate.status || null }, candidate.status === 429 ? 429 : 502);
  }
}
