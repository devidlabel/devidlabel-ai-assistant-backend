import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

// This source-contract test intentionally keeps the Workspace-facing tool set frozen.
const mcpSource = readFileSync("src/mare-business-mcp.ts", "utf8");
const capabilitiesSource = readFileSync("src/mare-business-capabilities.ts", "utf8");
const shopifySource = readFileSync("src/mare-business-shopify.ts", "utf8");
const marketplaceSource = readFileSync("src/mare-business-marketplace.ts", "utf8");
const tiktokSource = readFileSync("src/mare-business-tiktok.ts", "utf8");
const workerSource = readFileSync("src/worker-v3.ts", "utf8");

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
for (const tool of stableTools) {
  assert.ok(mcpSource.includes(`name: "${tool}"`), `Missing stable Business OS tool ${tool}`);
}
assert.equal((mcpSource.match(/name: "mare_[a-z0-9_]+"/g) || []).length, 10, "MARE Business OS must expose exactly ten stable tools");

for (const fragment of [
  'MARE_BUSINESS_ACCESS_TOKEN',
  'immutable_plan_before_external_write: true',
  'EXECUTE MARE PLAN',
  'EXECUTE MARE LIVE PLAN',
  'credentials_or_customer_contact_data_not_accepted',
  'direct_delete_capability_exposed: false',
  'handleMareMcpRequest',
  'handleMareOperationsMcpRequest',
  'handleMareProductMediaMcpRequest',
]) assert.ok(mcpSource.includes(fragment), `Missing Business OS safeguard or internal adapter: ${fragment}`);

for (const forbidden of [
  'normalize(env.MARE_OPS_ACCESS_TOKEN) ||',
  'normalize(env.MARE_MCP_ACCESS_TOKEN) ||',
  'normalize(env.MARE_PRODUCT_MEDIA_ACCESS_TOKEN) ||',
  'DELETE MARE',
]) assert.equal(mcpSource.includes(forbidden), false, `Forbidden Business OS auth fallback or delete exposed: ${forbidden}`);

for (const capability of [
  "shopify.catalog.read",
  "shopify.catalog.export",
  "shopify.media.preview",
  "shopify.media.publish",
  "marketplace.feed.generate",
  "matrixify.catalog.generate",
  "tiktok.authorization.status",
  "tiktok.campaign.read",
  "tiktok.campaign.create",
  "tiktok.campaign.update",
  "google_merchant.products.sync",
  "amazon.listings.sync",
  "ai.claude.review",
  "ai.gemini.review",
]) assert.ok(capabilitiesSource.includes(`id: "${capability}"`), `Missing dynamic capability ${capability}`);

for (const fragment of [
  "inventoryLevels(first: 20)",
  "unitCost { amount currencyCode }",
  "compareAtPrice",
  "collections(first: 50)",
  "media(first: 100)",
  "shopify_catalog_json",
  "shopify_catalog_csv",
]) assert.ok(shopifySource.includes(fragment), `Missing canonical Shopify catalog field or artifact: ${fragment}`);

for (const fragment of [
  '"google_merchant"',
  '"meta_catalog"',
  '"tiktok_catalog"',
  '"amazon_json_listings"',
  '"spartoo_csv"',
  '"miinto_csv"',
  'direct_external_push_performed: false',
  'matrixify_catalog_csv',
]) assert.ok(marketplaceSource.includes(fragment), `Missing marketplace/feed foundation: ${fragment}`);

for (const fragment of [
  '/oauth2/access_token/',
  'app_id: appId, secret, auth_code: authCode',
  '/campaign/get/',
  '/campaign/create/',
  '/campaign/update/',
  '/campaign/status/update/',
  'operation_status = "DISABLE"',
  'ENABLE TIKTOK CAMPAIGN',
  'raw_secret_values_exposed: false',
]) assert.ok(tiktokSource.includes(fragment), `Missing TikTok Marketing API contract: ${fragment}`);

for (const fragment of [
  'handleMareBusinessMcpRequest',
  'handleTikTokOAuthRequest',
  '"write_inventory"',
  '"write_files"',
  '"write_discounts"',
  '"write_content"',
  '"write_metaobjects"',
  '"write_translations"',
  '"write_publications"',
]) assert.ok(workerSource.includes(fragment), `Missing Worker route or Shopify scope: ${fragment}`);

assert.equal(workerSource.includes('"write_themes"'), false, "Theme writes must remain GitHub/PR-based, not direct Shopify writes");

console.log(JSON.stringify({
  ok: true,
  contract: "mare_business_os_unified_foundation",
  stable_tools: stableTools.length,
  dynamic_capabilities: true,
  immutable_plan_before_write: true,
  marketplace_feed_foundation: true,
  tiktok_marketing_api_foundation: true,
  direct_delete_exposed: false,
  dedicated_access_token: true,
}));
