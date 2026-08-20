export const MARE_AUTONOMY_POLICY_VERSION = "p3" as const;

export const MARE_AUTO_LOG_CAPABILITIES = [
  "klaviyo.campaign.draft.create",
  "klaviyo.campaign.draft.update",
  "github.pull_request.create",
  "shopify.metafields.update_existing",
] as const;

export type MareAutoLogCapability = typeof MARE_AUTO_LOG_CAPABILITIES[number];

export const MARE_APPROVAL_REQUIRED_ACTIONS = [
  "send or schedule Klaviyo campaigns",
  "activate or materially increase paid-media spend",
  "publish live product-media replacements",
  "create or delete Shopify metafields",
  "merge pull requests",
  "bulk destructive writes",
  "delete or irreversible provider actions",
] as const;

export const MARE_SHOPIFY_METAFIELD_GUARDRAILS = {
  existing_metafields_only: true,
  namespace_allowlist: ["custom"],
  owner_type_allowlist: ["Product", "ProductVariant"],
  maximum_items_per_atomic_write: 25,
  compare_and_set: true,
  read_before_write: true,
  read_after_write: true,
  create_allowed: false,
  delete_allowed: false,
} as const;

export const MARE_AUTONOMY_GUARANTEES = {
  durable_execution: true,
  bounded_retries: true,
  immutable_provider_plan: true,
  coordinated_plan_ledger: true,
  provider_idempotency_reused_when_supported: true,
  external_write_on_submit: false,
} as const;

const AUTO_LOG_SET = new Set<string>(MARE_AUTO_LOG_CAPABILITIES);

export function isMareAutoLogCapability(capabilityId: string): capabilityId is MareAutoLogCapability {
  return AUTO_LOG_SET.has(capabilityId);
}

export function buildMareAutonomyPolicy() {
  return {
    ok: true,
    version: MARE_AUTONOMY_POLICY_VERSION,
    model: "risk_tiered_autonomy",
    autonomous_mode: "AUTO+LOG",
    autonomous_capabilities: [...MARE_AUTO_LOG_CAPABILITIES],
    approval_required: [...MARE_APPROVAL_REQUIRED_ACTIONS],
    shopify_guardrails: {
      ...MARE_SHOPIFY_METAFIELD_GUARDRAILS,
      namespace_allowlist: [...MARE_SHOPIFY_METAFIELD_GUARDRAILS.namespace_allowlist],
      owner_type_allowlist: [...MARE_SHOPIFY_METAFIELD_GUARDRAILS.owner_type_allowlist],
    },
    guarantees: { ...MARE_AUTONOMY_GUARANTEES },
  };
}
