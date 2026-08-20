type JsonObject = Record<string, unknown>;

export type OperationsPermissionsEnv = {
  SHOPIFY_SHOP_DOMAIN?: string;
  SHOPIFY_ADMIN_ACCESS_TOKEN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_TOKENS_KV?: unknown;
  KLAVIYO_PRIVATE_API_KEY?: string;
  KLAVIYO_OPERATIONS_API_KEY?: string;
  META_ADS_ACCESS_TOKEN?: string;
  META_AD_ACCOUNT_ID?: string;
  META_REPORT_ACCESS_TOKEN?: string;
  META_WRITE_ACCESS_TOKEN?: string;
  GOOGLE_ADS_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
  GOOGLE_ADS_REFRESH_TOKEN?: string;
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  GOOGLE_ADS_CUSTOMER_ID?: string;
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;
  GOOGLE_ADS_REPORT_ACCESS_TOKEN?: string;
  GOOGLE_ORGANIC_REPORT_ACCESS_TOKEN?: string;
  GA4_PROPERTY_ID?: string;
  SEARCH_CONSOLE_SITE_URL?: string;
  GITHUB_OPERATIONS_TOKEN?: string;
  GITHUB_OPERATIONS_REPOSITORIES?: string;
  TIKTOK_ACCESS_TOKEN?: string;
  TIKTOK_ADVERTISER_ID?: string;
  [key: string]: unknown;
};

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bool(value: unknown): boolean {
  return Boolean(normalize(value));
}

function githubRepositories(env: OperationsPermissionsEnv): string[] {
  return normalize(env.GITHUB_OPERATIONS_REPOSITORIES)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item));
}

export function buildOperationsPermissionsAudit(env: OperationsPermissionsEnv): JsonObject {
  const shopifyOauthConfigured = bool(env.SHOPIFY_CLIENT_ID) && bool(env.SHOPIFY_CLIENT_SECRET);
  const shopifyAdminConfigured = bool(env.SHOPIFY_ADMIN_ACCESS_TOKEN) || Boolean(env.SHOPIFY_TOKENS_KV);
  const googleCredentialMode = bool(env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON)
    ? "service_account"
    : bool(env.GOOGLE_ADS_CLIENT_ID) && bool(env.GOOGLE_ADS_CLIENT_SECRET) && bool(env.GOOGLE_ADS_REFRESH_TOKEN)
      ? "user_oauth"
      : "unconfigured";
  const allowedGithubRepos = githubRepositories(env);

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    policy: {
      model: "risk_tiered_autonomy",
      reads_require_confirmation: false,
      reversible_safe_writes_require_confirmation: false,
      reversible_safe_writes_mode: "AUTO+LOG",
      live_writes_require_confirmation: true,
      irreversible_actions_require_separate_confirmation: true,
      autonomous_capabilities_p1: [
        "klaviyo.campaign.draft.create",
        "klaviyo.campaign.draft.update",
        "github.pull_request.create",
        "shopify.metafields.update_existing",
      ],
      autonomous_execution_persists_beyond_chat_session: true,
      raw_secret_values_exposed: false,
    },
    providers: {
      shopify: {
        configured: bool(env.SHOPIFY_SHOP_DOMAIN) && shopifyAdminConfigured,
        credential_mode: Boolean(env.SHOPIFY_TOKENS_KV) ? "oauth_kv" : bool(env.SHOPIFY_ADMIN_ACCESS_TOKEN) ? "legacy_admin_token" : shopifyOauthConfigured ? "oauth_not_installed_or_unverified" : "unconfigured",
        declared_read_scope_family: [
          "orders", "products", "inventory", "reports", "returns", "content", "translations",
        ],
        declared_write_scope_family: ["products/metafields through installed Shopify OAuth scopes"],
        implemented_operations: ["reporting", "order lookup", "product recommendation", "update existing custom product/variant metafields"],
        exposed_write_tools: ["shopify.metafields.update_existing via mare_autonomy_submit"],
        autonomy_mode: "AUTO+LOG for existing custom Product/ProductVariant metafields only",
        safety_controls: [
          "maximum 25 metafields per atomic mutation",
          "existing metafields only",
          "namespace custom only",
          "Product and ProductVariant owners only",
          "read-before-write",
          "compareDigest compare-and-set",
          "read-after-write",
          "create/delete disabled",
        ],
        approval_required_for: ["create metafield", "delete metafield", "generic product mutation", "inventory mutation", "publication/content mutation"],
        verification_level: "bounded_write_with_provider_readback",
        missing_for_operations: [],
      },
      klaviyo: {
        reporting_configured: bool(env.KLAVIYO_PRIVATE_API_KEY),
        operations_configured: bool(env.KLAVIYO_OPERATIONS_API_KEY),
        required_operations_scopes: ["campaigns:read", "campaigns:write"],
        implemented_operations: ["create campaign draft", "update campaign draft"],
        autonomy_mode: "AUTO+LOG for draft create/update through mare_autonomy_submit",
        approval_required_for: ["send campaign", "schedule campaign", "activate flow", "modify profiles", "modify consent"],
        blocked_operations: ["send campaign", "schedule campaign", "activate flow", "modify profiles", "modify consent"],
        verification_level: "credential_presence_only_write_scope_verified_on_first_safe_call",
      },
      meta: {
        configured: bool(env.META_ADS_ACCESS_TOKEN) && bool(env.META_AD_ACCOUNT_ID),
        internal_read_guard_configured: bool(env.META_REPORT_ACCESS_TOKEN),
        internal_write_guard_configured: bool(env.META_WRITE_ACCESS_TOKEN),
        required_upstream_permissions: ["ads_read", "ads_management"],
        implemented_operations: ["create/update campaign", "create/update ad set", "create/update ad"],
        autonomy_mode: "approval_required_for_live_write",
        execution_defaults: ["new entities default PAUSED", "ACTIVE requires separate confirmation"],
        verification_level: "backend_capability_and_secret_presence_only",
      },
      google_ads: {
        configured: googleCredentialMode !== "unconfigured" && bool(env.GOOGLE_ADS_DEVELOPER_TOKEN) && bool(env.GOOGLE_ADS_CUSTOMER_ID),
        credential_mode: googleCredentialMode,
        manager_account_configured: bool(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
        internal_read_guard_configured: bool(env.GOOGLE_ADS_REPORT_ACCESS_TOKEN),
        oauth_scope: "https://www.googleapis.com/auth/adwords",
        required_account_role: "STANDARD or higher for mutations",
        implemented_operations: ["reporting", "update campaign name/status", "update campaign daily budget"],
        autonomy_mode: "approval_required_for_live_write",
        blocked_operations: ["remove campaign", "bulk arbitrary mutate", "enable without separate confirmation"],
        verification_level: "credential_presence_only_role_verified_on_first_validate-only_or_safe_mutation",
      },
      ga4: {
        configured: bool(env.GA4_PROPERTY_ID) && googleCredentialMode !== "unconfigured",
        scope: "analytics.readonly",
        implemented_operations: ["reporting", "realtime reporting"],
        write_operations_expected: false,
      },
      search_console: {
        configured: bool(env.SEARCH_CONSOLE_SITE_URL) && googleCredentialMode !== "unconfigured",
        scope: "webmasters.readonly",
        implemented_operations: ["reporting"],
        write_operations_expected: false,
      },
      github: {
        configured: bool(env.GITHUB_OPERATIONS_TOKEN) && allowedGithubRepos.length > 0,
        repository_allowlist: allowedGithubRepos,
        required_token_permissions: ["Contents: Read and write", "Pull requests: Read and write", "Metadata: Read"],
        implemented_operations: ["create/reuse branch", "create/update files on branch", "open pull request"],
        autonomy_mode: "AUTO+LOG for draft PR creation through mare_autonomy_submit",
        approval_required_for: ["merge pull request", "push to default branch", "modify workflow files through MARE provider bridge"],
        blocked_operations: ["merge pull request", "delete branch", "push to default branch", "modify workflow files", "write secret files"],
        verification_level: "configuration_and_repository_allowlist_only",
      },
      tiktok_ads: {
        configured: bool(env.TIKTOK_ACCESS_TOKEN) && bool(env.TIKTOK_ADVERTISER_ID),
        implemented_operations: [],
        exposed_write_tools: [],
        autonomy_mode: "approval_required_for_live_write",
        status: bool(env.TIKTOK_ACCESS_TOKEN) && bool(env.TIKTOK_ADVERTISER_ID) ? "credentials_present_but_bridge_not_implemented" : "awaiting_marketing_api_approval_and_credentials",
      },
    },
  };
}
