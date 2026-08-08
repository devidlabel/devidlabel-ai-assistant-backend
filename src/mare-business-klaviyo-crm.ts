type JsonObject = Record<string, unknown>;

type KlaviyoCrmEnv = {
  KLAVIYO_PRIVATE_API_KEY?: string;
};

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const KLAVIYO_REVISION = "2026-07-15";

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function asInt(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

function safeKlaviyoUrl(pathOrUrl: string): string {
  const candidate = pathOrUrl.startsWith("http")
    ? new URL(pathOrUrl)
    : new URL(`${KLAVIYO_BASE}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`);
  if (candidate.protocol !== "https:" || candidate.hostname !== "a.klaviyo.com" || !candidate.pathname.startsWith("/api/")) {
    throw new Error("klaviyo_pagination_url_rejected");
  }
  return candidate.toString();
}

async function klaviyoGet(pathOrUrl: string, env: KlaviyoCrmEnv): Promise<JsonObject> {
  const apiKey = normalize(env.KLAVIYO_PRIVATE_API_KEY);
  if (!apiKey) throw new Error("klaviyo_private_api_key_not_configured");
  let lastError = "klaviyo_request_failed";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(safeKlaviyoUrl(pathOrUrl), {
      headers: {
        Authorization: `Klaviyo-API-Key ${apiKey}`,
        Accept: "application/vnd.api+json",
        Revision: KLAVIYO_REVISION,
      },
    });
    const text = await response.text();
    let body: JsonObject = {};
    try { body = text ? JSON.parse(text) as JsonObject : {}; } catch { body = { error: text.slice(0, 1000) }; }
    if (response.ok) return body;
    const errors = Array.isArray(body.errors) ? body.errors as JsonObject[] : [];
    lastError = normalize(errors[0]?.detail) || normalize(errors[0]?.title) || `klaviyo_http_${response.status}`;
    if (response.status === 429 && attempt < 4) {
      const retryAfter = Number(response.headers.get("Retry-After") || "0");
      await new Promise((resolve) => setTimeout(resolve, Math.max(1000, retryAfter * 1000, 1000 + attempt * 1000)));
      continue;
    }
    throw new Error(lastError);
  }
  throw new Error(lastError);
}

async function collectWithEnv(path: string, env: KlaviyoCrmEnv, maxPages = 100): Promise<{ rows: JsonObject[]; complete: boolean; next: string | null }> {
  const rows: JsonObject[] = [];
  let next: string | null = path;
  let page = 0;
  while (next && page < maxPages) {
    const body = await klaviyoGet(next, env);
    if (Array.isArray(body.data)) rows.push(...body.data as JsonObject[]);
    next = normalize(asObject(body.links).next) || null;
    page += 1;
  }
  return { rows, complete: !next, next };
}

function entitySummary(row: JsonObject): JsonObject {
  const attributes = asObject(row.attributes);
  return {
    id: normalize(row.id),
    name: normalize(attributes.name),
    created: normalize(attributes.created) || null,
    updated: normalize(attributes.updated) || null,
    ...(attributes.opt_in_process === undefined ? {} : { opt_in_process: attributes.opt_in_process }),
    ...(attributes.is_active === undefined ? {} : { is_active: attributes.is_active }),
    ...(attributes.is_processing === undefined ? {} : { is_processing: attributes.is_processing }),
  };
}

async function profileCount(kind: "list" | "segment", id: string, env: KlaviyoCrmEnv): Promise<number | null> {
  const plural = kind === "list" ? "lists" : "segments";
  const body = await klaviyoGet(`/${plural}/${encodeURIComponent(id)}?additional-fields[${kind}]=profile_count`, env);
  const count = asObject(asObject(body.data).attributes).profile_count;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}

export async function readKlaviyoAudienceOverview(request: JsonObject, env: KlaviyoCrmEnv): Promise<JsonObject> {
  const query = normalize(request.query).toLocaleLowerCase("it-IT");
  const inlineLimit = asInt(request.inline_limit, 50, 1, 100);
  // Profile counts use a much lower provider rate limit. Default to 5 per entity type; caller can request up to 10.
  const countLimit = asInt(request.profile_count_limit, 5, 0, 10);

  const [listsResult, segmentsResult] = await Promise.all([
    collectWithEnv("/lists?page[size]=10&sort=-updated", env, 100),
    collectWithEnv("/segments?page[size]=10&sort=-updated", env, 100),
  ]);

  const filterRows = (rows: JsonObject[]) => rows
    .map(entitySummary)
    .filter((row) => !query || normalize(row.name).toLocaleLowerCase("it-IT").includes(query));

  const lists = filterRows(listsResult.rows);
  const segments = filterRows(segmentsResult.rows);

  const addCounts = async (kind: "list" | "segment", rows: JsonObject[]) => {
    const output: JsonObject[] = [];
    for (let index = 0; index < Math.min(rows.length, inlineLimit); index += 1) {
      const row = { ...rows[index] };
      if (index < countLimit) {
        try { row.profile_count = await profileCount(kind, normalize(row.id), env); }
        catch (error) { row.profile_count = null; row.profile_count_error = error instanceof Error ? error.message : "profile_count_failed"; }
      }
      output.push(row);
    }
    return output;
  };

  return {
    ok: true,
    source: "klaviyo",
    generated_at: new Date().toISOString(),
    data_policy: "aggregate_and_group_metadata_only_no_profile_pii",
    query: query || null,
    lists: {
      total_matching: lists.length,
      collection_complete: listsResult.complete,
      returned: Math.min(lists.length, inlineLimit),
      items: await addCounts("list", lists),
    },
    segments: {
      total_matching: segments.length,
      collection_complete: segmentsResult.complete,
      returned: Math.min(segments.length, inlineLimit),
      items: await addCounts("segment", segments),
    },
  };
}

export async function readKlaviyoProfileAggregate(request: JsonObject, env: KlaviyoCrmEnv): Promise<JsonObject> {
  const maxProfiles = asInt(request.max_profiles, 50000, 100, 100000);
  const fields = encodeURIComponent("id,subscriptions.email.marketing.can_receive_email_marketing,subscriptions.email.marketing.consent");
  let next: string | null = `/profiles?page[size]=100&additional-fields[profile]=subscriptions&fields[profile]=${fields}`;
  let scanned = 0;
  let pages = 0;
  let canReceive = 0;
  let cannotReceive = 0;
  let unknownCanReceive = 0;
  const consentStatus: Record<string, number> = {};

  while (next && scanned < maxProfiles) {
    const body = await klaviyoGet(next, env);
    const rows = Array.isArray(body.data) ? body.data as JsonObject[] : [];
    for (const row of rows) {
      if (scanned >= maxProfiles) break;
      const attributes = asObject(row.attributes);
      const email = asObject(asObject(attributes.subscriptions).email);
      const marketing = asObject(email.marketing);
      const eligible = marketing.can_receive_email_marketing;
      if (eligible === true) canReceive += 1;
      else if (eligible === false) cannotReceive += 1;
      else unknownCanReceive += 1;
      const status = normalize(marketing.consent).toUpperCase() || "UNKNOWN";
      consentStatus[status] = (consentStatus[status] || 0) + 1;
      scanned += 1;
    }
    next = normalize(asObject(body.links).next) || null;
    pages += 1;
  }

  const complete = !next;
  return {
    ok: true,
    source: "klaviyo",
    generated_at: new Date().toISOString(),
    data_policy: "aggregate_only_no_profile_identifiers_or_contact_data_returned",
    profiles: {
      scanned,
      complete,
      truncated: !complete,
      max_profiles: maxProfiles,
      pages,
      total_profiles: complete ? scanned : null,
    },
    email_marketing: {
      can_receive: canReceive,
      cannot_receive: cannotReceive,
      unknown: unknownCanReceive,
      eligible_rate: scanned > 0 ? canReceive / scanned : 0,
      consent_status: consentStatus,
    },
    ...(complete ? {} : { warning: "Profile aggregate reached max_profiles before the Klaviyo collection ended; increase max_profiles for an exact account total." }),
  };
}
