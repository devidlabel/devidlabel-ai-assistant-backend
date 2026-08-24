type JsonObject = Record<string, unknown>;

type KlaviyoAudienceInventoryEnv = {
  KLAVIYO_PRIVATE_API_KEY?: string;
  KLAVIYO_OPERATIONS_API_KEY?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
  DAILY_PULSE_ACCESS_TOKEN?: string;
};

const KLAVIYO_API_BASE = "https://a.klaviyo.com";
const KLAVIYO_REVISION = "2026-07-15";
const MAX_PAGES = 100;
const SPRAYGROUND_IDS = new Set(["ShWyu9", "UFqNst", "W286ix", "WYUdKH", "UsAH79", "RpnuJf", "SW5AMm", "VGjrR5", "WsPZgJ", "Re2ZyU"]);

function normalize(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function asObject(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function jsonResponse(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
function timingSafeEqualText(left: string, right: string): boolean { if (!left || !right || left.length !== right.length) return false; let diff = 0; for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i); return diff === 0; }
function isAuthorized(request: Request, env: KlaviyoAudienceInventoryEnv): boolean {
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const accepted = [normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN), normalize(env.DAILY_PULSE_ACCESS_TOKEN)].filter(Boolean);
  return accepted.some((expected) => timingSafeEqualText(supplied, expected));
}
async function klaviyoGet(pathOrUrl: string, apiKey: string): Promise<JsonObject> {
  const url = pathOrUrl.startsWith("http") ? new URL(pathOrUrl) : new URL(KLAVIYO_API_BASE + pathOrUrl);
  if (url.protocol !== "https:" || url.hostname !== "a.klaviyo.com" || !url.pathname.startsWith("/api/")) throw new Error("klaviyo_pagination_url_rejected");
  const response = await fetch(url.toString(), { headers: { Accept: "application/vnd.api+json", Authorization: `Klaviyo-API-Key ${apiKey}`, revision: KLAVIYO_REVISION } });
  let body: JsonObject = {}; try { body = await response.json() as JsonObject; } catch {}
  if (!response.ok) {
    const errors = Array.isArray(body.errors) ? body.errors : [];
    const first = errors.length ? asObject(errors[0]) : {};
    const detail = normalize(first.detail) || normalize(first.title) || normalize(first.code);
    const error = new Error(`klaviyo_audience_inventory_failed_${response.status}${detail ? `:${detail.slice(0,180)}` : ""}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return body;
}
async function collect(kind: "lists" | "segments", apiKey: string): Promise<JsonObject[]> {
  const rows: JsonObject[] = [];
  const pageSize = kind === "segments" ? 10 : 100;
  const fields = kind === "segments" ? "&fields[segment]=name,definition,created,updated" : "";
  let next: string | null = `/api/${kind}?page[size]=${pageSize}&sort=-updated${fields}`;
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
  const id = normalize(row.id);
  return {
    id: id || null,
    type: kind,
    name: normalize(attributes.name) || null,
    created: attributes.created || attributes.created_at || null,
    updated: attributes.updated || attributes.updated_at || null,
    ...(kind === "segment" && SPRAYGROUND_IDS.has(id) ? { definition: attributes.definition ?? null } : {}),
  };
}

export async function handleKlaviyoAudienceInventoryRequest(request: Request, env: KlaviyoAudienceInventoryEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/internal/klaviyo/audience-inventory") return null;
  if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  const segmentsOnly = url.searchParams.get("segments_only") === "1";

  const candidates = [
    { mode: "private_reporting", key: normalize(env.KLAVIYO_PRIVATE_API_KEY) },
    { mode: "operations", key: normalize(env.KLAVIYO_OPERATIONS_API_KEY) },
  ].filter((item) => item.key);
  if (!candidates.length) return jsonResponse({ ok: false, error: "klaviyo_audience_read_key_not_configured" }, 503);

  const attempts: JsonObject[] = [];
  for (const candidate of candidates) {
    try {
      if (segmentsOnly) {
        const segments = await collect("segments", candidate.key);
        return jsonResponse({
          ok: true,
          service: "klaviyo_audience_inventory",
          revision: KLAVIYO_REVISION,
          generated_at: new Date().toISOString(),
          credential_mode: candidate.mode,
          scope_probe: "segments_only",
          counts: { lists: null, segments: segments.length },
          audiences: segments.map((row) => compact("segment", row)),
          attempts,
          notes: ["Read-only segment metadata only; no individual profile data is returned.", "Definitions are included only for segment IDs referenced by the approved Sprayground plan or its validated brand-buyer source segments."],
        });
      }
      const [lists, segments] = await Promise.all([collect("lists", candidate.key), collect("segments", candidate.key)]);
      return jsonResponse({
        ok: true,
        service: "klaviyo_audience_inventory",
        revision: KLAVIYO_REVISION,
        generated_at: new Date().toISOString(),
        credential_mode: candidate.mode,
        counts: { lists: lists.length, segments: segments.length },
        audiences: [...lists.map((row) => compact("list", row)), ...segments.map((row) => compact("segment", row))],
        attempts,
        notes: ["Read-only metadata only; no individual profile data is returned.", "Definitions are included only for segment IDs referenced by the approved Sprayground plan or its validated brand-buyer source segments."],
      });
    } catch (error) {
      const detail = error as Error & { status?: number };
      attempts.push({ mode: candidate.mode, status: detail.status ?? null, error: detail.message });
      if (detail.status === 429) return jsonResponse({ ok: false, error: detail.message, status: 429, attempts }, 429);
    }
  }
  return jsonResponse({ ok: false, error: segmentsOnly ? "klaviyo_segment_scope_unavailable" : "klaviyo_audience_inventory_all_keys_forbidden", attempts }, 502);
}
