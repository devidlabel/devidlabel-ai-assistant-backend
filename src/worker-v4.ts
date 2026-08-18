import workerV3, { MarePlanCoordinator } from "./worker-v3";
import { createYouTubeAuthorizationUrl, youtubeAuthorizationStatus } from "./mare-business-youtube";
import { handleTikTokReportingRequest } from "./tiktok-reporting";
import { handleYouTubeReportingRequest } from "./youtube-reporting";
import { handleKwayFinalSale180826 } from "./klaviyo-kway-final-sale-180826";

export { MarePlanCoordinator };

type WorkerEnv = Parameters<typeof workerV3.fetch>[1];
type WorkerExecutionContext = Parameters<typeof workerV3.fetch>[2];

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

export default {
  async fetch(request: Request, env: WorkerEnv, context: WorkerExecutionContext): Promise<Response> {
    const kwayFinalSaleResponse = await handleKwayFinalSale180826(request, env);
    if (kwayFinalSaleResponse) return kwayFinalSaleResponse;

    const url = new URL(request.url);
    if (url.pathname === "/auth/youtube/start") {
      if (request.method !== "GET") return jsonResponse({ ok: false, provider: "youtube", error: "method_not_allowed" }, 405);
      const status = await youtubeAuthorizationStatus(env as any);
      if (status.authorized === true) {
        return jsonResponse({ ok: true, provider: "youtube", authorized: true, read_only: true, message: "YouTube is already authorized." });
      }
      try {
        const prepared = await createYouTubeAuthorizationUrl(env as any);
        const authorizationUrl = typeof prepared.authorization_url === "string" ? prepared.authorization_url : "";
        if (!authorizationUrl) return jsonResponse({ ok: false, provider: "youtube", error: "authorization_url_missing" }, 500);
        return new Response(null, {
          status: 302,
          headers: {
            Location: authorizationUrl,
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        });
      } catch (error) {
        return jsonResponse({ ok: false, provider: "youtube", error: error instanceof Error ? error.message : "youtube_oauth_start_failed" }, 500);
      }
    }

    const tiktokReportingResponse = await handleTikTokReportingRequest(request, env as any);
    if (tiktokReportingResponse) return tiktokReportingResponse;

    const youtubeReportingResponse = await handleYouTubeReportingRequest(request, env as any);
    if (youtubeReportingResponse) return youtubeReportingResponse;

    return workerV3.fetch(request, env, context);
  },
};
