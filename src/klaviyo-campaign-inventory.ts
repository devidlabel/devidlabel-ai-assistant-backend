type JsonObject = Record<string, unknown>;

type KlaviyoCampaignInventoryEnv = {
  KLAVIYO_PRIVATE_API_KEY?: string;
  KLAVIYO_OPERATIONS_API_KEY?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
  DAILY_PULSE_ACCESS_TOKEN?: string;
};

const KLAVIYO_API_BASE = "https://a.klaviyo.com";
const KLAVIYO_REVISION = "2026-07-15";
const MAX_PAGES = 5;

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

function isAuthorized(request: Request, env: KlaviyoCampaignInventoryEnv): boolean {
  const expected = normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN) || normalize(env.DAILY_PULSE_ACCESS_TOKEN);
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  return timingSafeEqualText(supplied, expected);
}

async function klaviyoFetch(path: string, apiKey: string): Promise<JsonObject> {
  const response = await fetch(KLAVIYO_API_BASE + path, {
    headers: {
      Accept: "application/vnd.api+json",
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      revision: KLAVIYO_REVISION,
    },
  });
  let body: JsonObject = {};
  try { body = await response.json() as JsonObject; } catch {}
  if (!response.ok) {
    const error = new Error(`klaviyo_campaign_inventory_failed_${response.status}`) as Error & { status?: number; body?: JsonObject };
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function nextPath(payload: JsonObject): string {
  const links = asObject(payload.links);
  const next = normalize(links.next);
  if (!next) return "";
  try {
    const url = new URL(next);
    return url.pathname + url.search;
  } catch {
    return "";
  }
}

function messageMap(payloads: JsonObject[]): Map<string, JsonObject> {
  const map = new Map<string, JsonObject>();
  for (const payload of payloads) {
    const included = Array.isArray(payload.included) ? payload.included : [];
    for (const raw of included) {
      const item = asObject(raw);
      if (normalize(item.type) !== "campaign-message") continue;
      const id = normalize(item.id);
      if (id) map.set(id, item);
    }
  }
  return map;
}

function campaignMessageIds(campaign: JsonObject): string[] {
  const relationships = asObject(campaign.relationships);
  const rel = asObject(relationships["campaign-messages"]);
  const rows = Array.isArray(rel.data) ? rel.data : [];
  return rows.map((row) => normalize(asObject(row).id)).filter(Boolean);
}

function compactMessage(message: JsonObject): JsonObject {
  const attributes = asObject(message.attributes);
  const definition = asObject(attributes.definition);
  const content = asObject(definition.content);
  return {
    id: normalize(message.id) || null,
    label: normalize(attributes.label) || normalize(definition.label) || null,
    channel: normalize(definition.channel) || null,
    subject: normalize(content.subject) || null,
    preview_text: normalize(content.preview_text) || null,
    from_email: normalize(content.from_email) || null,
    from_label: normalize(content.from_label) || null,
    reply_to_email: normalize(content.reply_to_email) || null,
    created_at: attributes.created_at || null,
    updated_at: attributes.updated_at || null,
  };
}

function compactCampaign(campaign: JsonObject, messages: Map<string, JsonObject>): JsonObject {
  const attributes = asObject(campaign.attributes);
  const messageIds = campaignMessageIds(campaign);
  return {
    id: normalize(campaign.id) || null,
    name: normalize(attributes.name) || null,
    status: normalize(attributes.status) || null,
    archived: attributes.archived === true,
    audiences: asObject(attributes.audiences),
    send_strategy: asObject(attributes.send_strategy),
    send_options: asObject(attributes.send_options),
    tracking_options: asObject(attributes.tracking_options),
    created_at: attributes.created_at || null,
    scheduled_at: attributes.scheduled_at || null,
    updated_at: attributes.updated_at || null,
    messages: messageIds.map((id) => messages.get(id)).filter(Boolean).map((message) => compactMessage(message as JsonObject)),
  };
}

async function listCampaignsByStatus(apiKey: string, status: "Draft" | "Scheduled"): Promise<JsonObject[]> {
  const payloads: JsonObject[] = [];
  const rows: JsonObject[] = [];
  const params = new URLSearchParams();
  params.set("filter", `and(equals(messages.channel,'email'),equals(status,'${status}'),equals(archived,false))`);
  params.set("include", "campaign-messages");
  params.set("page[size]", "100");
  params.set("sort", status === "Scheduled" ? "scheduled_at" : "-updated_at");
  let path = `/api/campaigns?${params.toString()}`;

  for (let page = 0; path && page < MAX_PAGES; page += 1) {
    const payload = await klaviyoFetch(path, apiKey);
    payloads.push(payload);
    const data = Array.isArray(payload.data) ? payload.data : [];
    rows.push(...data.map((item) => asObject(item)));
    path = nextPath(payload);
  }

  const messages = messageMap(payloads);
  return rows.map((campaign) => compactCampaign(campaign, messages));
}

export async function handleKlaviyoCampaignInventoryRequest(
  request: Request,
  env: KlaviyoCampaignInventoryEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/internal/klaviyo/campaign-inventory") return null;
  if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

  const apiKey = normalize(env.KLAVIYO_OPERATIONS_API_KEY) || normalize(env.KLAVIYO_PRIVATE_API_KEY);
  if (!apiKey) return jsonResponse({ ok: false, error: "klaviyo_campaign_read_key_not_configured" }, 503);

  try {
    const [drafts, scheduled] = await Promise.all([
      listCampaignsByStatus(apiKey, "Draft"),
      listCampaignsByStatus(apiKey, "Scheduled"),
    ]);
    return jsonResponse({
      ok: true,
      service: "klaviyo_campaign_inventory",
      revision: KLAVIYO_REVISION,
      generated_at: new Date().toISOString(),
      counts: { drafts: drafts.length, scheduled: scheduled.length },
      drafts,
      scheduled,
      notes: [
        "Read-only inventory: no campaign, audience, schedule or content is modified.",
        "Campaign metadata uses the Operations key when configured because it is scoped for campaigns:read.",
        "Draft campaigns are sorted by most recently updated; scheduled campaigns by send time.",
      ],
    });
  } catch (error) {
    const candidate = error as Error & { status?: number };
    return jsonResponse({
      ok: false,
      error: candidate.message || "klaviyo_campaign_inventory_failed",
      status: candidate.status || null,
    }, candidate.status === 429 ? 429 : 502);
  }
}
