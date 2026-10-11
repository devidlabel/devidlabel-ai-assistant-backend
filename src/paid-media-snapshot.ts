import { handleGoogleAdsReportingRequest } from "./google-ads-reporting";
import { handleMetaReportingRequest } from "./meta-reporting";

type KVNamespace = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

type PaidMediaEnv = {
  SHOPIFY_TOKENS_KV?: KVNamespace;
  DAILY_PULSE_ACCESS_TOKEN?: string;
  META_REPORT_ACCESS_TOKEN?: string;
  META_ADS_ACCESS_TOKEN?: string;
  META_AD_ACCOUNT_ID?: string;
  GOOGLE_ADS_REPORT_ACCESS_TOKEN?: string;
  GOOGLE_ADS_CUSTOMER_ID?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
  MARE_PAID_MEDIA_CRON_ENABLED?: string;
  [key: string]: unknown;
};

type DataRow = Record<string, unknown>;
type Source = {
  ok: boolean;
  status: number;
  error: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  conversions: number | null;
  conversion_value: number | null;
  campaigns: DataRow[];
};
type Snapshot = {
  ok: boolean;
  date: string;
  collected_at: string;
  timezone: "Europe/Rome";
  source_status: { meta: { ok: boolean; status: number }; google: { ok: boolean; status: number } };
  sources: { meta: Source; google: Source };
  combined: { paid_media_spend_meta_google: number | null; complete: boolean; missing_sources: string[] };
};

const PREFIX = "mare/paid-media/v1/";
const TTL_SECONDS = 45 * 24 * 60 * 60;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function equalBearer(actual: string, expected: string): boolean {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let different = 0;
  for (let index = 0; index < actual.length; index++) different |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return different === 0;
}

function localParts(value: Date): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: string): string => parts.find((item) => item.type === type)?.value || "";
  return {
    date: part("year") + "-" + part("month") + "-" + part("day"),
    hour: Number(part("hour")),
    minute: Number(part("minute")),
  };
}

function yesterdayInRome(now: Date): string {
  return localParts(new Date(now.getTime() - 24 * 60 * 60 * 1000)).date;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T12:00:00Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function numeric(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sourceUnavailable(status: number, error: string): Source {
  return { ok: false, status, error, spend: null, impressions: null, clicks: null, conversions: null, conversion_value: null, campaigns: [] };
}

async function requestSource(
  handler: (request: Request, env: any) => Promise<Response | null>,
  path: string,
  token: string,
  env: PaidMediaEnv,
): Promise<{ ok: boolean; status: number; body: DataRow }> {
  if (!token) return { ok: false, status: 503, body: { error: "internal_reporting_token_not_configured" } };
  try {
    const response = await handler(new Request("https://internal.local" + path, {
      method: "GET",
      headers: { Authorization: "Bearer " + token },
    }), env);
    if (!response) return { ok: false, status: 404, body: { error: "report_handler_not_found" } };
    const body = await response.json() as DataRow;
    return {
      ok: response.ok && body.ok === true,
      status: response.status,
      body: body && typeof body === "object" && !Array.isArray(body) ? body : {},
    };
  } catch {
    return { ok: false, status: 502, body: { error: "report_handler_failed" } };
  }
}

function normalizedSource(result: { ok: boolean; status: number; body: DataRow }, date: string, provider: "meta" | "google", accountId: string): Source {
  const rawRange = result.body.time_range as DataRow | undefined;
  const rangeValid = rawRange?.since === date && rawRange?.until === date;
  const observedAccount = normalize(result.body[provider === "meta" ? "account_id" : "customer_id"]).replace(/^act_/, "").replace(/-/g, "");
  const expectedAccount = accountId.replace(/^act_/, "").replace(/-/g, "");
  if (!result.ok || !rangeValid || !expectedAccount || observedAccount !== expectedAccount) {
    const reason = !result.ok ? normalize(result.body.error) || "provider_unavailable" :
      !rangeValid ? "report_date_mismatch" : "report_account_mismatch";
    return sourceUnavailable(result.ok ? 502 : result.status, reason);
  }

  const rows = Array.isArray(result.body.rows) ? result.body.rows as DataRow[] : [];
  const campaigns = rows.map((row) => {
    const m = row.metrics && typeof row.metrics === "object" ? row.metrics as DataRow : {};
    return {
      id: row.campaign_id || "",
      name: row.campaign_name || "",
      spend: numeric(m.spend),
      impressions: numeric(m.impressions),
      clicks: numeric(m.clicks),
      conversions: numeric(provider === "meta" ? m.purchases : m.conversions),
      conversion_value: numeric(provider === "meta" ? m.purchase_value : m.conversion_value),
    };
  });
  const googleTotals = result.body.totals && typeof result.body.totals === "object" ? result.body.totals as DataRow : {};
  const sum = (key: string): number => campaigns.reduce((total, row) => total + numeric(row[key]), 0);
  return {
    ok: true,
    status: result.status,
    error: null,
    spend: provider === "google" ? numeric(googleTotals.spend) : sum("spend"),
    impressions: provider === "google" ? numeric(googleTotals.impressions) : sum("impressions"),
    clicks: provider === "google" ? numeric(googleTotals.clicks) : sum("clicks"),
    conversions: provider === "google" ? numeric(googleTotals.conversions) : sum("conversions"),
    conversion_value: provider === "google" ? numeric(googleTotals.conversion_value) : sum("conversion_value"),
    campaigns,
  };
}

export async function refreshPaidMediaSnapshot(env: PaidMediaEnv, date: string, now = new Date()): Promise<Snapshot> {
  if (!env.SHOPIFY_TOKENS_KV) throw new Error("paid_media_kv_unavailable");
  if (!validDate(date)) throw new Error("invalid_snapshot_date");

  const metaToken = normalize(env.META_REPORT_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);
  const googleToken = normalize(env.GOOGLE_ADS_REPORT_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);
  const suffix = "?timeframe=custom&start=" + date + "&end=" + date;
  const [metaRaw, googleRaw] = await Promise.all([
    requestSource(handleMetaReportingRequest, "/internal/meta/report" + suffix + "&level=campaign", metaToken, env),
    requestSource(handleGoogleAdsReportingRequest, "/internal/google-ads/report" + suffix, googleToken, env),
  ]);
  const meta = normalizedSource(metaRaw, date, "meta", normalize(env.META_AD_ACCOUNT_ID));
  const google = normalizedSource(googleRaw, date, "google", normalize(env.GOOGLE_ADS_CUSTOMER_ID));
  const missingSources = [!meta.ok ? "meta" : "", !google.ok ? "google" : ""].filter(Boolean);
  const complete = missingSources.length === 0;
  const snapshot: Snapshot = {
    ok: complete, date, collected_at: now.toISOString(), timezone: "Europe/Rome",
    source_status: { meta: { ok: meta.ok, status: meta.status }, google: { ok: google.ok, status: google.status } },
    sources: { meta, google },
    combined: {
      paid_media_spend_meta_google: complete ? Math.round(((meta.spend || 0) + (google.spend || 0)) * 100) / 100 : null,
      complete,
      missing_sources: missingSources,
    },
  };
  await env.SHOPIFY_TOKENS_KV.put(PREFIX + date, JSON.stringify(snapshot), { expirationTtl: TTL_SECONDS });
  return snapshot;
}

/**
 * The existing five-minute Cloudflare cron is the authoritative heartbeat.
 * Retry 07:05/07:20/07:35/07:50 Europe/Rome, then hourly until 20:05 if incomplete.
 * A successfully stored date is never fetched again by the scheduler.
 */
export async function schedulePaidMediaSnapshot(env: PaidMediaEnv, now = new Date()): Promise<void> {
  if (normalize(env.MARE_PAID_MEDIA_CRON_ENABLED).toLowerCase() === "false") return;
  const { hour, minute } = localParts(now);
  const shouldRun = (hour === 7 && [5, 20, 35, 50].includes(minute)) ||
    (hour >= 8 && hour <= 20 && minute === 5);
  if (!shouldRun) return;
  if (!env.SHOPIFY_TOKENS_KV) {
    console.error("paid_media_snapshot: missing KV binding");
    return;
  }
  const date = yesterdayInRome(now);
  const existing = await env.SHOPIFY_TOKENS_KV.get(PREFIX + date);
  if (existing) {
    try {
      const previous = JSON.parse(existing) as Snapshot;
      if (previous.date === date && previous.ok === true && previous.combined?.complete === true) return;
    } catch {
      // A corrupt record must not stop a fresh attempt.
    }
  }
  const snapshot = await refreshPaidMediaSnapshot(env, date, now);
  console.log("paid_media_snapshot", JSON.stringify({
    date, ok: snapshot.ok, meta: snapshot.source_status.meta, google: snapshot.source_status.google,
    missing_sources: snapshot.combined.missing_sources,
  }));
}

export async function handlePaidMediaSnapshotRequest(request: Request, env: PaidMediaEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/internal/paid-media/snapshot" && url.pathname !== "/internal/paid-media/refresh") return null;
  const bearer = request.headers.get("Authorization") || "";
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : "";
  if (!equalBearer(token, normalize(env.DAILY_PULSE_ACCESS_TOKEN))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  if (!env.SHOPIFY_TOKENS_KV) return jsonResponse({ ok: false, error: "snapshot_storage_unavailable" }, 503);
  const date = normalize(url.searchParams.get("date")) || yesterdayInRome(new Date());
  if (!validDate(date)) return jsonResponse({ ok: false, error: "invalid_snapshot_date" }, 400);
  if (url.pathname === "/internal/paid-media/snapshot") {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    const stored = await env.SHOPIFY_TOKENS_KV.get(PREFIX + date);
    if (!stored) return jsonResponse({ ok: false, error: "snapshot_not_found", date }, 404);
    try {
      const snapshot = JSON.parse(stored) as Snapshot;
      return jsonResponse(snapshot, snapshot.ok ? 200 : 206);
    } catch {
      return jsonResponse({ ok: false, error: "snapshot_corrupt", date }, 502);
    }
  }
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  // Manual recovery is read-only at ad providers; the only write is the snapshot in existing KV.
  const ageDays = (Date.now() - new Date(date + "T12:00:00Z").getTime()) / 86400000;
  if (ageDays < -1 || ageDays > 45) return jsonResponse({ ok: false, error: "date_out_of_range" }, 400);
  try {
    const snapshot = await refreshPaidMediaSnapshot(env, date);
    return jsonResponse(snapshot, snapshot.ok ? 200 : 206);
  } catch {
    return jsonResponse({ ok: false, error: "snapshot_refresh_failed" }, 503);
  }
}
