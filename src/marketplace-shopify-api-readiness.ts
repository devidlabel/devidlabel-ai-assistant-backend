import {shopifyGraphQLWithMetadata, type Env as ShopifyEnv} from "./index.js";
import {DEFAULT_SHOPIFY_API_VERSION} from "./shopify-app-config.js";

export const MARKETPLACE_SHOPIFY_SUPPORTED_API_VERSION = DEFAULT_SHOPIFY_API_VERSION;
export const SHOPIFY_API_READINESS_QUERY =
  "query MareMarketplaceShopifyApiReadiness { currentAppInstallation { id } }";

// Verified against the official 2026-01 schema and version schedule on
// 2026-10-18. Matching a retired pin must not become positive readiness.
// https://shopify.dev/docs/api/usage/versioning
// https://shopify.dev/docs/api/admin-graphql/2026-01/objects/AppInstallation
const VERIFIED_SUPPORT = {
  api_version: "2026-01",
  released_at: "2026-01-01T17:00:00.000Z",
  accessible_until: "2027-01-16T15:00:00.000Z",
  verified_as_of: "2026-10-18",
} as const;
const SHOP_RE = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;
const VERSION_RE = /^20\d{2}-(01|04|07|10)$/;
const INSTALLATION_RE = /^gid:\/\/shopify\/AppInstallation\/[1-9]\d{0,30}$/;
type Row = Record<string, unknown>;
type Reader = typeof shopifyGraphQLWithMetadata;

function isRow(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION_RE.test(value);
}

/**
 * Observe the actual Admin API version through the existing M.A.R.E. client.
 * No caller-supplied query, installation ID, credential or response snapshot.
 * The installation ID is checked internally and never included in the report.
 * A successful observation does not authorize any marketplace operation.
 */
export async function readMarketplaceShopifyApiReadiness(
  env: ShopifyEnv,
  reader: Reader = shopifyGraphQLWithMetadata,
): Promise<Row> {
  if (!isRow(env)) throw new Error("marketplace_shopify_api_config_invalid");
  const shop = typeof env.SHOPIFY_SHOP_DOMAIN === "string"
    ? env.SHOPIFY_SHOP_DOMAIN.trim().toLowerCase()
      .replace(/^https?:\/\//, "").replace(/\/+$/, "") : "";
  const configuredVersion = env.SHOPIFY_API_VERSION || DEFAULT_SHOPIFY_API_VERSION;
  if (!SHOP_RE.test(shop) || !isVersion(configuredVersion))
    throw new Error("marketplace_shopify_api_config_invalid");

  let result: unknown;
  try {
    result = await reader<{currentAppInstallation?: unknown}>(env, SHOPIFY_API_READINESS_QUERY, {});
  } catch {
    // The shared client can receive arbitrary upstream error text. Do not
    // return provider bodies, token-store values or transport exception text.
    throw new Error("marketplace_shopify_api_probe_failed");
  }
  if (!isRow(result) || !isVersion(result.requested_api_version) ||
      result.requested_api_version !== configuredVersion ||
      !Object.hasOwn(result, "served_api_version"))
    throw new Error("marketplace_shopify_api_metadata_invalid");
  const data = result.data;
  const installation = isRow(data) ? data.currentAppInstallation : null;
  if (!isRow(installation) || typeof installation.id !== "string" ||
      !INSTALLATION_RE.test(installation.id))
    throw new Error("marketplace_shopify_api_response_invalid");

  const rawVersion = result.served_api_version;
  const missingHeader = rawVersion === null || rawVersion === "";
  const servedVersion = isVersion(rawVersion) ? rawVersion : null;
  const headerStatus = missingHeader ? "MISSING" : servedVersion === null ? "INVALID" : "VALID";
  const matchesRequest = servedVersion !== null && servedVersion === configuredVersion;
  const matchesPin = configuredVersion === MARKETPLACE_SHOPIFY_SUPPORTED_API_VERSION;
  const observedAt = Date.now();
  const supportCurrent = MARKETPLACE_SHOPIFY_SUPPORTED_API_VERSION === VERIFIED_SUPPORT.api_version &&
    observedAt >= Date.parse(VERIFIED_SUPPORT.released_at) &&
    observedAt < Date.parse(VERIFIED_SUPPORT.accessible_until);
  const blockers: string[] = [];
  if (!matchesPin) blockers.push("shopify_api_version_not_selected_pin");
  if (headerStatus === "MISSING") blockers.push("shopify_api_version_header_missing");
  if (headerStatus === "INVALID") blockers.push("shopify_api_version_header_invalid");
  if (servedVersion !== null && !matchesRequest) blockers.push("shopify_api_version_mismatch");
  if (!supportCurrent) blockers.push("shopify_api_version_support_window_unverified");

  const status = headerStatus === "MISSING" ? "API_VERSION_HEADER_MISSING" :
    headerStatus === "INVALID" ? "API_VERSION_HEADER_INVALID" :
    !matchesRequest ? "API_VERSION_MISMATCH" :
    !matchesPin ? "API_VERSION_PIN_MISMATCH" :
    !supportCurrent ? "API_VERSION_SUPPORT_WINDOW_UNVERIFIED" :
    "API_VERSION_VERIFIED_EXECUTION_STILL_LOCKED";
  return {
    ok: true,
    source: "shopify_admin_graphql_response_version",
    read_only: true,
    observed_at: new Date(observedAt).toISOString(),
    requested_api_version: configuredVersion,
    served_api_version: servedVersion,
    selected_api_version: MARKETPLACE_SHOPIFY_SUPPORTED_API_VERSION,
    version_header_status: headerStatus,
    api_version_matches_request: matchesRequest,
    configured_version_matches_pin: matchesPin,
    support_verified_as_of: VERIFIED_SUPPORT.verified_as_of,
    support_expires_at: VERIFIED_SUPPORT.accessible_until,
    selected_pin_support_current: supportCurrent,
    api_version_alignment_verified: blockers.length === 0,
    blockers,
    status,
    customer_data_returned: false,
    credential_returned: false,
    provider_mutations: 0,
    can_import_orders: false,
    can_update_tracking: false,
    can_change_inventory: false,
    can_publish_offers: false,
    ready_for_marketplace_writes: false,
    next_step: blockers.length > 0 ? "RESOLVE_SHOPIFY_API_VERSION_BLOCKERS" :
      "VERIFY_CURRENT_APP_SCOPES_AND_WORKFLOW_OWNERSHIP_BEFORE_ANY_WRITE",
  };
}
