import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = readFileSync("src/mare-operations-mcp.ts", "utf8");
const permissionsSource = readFileSync("src/mare-operations-permissions.ts", "utf8");
const policySource = readFileSync("src/mare-autonomy-policy.ts", "utf8");
const runnerSource = readFileSync("src/mare-autonomy-runner.ts", "utf8");
const metaSource = readFileSync("src/mare-operations-meta.ts", "utf8");
const githubSource = readFileSync("src/mare-operations-github.ts", "utf8");
const googleSource = readFileSync("src/mare-operations-google-ads.ts", "utf8");
const klaviyoUpdateSource = readFileSync("src/mare-operations-klaviyo-update.ts", "utf8");

for (const fragment of [
  'name: "mare_operations_health"',
  'name: "mare_permissions_audit"',
  'name: "mare_operations_preview"',
  'name: "mare_klaviyo_create_campaign_draft"',
  'name: "mare_klaviyo_update_campaign_draft"',
  'name: "mare_meta_mutate"',
  'name: "mare_google_ads_update_campaign"',
  'name: "mare_github_create_pull_request"',
  'controlled_execution_with_explicit_approval',
  'irreversible_actions_enabled: false',
]) assert.ok(source.includes(fragment), `Missing Operations contract fragment: ${fragment}`);

for (const fragment of [
  'risk_tiered_autonomy',
  'reversible_safe_writes_mode: "AUTO+LOG"',
  'live_writes_require_confirmation: true',
  'MARE_AUTO_LOG_CAPABILITIES',
  'policy_source: "mare-autonomy-policy"',
  'compareDigest compare-and-set',
  'aggregate list and segment audience read',
  'aggregate email-marketing consent read',
  'campaign create paused',
  'marketing_api_bridge_configured',
  'required_upstream_permissions: ["ads_read", "ads_management"]',
  'required_account_role: "STANDARD or higher for mutations"',
]) assert.ok(permissionsSource.includes(fragment), `Missing permissions audit fragment: ${fragment}`);

for (const capability of [
  "klaviyo.campaign.draft.create",
  "klaviyo.campaign.draft.update",
  "github.pull_request.create",
  "shopify.metafields.update_existing",
]) assert.ok(policySource.includes(`"${capability}"`), `Missing shared AUTO+LOG capability: ${capability}`);
assert.ok(policySource.includes('MARE_AUTONOMY_POLICY_VERSION = "p3"'));
assert.ok(runnerSource.includes('from "./mare-autonomy-policy.js"'));
assert.ok(runnerSource.includes('enum: [...MARE_AUTO_LOG_CAPABILITIES]'));
assert.equal(runnerSource.includes("const AUTO_CAPABILITIES = new Set"), false, "Runner must not own a duplicate autonomy allowlist");

for (const [text, fragment] of [
  [metaSource, 'ACTIVATE META ADS'],
  [metaSource, 'delete_exposed: false'],
  [githubSource, 'CREATE GITHUB PR'],
  [githubSource, '.github/workflows/'],
  [googleSource, 'ENABLE GOOGLE ADS CAMPAIGN'],
  [googleSource, 'CHANGE GOOGLE ADS BUDGET'],
  [klaviyoUpdateSource, 'UPDATE KLAVIYO DRAFT'],
  [klaviyoUpdateSource, 'klaviyo_campaign_is_not_draft'],
]) assert.ok(text.includes(fragment), `Missing execution guard: ${fragment}`);

for (const forbidden of [
  "/api/campaign-send-jobs",
  "/api/flow-actions",
  "mergePullRequest",
  "campaigns:remove",
]) {
  assert.equal(
    [source, metaSource, githubSource, googleSource, klaviyoUpdateSource].some((text) => text.includes(forbidden)),
    false,
    `Forbidden capability exposed: ${forbidden}`,
  );
}

const out = mkdtempSync(join(tmpdir(), "mare-operations-mcp-"));
execFileSync("npx", [
  "tsc",
  "--outDir", out,
  "--noEmit", "false",
  "--module", "ESNext",
  "--target", "ES2022",
  "--moduleResolution", "Bundler",
  "--lib", "ES2022,WebWorker",
  "src/mare-operations-mcp.ts",
], { stdio: "inherit" });

const { handleMareOperationsMcpRequest } = await import(`file://${join(out, "mare-operations-mcp.js")}`);

const endpoint = "https://worker.test/mcp-operations";
const env = {
  MARE_OPS_ACCESS_TOKEN: "ops-secret",
  KLAVIYO_PRIVATE_API_KEY: "klaviyo-read-secret",
  KLAVIYO_OPERATIONS_API_KEY: "klaviyo-write-secret",
  KLAVIYO_DEFAULT_FROM_EMAIL: "operations@example.test",
  KLAVIYO_DEFAULT_FROM_LABEL: "MARE Test",
  KLAVIYO_DEFAULT_REPLY_TO_EMAIL: "reply@example.test",
  META_ADS_ACCESS_TOKEN: "meta-upstream",
  META_AD_ACCOUNT_ID: "843613162004896",
  META_REPORT_ACCESS_TOKEN: "meta-read",
  META_WRITE_ACCESS_TOKEN: "meta-write",
  GOOGLE_ADS_CLIENT_ID: "google-client",
  GOOGLE_ADS_CLIENT_SECRET: "google-secret",
  GOOGLE_ADS_REFRESH_TOKEN: "google-refresh",
  GOOGLE_ADS_DEVELOPER_TOKEN: "google-developer",
  GOOGLE_ADS_CUSTOMER_ID: "9429975153",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "3414479537",
  GOOGLE_ADS_API_VERSION: "v25",
  GA4_PROPERTY_ID: "345407658",
  SEARCH_CONSOLE_SITE_URL: "sc-domain:devidlabel.com",
  GITHUB_OPERATIONS_TOKEN: "github-token",
  GITHUB_OPERATIONS_REPOSITORIES: "devidlabel/devidlabel-ai-assistant-backend,devidlabel/devidlabel-shopify-theme",
  TIKTOK_ACCESS_TOKEN: "tiktok-access",
  TIKTOK_ADVERTISER_ID: "123456789",
};

function rpc(method, params = {}, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function request(body, token = "", headers = {}) {
  return new Request(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body,
  });
}

const health = await handleMareOperationsMcpRequest(new Request(`${endpoint}/health`), env);
assert.equal(health?.status, 200);
const healthBody = await health.json();
assert.equal(healthBody.version, "0.3.0");
assert.equal(healthBody.external_writes_enabled, true);
assert.equal(healthBody.irreversible_actions_enabled, false);
assert.equal(healthBody.tools, 8);
assert.equal(JSON.stringify(healthBody).includes("ops-secret"), false);

const listed = await handleMareOperationsMcpRequest(request(rpc("tools/list")), env);
const listedBody = await listed.json();
assert.deepEqual(listedBody.result.tools.map((tool) => tool.name), [
  "mare_operations_health",
  "mare_permissions_audit",
  "mare_operations_preview",
  "mare_klaviyo_create_campaign_draft",
  "mare_klaviyo_update_campaign_draft",
  "mare_meta_mutate",
  "mare_google_ads_update_campaign",
  "mare_github_create_pull_request",
]);
assert.equal(listedBody.result.tools.filter((tool) => tool.annotations.readOnlyHint === false).length, 5);

const denied = await handleMareOperationsMcpRequest(
  request(rpc("tools/call", { name: "mare_permissions_audit", arguments: {} })),
  env,
);
assert.equal(denied?.status, 401);

const auditResponse = await handleMareOperationsMcpRequest(
  request(rpc("tools/call", { name: "mare_permissions_audit", arguments: {} }), "ops-secret"),
  env,
);
const auditBody = await auditResponse.json();
assert.equal(auditBody.result.isError, false);
const audit = auditBody.result.structuredContent;
assert.equal(audit.policy.model, "risk_tiered_autonomy");
assert.equal(audit.policy.policy_version, "p3");
assert.equal(audit.policy.policy_source, "mare-autonomy-policy");
assert.equal(audit.policy.reversible_safe_writes_require_confirmation, false);
assert.equal(audit.policy.reversible_safe_writes_mode, "AUTO+LOG");
assert.equal(audit.policy.live_writes_require_confirmation, true);
assert.equal(audit.policy.autonomous_execution_persists_beyond_chat_session, true);
assert.deepEqual(audit.policy.autonomous_capabilities, [
  "klaviyo.campaign.draft.create",
  "klaviyo.campaign.draft.update",
  "github.pull_request.create",
  "shopify.metafields.update_existing",
]);
assert.equal(audit.providers.shopify.autonomy_mode, "AUTO+LOG for existing custom Product/ProductVariant metafields only");
assert.equal(audit.providers.shopify.safety_controls.includes("compareDigest compare-and-set"), true);
assert.equal(audit.providers.klaviyo.aggregate_crm_reads_configured, true);
assert.equal(audit.providers.klaviyo.implemented_operations.includes("aggregate list and segment audience read"), true);
assert.equal(audit.providers.klaviyo.implemented_operations.includes("aggregate email-marketing consent read"), true);
assert.equal(audit.providers.klaviyo.read_data_policy, "aggregate CRM reads return no individual contact data");
assert.equal(audit.providers.tiktok_ads.configured, true);
assert.equal(audit.providers.tiktok_ads.status, "marketing_api_bridge_configured");
assert.equal(audit.providers.tiktok_ads.implemented_operations.includes("campaign create paused"), true);
assert.equal(audit.providers.github.configured, true);
assert.equal(JSON.stringify(auditBody).includes("github-token"), false);
assert.equal(JSON.stringify(auditBody).includes("klaviyo-read-secret"), false);
assert.equal(JSON.stringify(auditBody).includes("tiktok-access"), false);

const previewResponse = await handleMareOperationsMcpRequest(
  request(rpc("tools/call", {
    name: "mare_operations_preview",
    arguments: {
      operation: "meta_ads_mutation",
      dry_run: true,
      objective: "Prepare a paused Meta campaign",
      target: "Meta campaign",
      changes: ["Create campaign paused"],
    },
  }), "ops-secret"),
  env,
);
const previewBody = await previewResponse.json();
assert.equal(previewBody.result.structuredContent.status, "preview_only");
assert.equal(previewBody.result.structuredContent.safety.external_write_performed, false);
assert.equal(previewBody.result.structuredContent.safety.execution_available, true);

const metaMissingConfirm = await handleMareOperationsMcpRequest(
  request(rpc("tools/call", {
    name: "mare_meta_mutate",
    arguments: {
      approval_confirmation: "wrong",
      idempotency_key: "meta-test-001",
      action: "campaign_create",
      payload: { name: "Test", objective: "OUTCOME_SALES", status: "PAUSED" },
    },
  }), "ops-secret"),
  env,
);
const metaMissingConfirmBody = await metaMissingConfirm.json();
assert.equal(metaMissingConfirmBody.result.isError, true);
assert.match(metaMissingConfirmBody.result.content[0].text, /meta_execution_confirmation_required/);

const googleMissingBudgetConfirm = await handleMareOperationsMcpRequest(
  request(rpc("tools/call", {
    name: "mare_google_ads_update_campaign",
    arguments: {
      approval_confirmation: "EXECUTE GOOGLE ADS CHANGE",
      campaign_id: "123456789",
      daily_budget_eur: 25,
    },
  }), "ops-secret"),
  env,
);
const googleMissingBudgetConfirmBody = await googleMissingBudgetConfirm.json();
assert.equal(googleMissingBudgetConfirmBody.result.isError, true);
assert.match(googleMissingBudgetConfirmBody.result.content[0].text, /google_ads_budget_confirmation_required/);

const githubUnsafePath = await handleMareOperationsMcpRequest(
  request(rpc("tools/call", {
    name: "mare_github_create_pull_request",
    arguments: {
      approval_confirmation: "CREATE GITHUB PR",
      repository: "devidlabel/devidlabel-ai-assistant-backend",
      base_branch: "main",
      branch_name: "mare/test-safe-pr",
      commit_message: "Test safety",
      pr_title: "Test safety",
      files: [{ path: ".github/workflows/unsafe.yml", content: "name: unsafe" }],
    },
  }), "ops-secret"),
  env,
);
const githubUnsafePathBody = await githubUnsafePath.json();
assert.equal(githubUnsafePathBody.result.isError, true);
assert.match(githubUnsafePathBody.result.content[0].text, /unsafe_github_path/);

const klaviyoMissingConfirm = await handleMareOperationsMcpRequest(
  request(rpc("tools/call", {
    name: "mare_klaviyo_update_campaign_draft",
    arguments: {
      approval_confirmation: "wrong",
      campaign_id: "campaign123",
      campaign_name: "Updated draft",
    },
  }), "ops-secret"),
  env,
);
const klaviyoMissingConfirmBody = await klaviyoMissingConfirm.json();
assert.equal(klaviyoMissingConfirmBody.result.isError, true);
assert.match(klaviyoMissingConfirmBody.result.content[0].text, /klaviyo_update_confirmation_required/);

const wrongOrigin = await handleMareOperationsMcpRequest(
  request(rpc("ping"), "", { Origin: "https://example.com" }),
  env,
);
assert.equal(wrongOrigin?.status, 403);

console.log(JSON.stringify({
  ok: true,
  contract: "mare_operations_os_execution_core",
  tools: 8,
  controlled_write_tools: 5,
  exact_confirmations_required_for_direct_live_execution: true,
  reversible_safe_autonomy_mode: "AUTO+LOG",
  shared_autonomy_policy: true,
  autonomous_capabilities: 4,
  provider_audit_current: true,
  external_writes_enabled: true,
  irreversible_actions_enabled: false,
  secret_values_exposed: false,
}));
