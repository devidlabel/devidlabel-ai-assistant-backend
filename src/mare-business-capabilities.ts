type JsonObject = Record<string, unknown>;

export type MareBusinessCapability = {
  id: string;
  provider: string;
  domain: string;
  operation: "read" | "prepare" | "execute" | "artifact" | "job";
  risk: "read_only" | "artifact_only" | "reversible_write" | "live_write" | "irreversible";
  implemented: boolean;
  configured: boolean;
  available: boolean;
  approval: "none" | "prepare" | "explicit" | "strong";
  description: string;
  request_schema: JsonObject;
  missing: string[];
};

export type MareBusinessCapabilityEnv = {
  MARE_BUSINESS_ACCESS_TOKEN?: string;
  MARE_MCP_ACCESS_TOKEN?: string;
  MARE_OPS_ACCESS_TOKEN?: string;
  MARE_PRODUCT_MEDIA_ACCESS_TOKEN?: string;
  SHOPIFY_SHOP_DOMAIN?: string;
  SHOPIFY_TOKENS_KV?: unknown;
  OPENAI_API_KEY?: string;
  IMAGES?: unknown;
  KLAVIYO_PRIVATE_API_KEY?: string;
  KLAVIYO_OPERATIONS_API_KEY?: string;
  META_ADS_ACCESS_TOKEN?: string;
  META_WRITE_ACCESS_TOKEN?: string;
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  GOOGLE_ADS_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_ADS_REFRESH_TOKEN?: string;
  GITHUB_OPERATIONS_TOKEN?: string;
  GITHUB_OPERATIONS_REPOSITORIES?: string;
  TIKTOK_APP_ID?: string;
  TIKTOK_APP_SECRET?: string;
  TIKTOK_ACCESS_TOKEN?: string;
  TIKTOK_REFRESH_TOKEN?: string;
  TIKTOK_ADVERTISER_ID?: string;
  GOOGLE_MERCHANT_ACCOUNT_ID?: string;
  GOOGLE_MERCHANT_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_MERCHANT_REFRESH_TOKEN?: string;
  AMAZON_SP_API_REFRESH_TOKEN?: string;
  AMAZON_SP_API_CLIENT_ID?: string;
  AMAZON_SP_API_CLIENT_SECRET?: string;
  SPARTOO_API_KEY?: string;
  MIINTO_API_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  [key: string]: unknown;
};

function configured(...values: unknown[]): boolean {
  return values.every((value) => typeof value === "string" ? value.trim().length > 0 : Boolean(value));
}

function schema(properties: JsonObject = {}, required: string[] = []): JsonObject {
  return { type: "object", properties, required, additionalProperties: true };
}

function capability(
  input: Omit<MareBusinessCapability, "available" | "missing"> & { requirements?: Array<[boolean, string]> },
): MareBusinessCapability {
  const missing = (input.requirements || []).filter(([ok]) => !ok).map(([, name]) => name);
  const { requirements: _requirements, ...rest } = input;
  return { ...rest, missing, available: rest.implemented && rest.configured && missing.length === 0 };
}

export function buildMareBusinessCapabilities(env: MareBusinessCapabilityEnv): MareBusinessCapability[] {
  const businessAuth = configured(env.MARE_BUSINESS_ACCESS_TOKEN);
  const commerce = configured(env.MARE_MCP_ACCESS_TOKEN);
  const operations = configured(env.MARE_OPS_ACCESS_TOKEN);
  const media = configured(env.MARE_PRODUCT_MEDIA_ACCESS_TOKEN);
  const shopify = configured(env.SHOPIFY_SHOP_DOMAIN, env.SHOPIFY_TOKENS_KV);
  const imagePipeline = configured(env.OPENAI_API_KEY, env.IMAGES);
  const klaviyoRead = configured(env.KLAVIYO_PRIVATE_API_KEY);
  const klaviyoWrite = configured(env.KLAVIYO_OPERATIONS_API_KEY);
  const metaWrite = configured(env.META_ADS_ACCESS_TOKEN, env.META_WRITE_ACCESS_TOKEN);
  const googleWrite = configured(env.GOOGLE_ADS_DEVELOPER_TOKEN) && configured(env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON || env.GOOGLE_ADS_REFRESH_TOKEN);
  const githubWrite = configured(env.GITHUB_OPERATIONS_TOKEN, env.GITHUB_OPERATIONS_REPOSITORIES);
  const tiktokApp = configured(env.TIKTOK_APP_ID, env.TIKTOK_APP_SECRET);
  const tiktokAuthorized = configured(env.TIKTOK_ACCESS_TOKEN, env.TIKTOK_ADVERTISER_ID);
  const merchant = configured(env.GOOGLE_MERCHANT_ACCOUNT_ID) && configured(env.GOOGLE_MERCHANT_SERVICE_ACCOUNT_JSON || env.GOOGLE_MERCHANT_REFRESH_TOKEN);
  const amazon = configured(env.AMAZON_SP_API_REFRESH_TOKEN, env.AMAZON_SP_API_CLIENT_ID, env.AMAZON_SP_API_CLIENT_SECRET);

  return [
    capability({ id: "system.status", provider: "mare", domain: "system", operation: "read", risk: "read_only", implemented: true, configured: businessAuth, approval: "none", description: "Unified health, permission and provider configuration status.", request_schema: schema(), requirements: [[businessAuth, "MARE_BUSINESS_ACCESS_TOKEN"]] }),
    capability({ id: "system.capabilities", provider: "mare", domain: "system", operation: "read", risk: "read_only", implemented: true, configured: businessAuth, approval: "none", description: "Dynamic capability registry used by every V2 agent.", request_schema: schema(), requirements: [[businessAuth, "MARE_BUSINESS_ACCESS_TOKEN"]] }),
    capability({ id: "artifact.get", provider: "mare", domain: "artifact", operation: "artifact", risk: "read_only", implemented: true, configured: shopify, approval: "none", description: "Retrieve a stored report, feed, Matrixify file or image artifact.", request_schema: schema({ artifact_id: { type: "string" } }, ["artifact_id"]), requirements: [[shopify, "SHOPIFY_TOKENS_KV"]] }),

    capability({ id: "shopify.catalog.read", provider: "shopify", domain: "catalog", operation: "read", risk: "read_only", implemented: true, configured: shopify, approval: "none", description: "Read the complete Shopify catalog with products, variants, SKU, prices, compare-at prices, costs, stock by location, collections and media.", request_schema: schema({ query: { type: "string" }, max_products: { type: "integer", minimum: 1, maximum: 2500 }, inline_limit: { type: "integer", minimum: 0, maximum: 100 }, include_csv: { type: "boolean" } }), requirements: [[shopify, "Shopify OAuth/KV"]] }),
    capability({ id: "shopify.catalog.export", provider: "shopify", domain: "catalog", operation: "artifact", risk: "artifact_only", implemented: true, configured: shopify, approval: "none", description: "Export the canonical Shopify catalog as JSON and CSV artifacts.", request_schema: schema({ query: { type: "string" }, max_products: { type: "integer" }, include_csv: { type: "boolean" } }), requirements: [[shopify, "Shopify OAuth/KV"]] }),
    capability({ id: "shopify.media.find", provider: "shopify", domain: "media", operation: "read", risk: "read_only", implemented: true, configured: media, approval: "none", description: "Find product media by vendor and inclusive title range.", request_schema: schema({ vendor: { type: "string" }, start_title: { type: "string" }, end_title: { type: "string" }, max_products: { type: "integer" } }, ["vendor"]), requirements: [[media, "MARE_PRODUCT_MEDIA_ACCESS_TOKEN"]] }),
    capability({ id: "shopify.media.read", provider: "shopify", domain: "media", operation: "read", risk: "read_only", implemented: true, configured: media, approval: "none", description: "Read one original Shopify product image for visual inspection.", request_schema: schema({ product_id: { type: "string" }, media_id: { type: "string" } }, ["product_id", "media_id"]), requirements: [[media, "MARE_PRODUCT_MEDIA_ACCESS_TOKEN"]] }),
    capability({ id: "shopify.media.preview", provider: "shopify", domain: "media", operation: "prepare", risk: "artifact_only", implemented: true, configured: media && imagePipeline, approval: "explicit", description: "Generate a strict product-faithful 600x771 white-background preview without altering Shopify.", request_schema: schema({ product_id: { type: "string" }, media_id: { type: "string" }, idempotency_key: { type: "string" } }, ["product_id", "media_id", "idempotency_key"]), requirements: [[media, "MARE_PRODUCT_MEDIA_ACCESS_TOKEN"], [imagePipeline, "OPENAI_API_KEY and IMAGES"]] }),
    capability({ id: "shopify.media.publish", provider: "shopify", domain: "media", operation: "execute", risk: "live_write", implemented: true, configured: media && shopify, approval: "explicit", description: "Publish an approved stored preview to the matching Shopify product while preserving originals.", request_schema: schema({ preview_id: { type: "string" }, product_id: { type: "string" }, idempotency_key: { type: "string" }, alt_text: { type: "string" }, make_primary: { type: "boolean" } }, ["preview_id", "product_id", "idempotency_key"]), requirements: [[media, "MARE_PRODUCT_MEDIA_ACCESS_TOKEN"], [shopify, "Shopify write_products"]] }),

    capability({ id: "commerce.daily_pulse", provider: "mare", domain: "commerce", operation: "read", risk: "read_only", implemented: true, configured: commerce, approval: "none", description: "Executive Shopify and paid-media pulse using the established ecommerce channel policy.", request_schema: schema(), requirements: [[commerce, "MARE_MCP_ACCESS_TOKEN"]] }),
    capability({ id: "shopify.commerce.report", provider: "shopify", domain: "commerce", operation: "read", risk: "read_only", implemented: true, configured: commerce, approval: "none", description: "Shopify revenue, orders and channel segmentation report.", request_schema: schema({ timeframe: { type: "string" } }), requirements: [[commerce, "MARE_MCP_ACCESS_TOKEN"]] }),
    capability({ id: "paid_media.report", provider: "multi", domain: "advertising", operation: "read", risk: "read_only", implemented: true, configured: commerce, approval: "none", description: "Combined Meta and Google Ads reporting with non-additive attribution guardrail.", request_schema: schema({ timeframe: { type: "string" } }), requirements: [[commerce, "MARE_MCP_ACCESS_TOKEN"]] }),
    capability({ id: "ga4.report", provider: "google_analytics", domain: "analytics", operation: "read", risk: "read_only", implemented: true, configured: commerce, approval: "none", description: "GA4 traffic and funnel diagnostics.", request_schema: schema({ timeframe: { type: "string" } }), requirements: [[commerce, "MARE_MCP_ACCESS_TOKEN"]] }),
    capability({ id: "ga4.realtime", provider: "google_analytics", domain: "analytics", operation: "read", risk: "read_only", implemented: true, configured: commerce, approval: "none", description: "GA4 realtime aggregate diagnostics.", request_schema: schema(), requirements: [[commerce, "MARE_MCP_ACCESS_TOKEN"]] }),
    capability({ id: "search_console.report", provider: "search_console", domain: "seo", operation: "read", risk: "read_only", implemented: true, configured: commerce, approval: "none", description: "Search Console queries, pages, devices and countries.", request_schema: schema({ timeframe: { type: "string" }, top_rows: { type: "integer" } }), requirements: [[commerce, "MARE_MCP_ACCESS_TOKEN"]] }),
    capability({ id: "klaviyo.report", provider: "klaviyo", domain: "crm", operation: "read", risk: "read_only", implemented: true, configured: commerce, approval: "none", description: "Klaviyo campaign and flow reporting.", request_schema: schema({ timeframe: { type: "string" } }), requirements: [[commerce, "MARE_MCP_ACCESS_TOKEN"]] }),
    capability({ id: "klaviyo.crm.audiences.read", provider: "klaviyo", domain: "crm", operation: "read", risk: "read_only", implemented: true, configured: businessAuth && klaviyoRead, approval: "none", description: "Read aggregate Klaviyo list and segment metadata, with optional counts, without returning individual contact data.", request_schema: schema({ query: { type: "string" }, inline_limit: { type: "integer", minimum: 1, maximum: 100 }, profile_count_limit: { type: "integer", minimum: 0, maximum: 10 } }), requirements: [[businessAuth, "MARE_BUSINESS_ACCESS_TOKEN"], [klaviyoRead, "KLAVIYO_PRIVATE_API_KEY"]] }),
    capability({ id: "klaviyo.crm.profiles.aggregate", provider: "klaviyo", domain: "crm", operation: "read", risk: "read_only", implemented: true, configured: businessAuth && klaviyoRead, approval: "none", description: "Aggregate Klaviyo account and email-consent totals without returning identifiers or contact data.", request_schema: schema({ max_records: { type: "integer", minimum: 100, maximum: 100000 } }), requirements: [[businessAuth, "MARE_BUSINESS_ACCESS_TOKEN"], [klaviyoRead, "KLAVIYO_PRIVATE_API_KEY"]] }),

    capability({ id: "permissions.audit", provider: "mare", domain: "security", operation: "read", risk: "read_only", implemented: true, configured: operations, approval: "none", description: "Provider permissions and missing configuration audit without exposing secrets.", request_schema: schema(), requirements: [[operations, "MARE_OPS_ACCESS_TOKEN"]] }),
    capability({ id: "klaviyo.campaign.draft.create", provider: "klaviyo", domain: "crm", operation: "execute", risk: "reversible_write", implemented: true, configured: operations && klaviyoWrite, approval: "explicit", description: "Create a Klaviyo campaign draft only.", request_schema: schema({}, []), requirements: [[operations, "MARE_OPS_ACCESS_TOKEN"], [klaviyoWrite, "KLAVIYO_OPERATIONS_API_KEY"]] }),
    capability({ id: "klaviyo.campaign.draft.update", provider: "klaviyo", domain: "crm", operation: "execute", risk: "reversible_write", implemented: true, configured: operations && klaviyoWrite, approval: "explicit", description: "Update an existing Klaviyo campaign while it remains Draft.", request_schema: schema({}, []), requirements: [[operations, "MARE_OPS_ACCESS_TOKEN"], [klaviyoWrite, "KLAVIYO_OPERATIONS_API_KEY"]] }),
    capability({ id: "meta.entity.mutate", provider: "meta", domain: "advertising", operation: "execute", risk: "live_write", implemented: true, configured: operations && metaWrite, approval: "explicit", description: "Create or update Meta campaigns, ad sets and ads. New entities default to PAUSED.", request_schema: schema({}, []), requirements: [[operations, "MARE_OPS_ACCESS_TOKEN"], [metaWrite, "Meta ads_management credentials"]] }),
    capability({ id: "google_ads.campaign.update", provider: "google_ads", domain: "advertising", operation: "execute", risk: "live_write", implemented: true, configured: operations && googleWrite, approval: "explicit", description: "Update an existing Google Ads campaign name, state or daily budget.", request_schema: schema({}, []), requirements: [[operations, "MARE_OPS_ACCESS_TOKEN"], [googleWrite, "Google Ads write credentials"]] }),
    capability({ id: "github.pull_request.create", provider: "github", domain: "engineering", operation: "execute", risk: "reversible_write", implemented: true, configured: operations && githubWrite, approval: "explicit", description: "Create a mare/* branch, write allowlisted files and open a draft pull request.", request_schema: schema({}, []), requirements: [[operations, "MARE_OPS_ACCESS_TOKEN"], [githubWrite, "GitHub operations token and repository allowlist"]] }),

    capability({ id: "marketplace.feed.generate", provider: "multi", domain: "marketplace", operation: "prepare", risk: "artifact_only", implemented: true, configured: shopify, approval: "none", description: "Generate a validated channel feed artifact from the canonical Shopify catalog for Google Merchant, Meta, TikTok, Amazon or generic marketplaces.", request_schema: schema({ channel: { type: "string" }, query: { type: "string" }, country: { type: "string" }, language: { type: "string" }, currency: { type: "string" }, max_products: { type: "integer" } }, ["channel"]), requirements: [[shopify, "Shopify catalog access"]] }),
    capability({ id: "matrixify.catalog.generate", provider: "matrixify", domain: "catalog", operation: "prepare", risk: "artifact_only", implemented: true, configured: shopify, approval: "none", description: "Generate a Matrixify-compatible product and variant CSV artifact from live Shopify data and requested transformations.", request_schema: schema({ query: { type: "string" }, operation: { type: "string" }, transformations: { type: "object" }, max_products: { type: "integer" } }), requirements: [[shopify, "Shopify catalog access"]] }),

    capability({ id: "tiktok.authorization.status", provider: "tiktok", domain: "advertising", operation: "read", risk: "read_only", implemented: true, configured: tiktokApp, approval: "none", description: "Check TikTok app, access-token and advertiser authorization state.", request_schema: schema(), requirements: [[tiktokApp, "TIKTOK_APP_ID and TIKTOK_APP_SECRET"]] }),
    capability({ id: "tiktok.campaign.read", provider: "tiktok", domain: "advertising", operation: "read", risk: "read_only", implemented: true, configured: tiktokAuthorized, approval: "none", description: "Read TikTok campaigns for the authorized advertiser.", request_schema: schema({ page: { type: "integer" }, page_size: { type: "integer" }, filtering: { type: "object" } }), requirements: [[tiktokAuthorized, "TIKTOK_ACCESS_TOKEN and TIKTOK_ADVERTISER_ID"]] }),
    capability({ id: "tiktok.campaign.create", provider: "tiktok", domain: "advertising", operation: "execute", risk: "live_write", implemented: true, configured: tiktokAuthorized, approval: "explicit", description: "Create a TikTok campaign disabled by default; enabling requires stronger approval.", request_schema: schema({}, []), requirements: [[tiktokAuthorized, "TikTok advertiser authorization"]] }),
    capability({ id: "tiktok.campaign.update", provider: "tiktok", domain: "advertising", operation: "execute", risk: "live_write", implemented: true, configured: tiktokAuthorized, approval: "explicit", description: "Update a TikTok campaign with explicit approval.", request_schema: schema({}, []), requirements: [[tiktokAuthorized, "TikTok advertiser authorization"]] }),

    capability({ id: "google_merchant.products.read", provider: "google_merchant", domain: "feed", operation: "read", risk: "read_only", implemented: false, configured: merchant, approval: "none", description: "Read processed products and product issues from Merchant Center.", request_schema: schema(), requirements: [[merchant, "Merchant API credentials"]] }),
    capability({ id: "google_merchant.products.sync", provider: "google_merchant", domain: "feed", operation: "execute", risk: "live_write", implemented: false, configured: merchant, approval: "explicit", description: "Synchronize Shopify products to an API data source in Merchant Center.", request_schema: schema(), requirements: [[merchant, "Merchant API credentials"]] }),
    capability({ id: "amazon.listings.sync", provider: "amazon", domain: "marketplace", operation: "execute", risk: "live_write", implemented: false, configured: amazon, approval: "explicit", description: "Create or update Amazon listings using Listings Items API or JSON_LISTINGS_FEED.", request_schema: schema(), requirements: [[amazon, "Amazon SP-API credentials"]] }),
    capability({ id: "spartoo.catalog.sync", provider: "spartoo", domain: "marketplace", operation: "execute", risk: "live_write", implemented: false, configured: configured(env.SPARTOO_API_KEY), approval: "explicit", description: "Synchronize products, prices and inventory with Spartoo after its API contract is mapped.", request_schema: schema(), requirements: [[configured(env.SPARTOO_API_KEY), "SPARTOO_API_KEY"]] }),
    capability({ id: "miinto.catalog.sync", provider: "miinto", domain: "marketplace", operation: "execute", risk: "live_write", implemented: false, configured: configured(env.MIINTO_API_TOKEN), approval: "explicit", description: "Synchronize products, prices and inventory with Miinto after its API contract is mapped.", request_schema: schema(), requirements: [[configured(env.MIINTO_API_TOKEN), "MIINTO_API_TOKEN"]] }),

    capability({ id: "ai.claude.review", provider: "anthropic", domain: "model_router", operation: "prepare", risk: "artifact_only", implemented: false, configured: configured(env.ANTHROPIC_API_KEY), approval: "none", description: "Use Claude as a specialist or independent reviewer inside a controlled job.", request_schema: schema(), requirements: [[configured(env.ANTHROPIC_API_KEY), "ANTHROPIC_API_KEY"]] }),
    capability({ id: "ai.gemini.review", provider: "google_gemini", domain: "model_router", operation: "prepare", risk: "artifact_only", implemented: false, configured: configured(env.GEMINI_API_KEY), approval: "none", description: "Use Gemini as a specialist or multimodal reviewer inside a controlled job.", request_schema: schema(), requirements: [[configured(env.GEMINI_API_KEY), "GEMINI_API_KEY"]] }),
  ];
}

export function findCapability(id: string, env: MareBusinessCapabilityEnv): MareBusinessCapability | null {
  return buildMareBusinessCapabilities(env).find((item) => item.id === id) || null;
}
