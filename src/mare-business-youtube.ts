type JsonObject = Record<string, unknown>;

type KVNamespaceLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
};

export type MareBusinessYouTubeEnv = {
  YOUTUBE_CLIENT_ID?: string;
  YOUTUBE_CLIENT_SECRET?: string;
  YOUTUBE_REDIRECT_URI?: string;
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
  SHOPIFY_TOKENS_KV?: KVNamespaceLike;
  [key: string]: unknown;
};

type StoredAuthorization = {
  refresh_token: string;
  access_token?: string;
  access_token_expires_at?: string;
  scope?: string;
  token_type?: string;
  authorized_at: string;
};

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type AnalyticsResponse = {
  columnHeaders?: Array<{ name?: string; columnType?: string; dataType?: string }>;
  rows?: unknown[][];
  kind?: string;
};

const AUTH_KEY = "mare-business:youtube:authorization";
const STATE_PREFIX = "mare-business:youtube:oauth-state:";
const STATE_TTL_SECONDS = 600;
const DEFAULT_REDIRECT_URI = "https://devidlabel-ai-assistant-backend.devidlabel.workers.dev/auth/youtube/callback";
const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
].join(" ");

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function youtubeClient(env: MareBusinessYouTubeEnv): { clientId: string; clientSecret: string; redirectUri: string; source: string } {
  const dedicatedId = normalize(env.YOUTUBE_CLIENT_ID);
  const dedicatedSecret = normalize(env.YOUTUBE_CLIENT_SECRET);
  const fallbackId = normalize(env.GOOGLE_ADS_CLIENT_ID);
  const fallbackSecret = normalize(env.GOOGLE_ADS_CLIENT_SECRET);
  const clientId = dedicatedId || fallbackId;
  const clientSecret = dedicatedSecret || fallbackSecret;
  return {
    clientId,
    clientSecret,
    redirectUri: normalize(env.YOUTUBE_REDIRECT_URI) || DEFAULT_REDIRECT_URI,
    source: dedicatedId && dedicatedSecret ? "youtube" : (fallbackId && fallbackSecret ? "google_ads_oauth_client" : "missing"),
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

async function readAuthorization(env: MareBusinessYouTubeEnv): Promise<StoredAuthorization | null> {
  if (!env.SHOPIFY_TOKENS_KV) return null;
  const raw = await env.SHOPIFY_TOKENS_KV.get(AUTH_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredAuthorization;
    return normalize(parsed.refresh_token) ? parsed : null;
  } catch {
    return null;
  }
}

async function storeAuthorization(auth: StoredAuthorization, env: MareBusinessYouTubeEnv): Promise<void> {
  if (!env.SHOPIFY_TOKENS_KV) throw new Error("youtube_kv_store_not_configured");
  await env.SHOPIFY_TOKENS_KV.put(AUTH_KEY, JSON.stringify(auth));
}

async function exchangeToken(body: URLSearchParams): Promise<GoogleTokenResponse> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  let payload: GoogleTokenResponse = {};
  try { payload = await response.json() as GoogleTokenResponse; } catch { payload = {}; }
  if (!response.ok || !normalize(payload.access_token)) {
    throw new Error(normalize(payload.error_description) || normalize(payload.error) || `youtube_oauth_token_http_${response.status}`);
  }
  return payload;
}

async function validAccessToken(env: MareBusinessYouTubeEnv): Promise<string> {
  const auth = await readAuthorization(env);
  if (!auth) throw new Error("youtube_not_authorized");
  const expiresAt = Date.parse(normalize(auth.access_token_expires_at));
  if (normalize(auth.access_token) && Number.isFinite(expiresAt) && expiresAt - Date.now() > 60_000) {
    return normalize(auth.access_token);
  }

  const client = youtubeClient(env);
  if (!client.clientId || !client.clientSecret) throw new Error("youtube_oauth_client_not_configured");
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: auth.refresh_token,
    grant_type: "refresh_token",
  });
  const refreshed = await exchangeToken(body);
  const next: StoredAuthorization = {
    ...auth,
    access_token: refreshed.access_token,
    access_token_expires_at: new Date(Date.now() + Math.max(60, refreshed.expires_in || 3600) * 1000).toISOString(),
    scope: normalize(refreshed.scope) || auth.scope,
    token_type: normalize(refreshed.token_type) || auth.token_type,
  };
  await storeAuthorization(next, env);
  return normalize(refreshed.access_token);
}

async function googleGet(url: URL, accessToken: string): Promise<JsonObject> {
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  let payload: JsonObject = {};
  try { payload = await response.json() as JsonObject; } catch { payload = {}; }
  if (!response.ok) {
    const error = payload.error;
    throw new Error(typeof error === "string" ? error : `youtube_api_http_${response.status}:${JSON.stringify(error || payload)}`);
  }
  return payload;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function reportRange(input: JsonObject): { startDate: string; endDate: string; days: number } {
  const suppliedStart = normalize(input.start_date);
  const suppliedEnd = normalize(input.end_date);
  if (/^\d{4}-\d{2}-\d{2}$/.test(suppliedStart) && /^\d{4}-\d{2}-\d{2}$/.test(suppliedEnd)) {
    const days = Math.max(1, Math.round((Date.parse(`${suppliedEnd}T00:00:00Z`) - Date.parse(`${suppliedStart}T00:00:00Z`)) / 86_400_000) + 1);
    return { startDate: suppliedStart, endDate: suppliedEnd, days };
  }
  const days = integer(input.days, 28, 1, 365);
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { startDate: dateOnly(start), endDate: dateOnly(end), days };
}

function rowsToObjects(payload: AnalyticsResponse): JsonObject[] {
  const headers = (payload.columnHeaders || []).map((item) => normalize(item.name));
  return (payload.rows || []).map((row) => {
    const result: JsonObject = {};
    headers.forEach((name, index) => { if (name) result[name] = row[index]; });
    return result;
  });
}

async function analyticsQuery(params: Record<string, string>, env: MareBusinessYouTubeEnv): Promise<JsonObject[]> {
  const accessToken = await validAccessToken(env);
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  Object.entries({ ids: "channel==MINE", ...params }).forEach(([key, value]) => url.searchParams.set(key, value));
  const payload = await googleGet(url, accessToken) as unknown as AnalyticsResponse;
  return rowsToObjects(payload);
}

async function videosByIds(ids: string[], env: MareBusinessYouTubeEnv): Promise<Record<string, JsonObject>> {
  if (!ids.length) return {};
  const accessToken = await validAccessToken(env);
  const result: Record<string, JsonObject> = {};
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,contentDetails,statistics,status");
    url.searchParams.set("id", batch.join(","));
    const payload = await googleGet(url, accessToken);
    const items = Array.isArray(payload.items) ? payload.items as JsonObject[] : [];
    items.forEach((item) => {
      const id = normalize(item.id);
      if (id) result[id] = item;
    });
  }
  return result;
}

export async function youtubeAuthorizationStatus(env: MareBusinessYouTubeEnv): Promise<JsonObject> {
  const client = youtubeClient(env);
  const auth = await readAuthorization(env);
  return {
    provider: "youtube",
    app_configured: Boolean(client.clientId && client.clientSecret),
    oauth_client_source: client.source,
    redirect_uri: client.redirectUri,
    kv_store_configured: Boolean(env.SHOPIFY_TOKENS_KV),
    authorized: Boolean(auth?.refresh_token),
    authorized_at: auth?.authorized_at || null,
    scopes: normalize(auth?.scope).split(/\s+/).filter(Boolean),
    read_only: true,
  };
}

export async function createYouTubeAuthorizationUrl(env: MareBusinessYouTubeEnv): Promise<JsonObject> {
  const client = youtubeClient(env);
  if (!client.clientId || !client.clientSecret) throw new Error("youtube_oauth_client_not_configured");
  if (!env.SHOPIFY_TOKENS_KV) throw new Error("youtube_kv_store_not_configured");
  const state = `yt_${crypto.randomUUID().replace(/-/g, "")}`;
  await env.SHOPIFY_TOKENS_KV.put(`${STATE_PREFIX}${state}`, JSON.stringify({ created_at: new Date().toISOString() }), { expirationTtl: STATE_TTL_SECONDS });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", YOUTUBE_SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return { ok: true, authorization_url: url.toString(), redirect_uri: client.redirectUri, scopes: YOUTUBE_SCOPES.split(" "), read_only: true };
}

export async function handleYouTubeOAuthCallbackRequest(request: Request, env: MareBusinessYouTubeEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/auth/youtube/callback") return null;
  if (request.method !== "GET") return jsonResponse({ ok: false, provider: "youtube", error: "method_not_allowed" }, 405);
  const providerError = normalize(url.searchParams.get("error"));
  if (providerError) return jsonResponse({ ok: false, provider: "youtube", error: providerError }, 400);
  const code = normalize(url.searchParams.get("code"));
  const state = normalize(url.searchParams.get("state"));
  if (!code || !state || !env.SHOPIFY_TOKENS_KV) return jsonResponse({ ok: false, provider: "youtube", error: "invalid_oauth_callback" }, 400);
  const stateKey = `${STATE_PREFIX}${state}`;
  const storedState = await env.SHOPIFY_TOKENS_KV.get(stateKey);
  if (!storedState) return jsonResponse({ ok: false, provider: "youtube", error: "oauth_state_invalid_or_expired" }, 400);
  if (env.SHOPIFY_TOKENS_KV.delete) await env.SHOPIFY_TOKENS_KV.delete(stateKey);

  try {
    const client = youtubeClient(env);
    if (!client.clientId || !client.clientSecret) throw new Error("youtube_oauth_client_not_configured");
    const token = await exchangeToken(new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      redirect_uri: client.redirectUri,
      grant_type: "authorization_code",
    }));
    const previous = await readAuthorization(env);
    const refreshToken = normalize(token.refresh_token) || normalize(previous?.refresh_token);
    if (!refreshToken) throw new Error("youtube_refresh_token_missing");
    await storeAuthorization({
      refresh_token: refreshToken,
      access_token: token.access_token,
      access_token_expires_at: new Date(Date.now() + Math.max(60, token.expires_in || 3600) * 1000).toISOString(),
      scope: token.scope,
      token_type: token.token_type,
      authorized_at: new Date().toISOString(),
    }, env);
    const channel = await readYouTubeChannel({}, env);
    return jsonResponse({ ok: true, provider: "youtube", authorized: true, read_only: true, channel });
  } catch (error) {
    return jsonResponse({ ok: false, provider: "youtube", error: error instanceof Error ? error.message : "youtube_oauth_callback_failed" }, 500);
  }
}

export async function readYouTubeChannel(_input: JsonObject, env: MareBusinessYouTubeEnv): Promise<JsonObject> {
  const accessToken = await validAccessToken(env);
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet,contentDetails,statistics,status,brandingSettings");
  url.searchParams.set("mine", "true");
  const payload = await googleGet(url, accessToken);
  const items = Array.isArray(payload.items) ? payload.items as JsonObject[] : [];
  if (!items.length) throw new Error("youtube_channel_not_found_for_authorized_account");
  const channel = items[0];
  return { ok: true, provider: "youtube", channel, retrieved_at: new Date().toISOString() };
}

export async function readYouTubeAnalyticsSummary(input: JsonObject, env: MareBusinessYouTubeEnv): Promise<JsonObject> {
  const range = reportRange(input);
  const rows = await analyticsQuery({
    startDate: range.startDate,
    endDate: range.endDate,
    metrics: "views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained,subscribersLost",
  }, env);
  return { ok: true, provider: "youtube", range, summary: rows[0] || {}, retrieved_at: new Date().toISOString() };
}

export async function readYouTubeVideoPerformance(input: JsonObject, env: MareBusinessYouTubeEnv): Promise<JsonObject> {
  const range = reportRange(input);
  const maxResults = integer(input.max_results, 25, 1, 100);
  const rows = await analyticsQuery({
    startDate: range.startDate,
    endDate: range.endDate,
    dimensions: "video",
    metrics: "views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained,subscribersLost",
    sort: "-views",
    maxResults: String(maxResults),
  }, env);
  const ids = rows.map((row) => normalize(row.video)).filter(Boolean);
  const metadata = await videosByIds(ids, env);
  const videos = rows.map((row) => {
    const id = normalize(row.video);
    const item = metadata[id] || {};
    const snippet = item.snippet && typeof item.snippet === "object" ? item.snippet as JsonObject : {};
    const contentDetails = item.contentDetails && typeof item.contentDetails === "object" ? item.contentDetails as JsonObject : {};
    return {
      ...row,
      title: snippet.title || null,
      published_at: snippet.publishedAt || null,
      thumbnail: snippet.thumbnails || null,
      duration: contentDetails.duration || null,
    };
  });
  return { ok: true, provider: "youtube", range, videos, retrieved_at: new Date().toISOString() };
}

export async function readYouTubeTrafficSources(input: JsonObject, env: MareBusinessYouTubeEnv): Promise<JsonObject> {
  const range = reportRange(input);
  const rows = await analyticsQuery({
    startDate: range.startDate,
    endDate: range.endDate,
    dimensions: "insightTrafficSourceType",
    metrics: "views,estimatedMinutesWatched",
    sort: "-views",
  }, env);
  return { ok: true, provider: "youtube", range, traffic_sources: rows, retrieved_at: new Date().toISOString() };
}

export async function readYouTubeSearchTerms(input: JsonObject, env: MareBusinessYouTubeEnv): Promise<JsonObject> {
  const range = reportRange(input);
  const maxResults = integer(input.max_results, 25, 1, 25);
  const videoLimit = integer(input.video_limit, 100, 1, 500);
  const topVideos = await analyticsQuery({
    startDate: range.startDate,
    endDate: range.endDate,
    dimensions: "video",
    metrics: "views",
    sort: "-views",
    maxResults: String(videoLimit),
  }, env);
  const videoIds = topVideos.map((row) => normalize(row.video)).filter(Boolean).slice(0, 500);
  if (!videoIds.length) return { ok: true, provider: "youtube", range, search_terms: [], video_count: 0, retrieved_at: new Date().toISOString() };
  const rows = await analyticsQuery({
    startDate: range.startDate,
    endDate: range.endDate,
    dimensions: "insightTrafficSourceDetail",
    metrics: "views,estimatedMinutesWatched",
    filters: `video==${videoIds.join(",")};insightTrafficSourceType==YT_SEARCH`,
    sort: "-views",
    maxResults: String(maxResults),
  }, env);
  return { ok: true, provider: "youtube", range, search_terms: rows, video_count: videoIds.length, retrieved_at: new Date().toISOString() };
}
