import workerV3, { MarePlanCoordinator } from "./worker-v3";
import { handleMareAutonomyMcpRequest, MareAutonomyRunner } from "./mare-autonomy-runner";
import { handleGitHubAutonomyBridgeRequest } from "./mare-github-autonomy-bridge";
import { handleShopifyMediaSeoBridgeRequest } from "./shopify-media-seo-bridge";
import { handleMareKlaviyoCrmMcpRequest } from "./mare-business-klaviyo-crm-mcp";
import { createYouTubeAuthorizationUrl, youtubeAuthorizationStatus } from "./mare-business-youtube";
import { handleTikTokReportingRequest } from "./tiktok-reporting";
import { handleYouTubeReportingRequest } from "./youtube-reporting";
import { handlePublicProductMediaRequest } from "./public-product-media";
import { handleKwayFinalSale180826 } from "./klaviyo-kway-final-sale-180826";
import { handleTorna40Readback190826 } from "./shopify-torna40-readback-190826";
import { handleKlaviyoCampaignInventoryRequest } from "./klaviyo-campaign-inventory";
import { handleKlaviyoAudienceInventoryRequest } from "./klaviyo-audience-inventory";
import { handleSpraygroundLiveCatalogRequest } from "./sprayground-live-catalog";
import { handleSpraygroundPeak240826 } from "./klaviyo-sprayground-peak-240826";
import { handleKlaviyoCommerceMetricProbeRequest } from "./klaviyo-commerce-metric-probe";
import { handleSneakersBtw250826 } from "./klaviyo-sneakers-btw-250826";
import { handleGoogleAdsProductAuditRequest } from "./google-ads-product-audit";

export { MarePlanCoordinator, MareAutonomyRunner };

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
    const klaviyoCrmResponse = await handleMareKlaviyoCrmMcpRequest(request, env as any);
    if (klaviyoCrmResponse) return klaviyoCrmResponse;

    const autonomyResponse = await handleMareAutonomyMcpRequest(request, env as any);
    if (autonomyResponse) return autonomyResponse;

    const githubAutonomyBridgeResponse = await handleGitHubAutonomyBridgeRequest(request, env as any);
    if (githubAutonomyBridgeResponse) return githubAutonomyBridgeResponse;

    const shopifyMediaSeoBridgeResponse = await handleShopifyMediaSeoBridgeRequest(request, env as any);
    if (shopifyMediaSeoBridgeResponse) return shopifyMediaSeoBridgeResponse;

    const publicProductMediaResponse = await handlePublicProductMediaRequest(request, env as any);
    if (publicProductMediaResponse) return publicProductMediaResponse;

    const torna40ReadbackResponse = await handleTorna40Readback190826(request, env as any);
    if (torna40ReadbackResponse) return torna40ReadbackResponse;

    const kwayFinalSaleResponse = await handleKwayFinalSale180826(request, env);
    if (kwayFinalSaleResponse) return kwayFinalSaleResponse;

    const spraygroundPeakResponse = await handleSpraygroundPeak240826(request, env as any);
    if (spraygroundPeakResponse) return spraygroundPeakResponse;

    const sneakersBtwResponse = await handleSneakersBtw250826(request, env as any);
    if (sneakersBtwResponse) return sneakersBtwResponse;

    const klaviyoCampaignInventoryResponse = await handleKlaviyoCampaignInventoryRequest(request, env as any);
    if (klaviyoCampaignInventoryResponse) return klaviyoCampaignInventoryResponse;

    const klaviyoAudienceInventoryResponse = await handleKlaviyoAudienceInventoryRequest(request, env as any);
    if (klaviyoAudienceInventoryResponse) return klaviyoAudienceInventoryResponse;

    const spraygroundLiveCatalogResponse = await handleSpraygroundLiveCatalogRequest(request, env as any);
    if (spraygroundLiveCatalogResponse) return spraygroundLiveCatalogResponse;

    const klaviyoMetricProbeResponse = await handleKlaviyoCommerceMetricProbeRequest(request, env as any);
    if (klaviyoMetricProbeResponse) return klaviyoMetricProbeResponse;

    const googleAdsProductAuditResponse = await handleGoogleAdsProductAuditRequest(request, env as any);
    if (googleAdsProductAuditResponse) return googleAdsProductAuditResponse;

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
