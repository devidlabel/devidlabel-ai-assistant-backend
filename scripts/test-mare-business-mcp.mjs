import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const mcpSource = readFileSync("src/mare-business-mcp.ts", "utf8");
const safeMcpSource = readFileSync("src/mare-business-mcp-safe.ts", "utf8");
const finalMcpSource = readFileSync("src/mare-business-mcp-final.ts", "utf8");
const capabilitiesSource = readFileSync("src/mare-business-capabilities.ts", "utf8");
const shopifySource = readFileSync("src/mare-business-shopify.ts", "utf8");
const shopifyCompact = shopifySource.replace(/\s+/g, "");
const completeShopifySource = readFileSync("src/mare-business-shopify-complete.ts", "utf8");
const completeShopifyCompact = completeShopifySource.replace(/\s+/g, "");
const marketplaceSource = readFileSync("src/mare-business-marketplace.ts", "utf8");
const completeMarketplaceSource = readFileSync("src/mare-business-marketplace-complete.ts", "utf8");
const tiktokSource = readFileSync("src/mare-business-tiktok.ts", "utf8");
const safeTikTokSource = readFileSync("src/mare-business-tiktok-safe.ts", "utf8");
const finalTikTokSource = readFileSync("src/mare-business-tiktok-final.ts", "utf8");
const coordinatorSource = readFileSync("src/mare-plan-coordinator.ts", "utf8");
const workerSource = readFileSync("src/worker-v3.ts", "utf8");
const wranglerSource = readFileSync("wrangler.toml", "utf8");

const stableTools = [
  "mare_system_status",
  "mare_capabilities",
  "mare_describe",
  "mare_read",
  "mare_prepare",
  "mare_validate",
  "mare_execute",
  "mare_job_status",
  "mare_job_control",
  "mare_artifact_get",
];
for (const tool of stableTools) assert.ok(mcpSource.includes(`name: "${tool}"`), `Missing stable Business OS tool ${tool}`);
assert.equal((mcpSource.match(/name: "mare_[a-z0-9_]+"/g) || []).length, 10, "MARE Business OS must expose exactly ten stable tools");

for (const fragment of [
  'MARE_BUSINESS_ACCESS_TOKEN', 'immutable_plan_before_external_write: true', 'EXECUTE MARE PLAN', 'EXECUTE MARE LIVE PLAN',
  'credentials_or_customer_contact_data_not_accepted', 'direct_delete_capability_exposed: false', 'handleMareMcpRequest',
  'handleMareOperationsMcpRequest', 'handleMareProductMediaMcpRequest',
]) assert.ok(mcpSource.includes(fragment), `Missing Business OS safeguard or internal adapter: ${fragment}`);

for (const forbidden of [
  'normalize(env.MARE_OPS_ACCESS_TOKEN) ||', 'normalize(env.MARE_MCP_ACCESS_TOKEN) ||',
  'normalize(env.MARE_PRODUCT_MEDIA_ACCESS_TOKEN) ||', 'DELETE MARE',
]) assert.equal(mcpSource.includes(forbidden), false, `Forbidden Business OS auth fallback or delete exposed: ${forbidden}`);

for (const capability of [
  "shopify.catalog.read", "shopify.catalog.export", "shopify.media.preview", "shopify.media.publish", "marketplace.feed.generate",
  "matrixify.catalog.generate", "tiktok.authorization.status", "tiktok.campaign.read", "tiktok.campaign.create", "tiktok.campaign.update",
  "google_merchant.products.sync", "amazon.listings.sync", "ai.claude.review", "ai.gemini.review",
]) assert.ok(capabilitiesSource.includes(`id: "${capability}"`), `Missing dynamic capability ${capability}`);

for (const fragment of [
  "inventoryLevels(first:5)", "unitCost{amountcurrencyCode}", "compareAtPrice", "collections(first:20)", "media(first:20)",
  "shopify_catalog_json", "shopify_catalog_csv",
]) assert.ok(shopifyCompact.includes(fragment), `Missing canonical Shopify catalog field or artifact: ${fragment}`);

for (const fragment of [
  "pageInfo{hasNextPageendCursor}", "VARIANT_PAGE_QUERY", "loadAllVariants", "complete_variant_pagination:true",
  "inventoryLevels(first:10)", "collections(first:20)", "media(first:20)",
]) assert.ok(completeShopifyCompact.includes(fragment), `Missing complete catalog pagination guard: ${fragment}`);

for (const fragment of [
  '"google_merchant"', '"meta_catalog"', '"tiktok_catalog"', '"amazon_json_listings"', '"spartoo_csv"', '"miinto_csv"',
  'direct_external_push_performed: false', 'matrixify_catalog_csv',
]) assert.ok(marketplaceSource.includes(fragment), `Missing marketplace/feed foundation: ${fragment}`);

for (const fragment of [
  "regularPrice = discounted ? compareAtPrice : currentPrice", 'sale_price: discounted ? `${currentPrice.toFixed(2)} ${currency}` : ""',
  "readShopifyCatalogComplete", "complete_variant_pagination: true", "regular_and_sale_price_mapping: true", "matrixify_catalog_complete_csv",
]) assert.ok(completeMarketplaceSource.includes(fragment), `Missing hardened feed or Matrixify behavior: ${fragment}`);

for (const fragment of [
  '/oauth2/access_token/', 'app_id: appId, secret: appSecret, auth_code: authCode', '/campaign/get/', '/campaign/create/',
  '/campaign/update/', '/campaign/status/update/', 'operation_status = "DISABLE"', 'ENABLE TIKTOK CAMPAIGN', 'raw_secret_values_exposed: false',
]) assert.ok(tiktokSource.includes(fragment) || safeTikTokSource.includes(fragment), `Missing TikTok Marketing API contract: ${fragment}`);

for (const fragment of [
  'tiktok_oauth_start_requires_authenticated_mare_prepare', 'createTikTokAuthorizationUrl', 'MARE-${cleaned.slice(-16)}',
  'workers.dev/oauth/tiktok/callback', 'existing_campaign', 'PAUSE TIKTOK CAMPAIGN',
]) assert.ok(safeTikTokSource.includes(fragment), `Missing TikTok hardening: ${fragment}`);

for (const fragment of [
  'resolvedCapabilities', 'tiktok.authorization.start', 'reconciliation_required', 'plan_reconciliation_required',
  'complete_variant_pagination: true', 'correct_regular_and_sale_price_mapping: true', 'operationStatus === "DISABLE"', '"PAUSE TIKTOK CAMPAIGN"',
]) assert.ok(safeMcpSource.includes(fragment), `Missing Business runtime hardening: ${fragment}`);

for (const fragment of [
  'SENSITIVE_KEY_PATTERN', 'credential', 'customer', 'email', 'token', 'assertRequestSafe(payload)',
  'credentials_or_customer_contact_data_not_accepted', 'MAX_MCP_REQUEST_BYTES = 512 * 1024', 'await request.clone().text()',
  'JSON.parse(rawRequest)', 'FULL_CATALOG_PRODUCT_LIMIT = 2500', 'catalog_truncated_artifact_blocked',
  'strictCatalogPreflight(payload, env)', 'plan.risk === "live_write" || plan.risk === "reversible_write"',
  'validatePlanBeforeClaim', 'coordinatorAction(env, planId, "claim")', 'MATRIXIFY_ALLOWED_OPERATIONS',
  'matrixify_operation_not_allowed', 'TIKTOK_NAME_MARKER_RESERVE = 24', 'requestedName.slice(0, maximumRequestedLength)',
]) assert.ok(finalMcpSource.includes(fragment), `Missing final Business OS guard: ${fragment}`);

assert.ok(finalMcpSource.indexOf('validatePlanBeforeClaim(request, planId, env)') < finalMcpSource.indexOf('coordinatorAction(env, planId, "claim")'), "Plan validation must occur before execution claim");

for (const fragment of [
  'CALLBACK_PATH = "/oauth/tiktok/callback"', 'LEGACY_CALLBACK_PATH = "/auth/tiktok/callback"',
  '/oauth2/advertiser/get/', '"Access-Token": accessToken', 'tiktok_advertiser_authorization_lookup_failed',
  'tiktok_authorized_advertiser_not_proven', '!advertiserIds.includes(expectedAdvertiser)', 'authorization_persisted: false',
  'SHOPIFY_TOKENS_KV.put(TOKEN_KEY', 'selectedAdvertiser',
]) assert.ok(finalTikTokSource.includes(fragment), `Missing final TikTok OAuth proof guard: ${fragment}`);
assert.ok(finalTikTokSource.indexOf('/oauth2/advertiser/get/') < finalTikTokSource.indexOf('SHOPIFY_TOKENS_KV.put(TOKEN_KEY'), "Authorized advertiser retrieval must happen before token persistence");
assert.ok(finalTikTokSource.indexOf('!advertiserIds.includes(expectedAdvertiser)') < finalTikTokSource.indexOf('SHOPIFY_TOKENS_KV.put(TOKEN_KEY'), "Advertiser proof must happen before token persistence");

for (const fragment of [
  'extends DurableObject', 'this.ctx.storage.transaction', 'EXECUTION_CLAIM_LEASE_MS', 'lease_expires_at',
  'plan_execution_lease_expired_reconciliation_required', 'recovery_instruction', 'plan_already_executing',
  'plan_already_completed', 'reconciliation_required', 'execution_claim_mismatch',
]) assert.ok(coordinatorSource.includes(fragment), `Missing atomic plan coordinator behavior: ${fragment}`);

for (const fragment of [
  'handleMareBusinessMcpFinalRequest', 'handleTikTokOAuthFinalCallbackRequest', 'export { MarePlanCoordinator }',
  '"write_inventory"', '"write_files"', '"write_discounts"', '"write_content"', '"write_metaobjects"', '"write_translations"', '"write_publications"',
]) assert.ok(workerSource.includes(fragment), `Missing final Worker route or Shopify scope: ${fragment}`);

for (const fragment of [
  'name = "MARE_PLAN_COORDINATOR"', 'class_name = "MarePlanCoordinator"', 'new_sqlite_classes = ["MarePlanCoordinator"]',
]) assert.ok(wranglerSource.includes(fragment), `Missing Durable Object binding or migration: ${fragment}`);

assert.equal(workerSource.includes('handleTikTokOAuthRequest(request'), false, "Insecure public TikTok OAuth start handler must not be routed");
assert.equal(workerSource.includes('"write_themes"'), false, "Theme writes must remain GitHub/PR-based, not direct Shopify writes");
assert.equal(finalMcpSource.includes('MATRIXIFY_ALLOWED_OPERATIONS = new Set(["MERGE", "UPDATE"])'), true, "Matrixify must not emit destructive DELETE commands");

console.log(JSON.stringify({
  ok: true,
  contract: "mare_business_os_unified_final",
  stable_tools: stableTools.length,
  dynamic_capabilities: true,
  immutable_plan_before_write: true,
  all_write_plans_atomic: true,
  preclaim_validation: true,
  failed_live_plan_replay_blocked: true,
  execution_claim_lease_recovery: true,
  secure_tiktok_oauth_start: true,
  tiktok_live_callback_alias: true,
  tiktok_authorized_advertiser_lookup_before_persist: true,
  tiktok_advertiser_positive_proof_before_persist: true,
  nested_request_safety_preserved: true,
  global_request_size_guard: true,
  full_feed_truncation_blocked: true,
  matrixify_delete_blocked: true,
  complete_variant_pagination: true,
  regular_and_sale_price_mapping: true,
  direct_delete_exposed: false,
  dedicated_access_token: true,
}));
