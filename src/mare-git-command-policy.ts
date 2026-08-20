export const MARE_GIT_COMMAND_SCHEMA_VERSION = 1 as const;
export const MARE_GIT_COMMAND_REPOSITORY = "devidlabel/devidlabel-ai-assistant-backend" as const;
export const MARE_GIT_COMMAND_WORKFLOW_PATH = ".github/workflows/autonomy-command.yml" as const;
export const MARE_GIT_COMMAND_PREFIX = "ops/autonomy/commands/" as const;
export const MARE_GIT_RECEIPT_PREFIX = "ops/autonomy/receipts/" as const;

// Commands are committed to a public repository. Only capabilities whose entire
// request schema is safe to expose publicly belong here. Klaviyo drafts and
// generic metafield values are intentionally excluded.
export const MARE_GIT_COMMAND_CAPABILITIES = [
  "shopify.product.season.assign_missing",
] as const;

export type MareGitCommandCapability = typeof MARE_GIT_COMMAND_CAPABILITIES[number];

const CAPABILITY_SET = new Set<string>(MARE_GIT_COMMAND_CAPABILITIES);

export function isMareGitCommandCapability(value: string): value is MareGitCommandCapability {
  return CAPABILITY_SET.has(value);
}
