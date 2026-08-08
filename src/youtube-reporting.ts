import {
  readYouTubeAnalyticsSummary,
  readYouTubeChannel,
  readYouTubeSearchTerms,
  readYouTubeTrafficSources,
  readYouTubeVideoPerformance,
  youtubeAuthorizationStatus,
  type MareBusinessYouTubeEnv,
} from "./mare-business-youtube";

type JsonObject = Record<string, unknown>;

type YouTubeReportingEnv = MareBusinessYouTubeEnv & {
  DAILY_PULSE_ACCESS_TOKEN?: string;
};

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function timingSafeEqualText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function suppliedBearer(request: Request): string {
  const authorization = request.headers.get("Authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function isAuthorized(request: Request, env: YouTubeReportingEnv): boolean {
  return timingSafeEqualText(suppliedBearer(request), normalize(env.DAILY_PULSE_ACCESS_TOKEN));
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

function daysFromUrl(url: URL): number {
  const parsed = Number(url.searchParams.get("days") || "28");
  if (!Number.isFinite(parsed)) return 28;
  return Math.max(1, Math.min(365, Math.trunc(parsed)));
}

async function settled<T>(label: string, task: Promise<T>): Promise<JsonObject> {
  try {
    return { ok: true, label, data: await task };
  } catch (error) {
    return { ok: false, label, error: error instanceof Error ? error.message : "youtube_reporting_failed" };
  }
}

export async function handleYouTubeReportingRequest(request: Request, env: YouTubeReportingEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/internal/youtube/report" && url.pathname !== "/internal/youtube/status") return null;
  if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

  const status = await youtubeAuthorizationStatus(env);
  if (url.pathname === "/internal/youtube/status") {
    return jsonResponse({ ok: true, provider: "youtube", status, retrieved_at: new Date().toISOString() });
  }

  if (status.authorized !== true) {
    return jsonResponse({ ok: false, provider: "youtube", status, error: "youtube_not_authorized" }, 409);
  }

  const days = daysFromUrl(url);
  const requestPayload = { days };
  const [channel, summary, videos, trafficSources, searchTerms] = await Promise.all([
    settled("channel", readYouTubeChannel({}, env)),
    settled("summary", readYouTubeAnalyticsSummary(requestPayload, env)),
    settled("videos", readYouTubeVideoPerformance({ ...requestPayload, max_results: 25 }, env)),
    settled("traffic_sources", readYouTubeTrafficSources(requestPayload, env)),
    settled("search_terms", readYouTubeSearchTerms({ ...requestPayload, max_results: 25, video_limit: 100 }, env)),
  ]);

  const sections = { channel, summary, videos, traffic_sources: trafficSources, search_terms: searchTerms };
  const sectionValues = Object.values(sections);
  const successful = sectionValues.filter((item) => item.ok === true).length;

  return jsonResponse({
    ok: successful >= 3,
    provider: "youtube",
    read_only: true,
    days,
    status,
    section_counts: { total: sectionValues.length, successful, failed: sectionValues.length - successful },
    sections,
    retrieved_at: new Date().toISOString(),
  }, successful >= 3 ? 200 : 502);
}
