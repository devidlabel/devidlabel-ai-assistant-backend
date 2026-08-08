import assistantWorker from "./worker-v2";
import { handleDailyPulseRequest } from "./daily-pulse-organic";
import { handleGa4ReportingRequest } from "./ga4-reporting";
import { handleGoogleAdsReportingRequest } from "./google-ads-reporting";
import { handleHistoricalAuditRequest } from "./historical-audit";
import { handleKlaviyoReportingRequest } from "./klaviyo-reporting";
import { handleMareBusinessMcpFinalRequest } from "./mare-business-mcp-final";
import { handleTikTokOAuthFinalCallbackRequest } from "./mare-business-tiktok-final";
import { MarePlanCoordinator } from "./mare-plan-coordinator";
import { handleMareMcpRequest } from "./mare-mcp";
import { handleMareOperationsMcpRequest } from "./mare-operations-mcp";
import { handleMareProductMediaMcpRequest } from "./mare-product-media-mcp";
import { handleMetaReportingRequest } from "./meta-reporting";
import { handleSearchConsoleReportingRequest } from "./search-console-reporting";
import { handleShopifyAnalyticsReportingRequest } from "./shopify-analytics-reporting";
import { handleShopifyBulkStatusCompat } from "./shopify-bulk-status-compat";
import { handleShopifyHistoryProbe } from "./shopify-history-probe";
import { handleShopifyReportingRequest } from "./shopify-reporting";
import { handleTorna40Once } from "./shopify-torna40-once";

export { MarePlanCoordinator };

type WorkerEnv = Parameters<typeof assistantWorker.fetch>[1] & {
  KLAVIYO_PRIVATE_API_KEY?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
  KLAVIYO_CONVERSION_METRIC_ID?: string;
  KLAVIYO_OPERATIONS_API_KEY?: string;
  SHOPIFY_REPORT_ACCESS_TOKEN?: string;
  COMMERCE_TENANT_ID?: string;
  META_ADS_ACCESS_TOKEN?: string;
  META_AD_ACCOUNT_ID?: string;
  META_GRAPH_API_VERSION?: string;
  META_REPORT_ACCESS_TOKEN?: string;
  META_WRITE_ACCESS_TOKEN?: string;
  META_PIXEL_ID?: string;
  GOOGLE_ADS_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
  GOOGLE_ADS_REFRESH_TOKEN?: string;
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  GOOGLE_ADS_CUSTOMER_ID?: string;
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;
  GOOGLE_ADS_API_VERSION?: string;
  GOOGLE_ADS_REPORT_ACCESS_TOKEN?: string;
  GOOGLE_ORGANIC_REPORT_ACCESS_TOKEN?: string;
  GOOGLE_MERCHANT_ACCOUNT_ID?: string;
  GOOGLE_MERCHANT_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_MERCHANT_REFRESH_TOKEN?: string;
  SEARCH_CONSOLE_SITE_URL?: string;
  GA4_PROPERTY_ID?: string;
  DAILY_PULSE_ACCESS_TOKEN?: string;
  MARE_MCP_ACCESS_TOKEN?: string;
  MARE_OPS_ACCESS_TOKEN?: string;
  MARE_PRODUCT_MEDIA_ACCESS_TOKEN?: string;
  MARE_BUSINESS_ACCESS_TOKEN?: string;
  MARE_PLAN_COORDINATOR?: unknown;
  PRODUCT_IMAGE_MODEL?: string;
  IMAGES?: unknown;
  GITHUB_OPERATIONS_TOKEN?: string;
  GITHUB_OPERATIONS_REPOSITORIES?: string;
  TIKTOK_APP_ID?: string;
  TIKTOK_APP_SECRET?: string;
  TIKTOK_REDIRECT_URI?: string;
  TIKTOK_AUTHORIZATION_URL?: string;
  TIKTOK_ACCESS_TOKEN?: string;
  TIKTOK_ADVERTISER_ID?: string;
  AMAZON_SP_API_REFRESH_TOKEN?: string;
  AMAZON_SP_API_CLIENT_ID?: string;
  AMAZON_SP_API_CLIENT_SECRET?: string;
  SPARTOO_API_KEY?: string;
  MIINTO_API_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
};
type WorkerExecutionContext = Parameters<typeof assistantWorker.fetch>[2];

const SHOPIFY_OAUTH_SCOPES = [
  "read_all_orders",
  "read_customers",
  "read_discounts",
  "write_discounts",
  "read_files",
  "write_files",
  "read_inventory",
  "write_inventory",
  "read_locales",
  "read_locations",
  "read_markets",
  "read_online_store_navigation",
  "write_online_store_navigation",
  "read_online_store_pages",
  "read_orders",
  "read_products",
  "write_products",
  "read_reports",
  "read_returns",
  "read_shopify_payments_payouts",
  "read_content",
  "write_content",
  "read_metaobject_definitions",
  "write_metaobject_definitions",
  "read_metaobjects",
  "write_metaobjects",
  "read_translations",
  "write_translations",
  "write_publications",
].join(",");
const SHOPIFY_OAUTH_REDIRECT_URI = "https://devidlabel-ai-assistant-backend.devidlabel.workers.dev/auth/callback";
const SHOPIFY_OAUTH_STATE_TTL_SECONDS = 600;

function normalizeShopifyDomainCandidate(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function isValidShopifyShopDomain(shop: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

function oauthError(message: string, status = 500): Response {
  return new Response(JSON.stringify({ ok: false, source: "shopify_oauth", message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function handleExpandedShopifyInstall(request: Request, env: WorkerEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/install") return null;
  if (request.method !== "GET") return oauthError("Metodo non supportato.", 405);

  const configuredShop = normalizeShopifyDomainCandidate(env.SHOPIFY_SHOP_DOMAIN || "");
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) return oauthError("Configurazione Shopify OAuth incompleta.");
  if (!env.SHOPIFY_TOKENS_KV) return oauthError("Storage Shopify OAuth non configurato.");
  if (!isValidShopifyShopDomain(configuredShop)) return oauthError("Shop Shopify configurato non valido.");

  const shop = normalizeShopifyDomainCandidate(url.searchParams.get("shop") || configuredShop);
  if (!isValidShopifyShopDomain(shop)) return oauthError("Shop Shopify non valido.", 400);
  if (shop !== configuredShop) return oauthError("Shop Shopify non autorizzato.", 403);

  const state = crypto.randomUUID().replace(/-/g, "");
  await env.SHOPIFY_TOKENS_KV.put(
    `shopify:oauth_state:${state}`,
    JSON.stringify({ shop, created_at: new Date().toISOString() }),
    { expirationTtl: SHOPIFY_OAUTH_STATE_TTL_SECONDS },
  );

  const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", env.SHOPIFY_CLIENT_ID);
  authorizeUrl.searchParams.set("scope", SHOPIFY_OAUTH_SCOPES);
  authorizeUrl.searchParams.set("redirect_uri", SHOPIFY_OAUTH_REDIRECT_URI);
  authorizeUrl.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: { Location: authorizeUrl.toString(), "Cache-Control": "no-store" },
  });
}

function suppliedBearer(request: Request): string {
  const authorization = request.headers.get("Authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function selectShopifyReportAccessToken(request: Request, env: WorkerEnv): string | undefined {
  const supplied = suppliedBearer(request);
  const dailyPulseToken = env.DAILY_PULSE_ACCESS_TOKEN?.trim();
  if (dailyPulseToken && supplied === dailyPulseToken) return dailyPulseToken;
  return env.SHOPIFY_REPORT_ACCESS_TOKEN || env.KLAVIYO_REPORT_ACCESS_TOKEN || dailyPulseToken;
}

export default {
  async fetch(request: Request, env: WorkerEnv, context: WorkerExecutionContext): Promise<Response> {
    const installResponse = await handleExpandedShopifyInstall(request, env);
    if (installResponse) return installResponse;

    const torna40Response = await handleTorna40Once(request, env as any);
    if (torna40Response) return torna40Response;

    const tiktokOAuthResponse = await handleTikTokOAuthFinalCallbackRequest(request, env as any);
    if (tiktokOAuthResponse) return tiktokOAuthResponse;

    const businessMcpResponse = await handleMareBusinessMcpFinalRequest(request, env as any);
    if (businessMcpResponse) return businessMcpResponse;

    const productMediaMcpResponse = await handleMareProductMediaMcpRequest(request, env as any);
    if (productMediaMcpResponse) return productMediaMcpResponse;

    const operationsMcpResponse = await handleMareOperationsMcpRequest(request, env as any);
    if (operationsMcpResponse) return operationsMcpResponse;

    const mcpResponse = await handleMareMcpRequest(request, env as any);
    if (mcpResponse) return mcpResponse;

    const historyProbeResponse = await handleShopifyHistoryProbe(request, env);
    if (historyProbeResponse) return historyProbeResponse;

    const reportingEnv = {
      ...env,
      SHOPIFY_REPORT_ACCESS_TOKEN: selectShopifyReportAccessToken(request, env),
    };

    const bulkStatusCompatResponse = await handleShopifyBulkStatusCompat(request, reportingEnv);
    if (bulkStatusCompatResponse) return bulkStatusCompatResponse;

    const historicalAuditResponse = await handleHistoricalAuditRequest(request, reportingEnv);
    if (historicalAuditResponse) return historicalAuditResponse;

    const shopifyAnalyticsResponse = await handleShopifyAnalyticsReportingRequest(request, reportingEnv);
    if (shopifyAnalyticsResponse) return shopifyAnalyticsResponse;

    const shopifyResponse = await handleShopifyReportingRequest(request, reportingEnv);
    if (shopifyResponse) return shopifyResponse;

    const klaviyoResponse = await handleKlaviyoReportingRequest(request, env);
    if (klaviyoResponse) return klaviyoResponse;

    const metaResponse = await handleMetaReportingRequest(request, env);
    if (metaResponse) return metaResponse;

    const googleAdsResponse = await handleGoogleAdsReportingRequest(request, env);
    if (googleAdsResponse) return googleAdsResponse;

    const searchConsoleResponse = await handleSearchConsoleReportingRequest(request, env);
    if (searchConsoleResponse) return searchConsoleResponse;

    const ga4Response = await handleGa4ReportingRequest(request, env);
    if (ga4Response) return ga4Response;

    const dailyPulseResponse = await handleDailyPulseRequest(request, reportingEnv);
    if (dailyPulseResponse) return dailyPulseResponse;

    return assistantWorker.fetch(request, env, context);
  },
};
