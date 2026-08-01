import assistantWorker from "./worker-v2";
import { handleDailyPulseRequest } from "./daily-pulse";
import { handleGoogleAdsReportingRequest } from "./google-ads-reporting";
import { handleHistoricalAuditRequest } from "./historical-audit";
import { handleKlaviyoReportingRequest } from "./klaviyo-reporting";
import { handleMetaReportingRequest } from "./meta-reporting";
import { handleShopifyBulkStatusCompat } from "./shopify-bulk-status-compat";
import { handleShopifyHistoryProbe } from "./shopify-history-probe";
import { handleShopifyReportingRequest } from "./shopify-reporting";

type WorkerEnv = Parameters<typeof assistantWorker.fetch>[1] & {
  KLAVIYO_PRIVATE_API_KEY?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
  KLAVIYO_CONVERSION_METRIC_ID?: string;
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
  DAILY_PULSE_ACCESS_TOKEN?: string;
};
type WorkerExecutionContext = Parameters<typeof assistantWorker.fetch>[2];

const SHOPIFY_OAUTH_SCOPES = [
  "read_all_orders",
  "read_customers",
  "read_discounts",
  "read_inventory",
  "read_locales",
  "read_locations",
  "read_markets",
  "read_online_store_pages",
  "read_orders",
  "read_products",
  "read_returns",
  "read_shopify_payments_payouts",
  "read_content",
  "read_translations",
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

export default {
  async fetch(request: Request, env: WorkerEnv, context: WorkerExecutionContext): Promise<Response> {
    const installResponse = await handleExpandedShopifyInstall(request, env);
    if (installResponse) return installResponse;

    const historyProbeResponse = await handleShopifyHistoryProbe(request, env);
    if (historyProbeResponse) return historyProbeResponse;

    const reportingEnv = {
      ...env,
      // Dedicated Shopify token is preferred; reuse the already-deployed internal
      // reporting bearer during rollout so no customer-facing route is blocked.
      SHOPIFY_REPORT_ACCESS_TOKEN: env.SHOPIFY_REPORT_ACCESS_TOKEN || env.KLAVIYO_REPORT_ACCESS_TOKEN,
    };

    const bulkStatusCompatResponse = await handleShopifyBulkStatusCompat(request, reportingEnv);
    if (bulkStatusCompatResponse) return bulkStatusCompatResponse;

    const historicalAuditResponse = await handleHistoricalAuditRequest(request, reportingEnv);
    if (historicalAuditResponse) return historicalAuditResponse;

    const shopifyResponse = await handleShopifyReportingRequest(request, reportingEnv);
    if (shopifyResponse) return shopifyResponse;

    const klaviyoResponse = await handleKlaviyoReportingRequest(request, env);
    if (klaviyoResponse) return klaviyoResponse;

    const metaResponse = await handleMetaReportingRequest(request, env);
    if (metaResponse) return metaResponse;

    const googleAdsResponse = await handleGoogleAdsReportingRequest(request, env);
    if (googleAdsResponse) return googleAdsResponse;

    const dailyPulseResponse = await handleDailyPulseRequest(request, reportingEnv);
    if (dailyPulseResponse) return dailyPulseResponse;

    return assistantWorker.fetch(request, env, context);
  },
};
