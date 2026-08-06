import {
  createKlaviyoCampaignDraft,
  klaviyoCampaignDraftConfiguration,
  klaviyoCampaignDraftConfigured,
  type KlaviyoOperationsEnv,
} from "./mare-operations-klaviyo.js";
import {
  klaviyoCampaignUpdateConfiguration,
  updateKlaviyoCampaignDraft,
} from "./mare-operations-klaviyo-update.js";
import {
  executeMetaMutation,
  metaOperationsConfiguration,
  type MetaOperationsEnv,
} from "./mare-operations-meta.js";
import {
  createGitHubPullRequest,
  githubOperationsConfiguration,
  type GitHubOperationsEnv,
} from "./mare-operations-github.js";
import {
  googleAdsOperationsConfiguration,
  updateGoogleAdsCampaign,
  type GoogleAdsOperationsEnv,
} from "./mare-operations-google-ads.js";
import {
  buildOperationsPermissionsAudit,
  type OperationsPermissionsEnv,
} from "./mare-operations-permissions.js";

type JsonObject = Record<string, unknown>;

type MareOperationsEnv = KlaviyoOperationsEnv
  & MetaOperationsEnv
  & GitHubOperationsEnv
  & GoogleAdsOperationsEnv
  & OperationsPermissionsEnv
  & {
    MARE_OPS_ACCESS_TOKEN?: string;
    [key: string]: unknown;
  };

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonObject;
};

type PreviewOperation =
  | "klaviyo_campaign_draft"
  | "klaviyo_campaign_update"
  | "meta_ads_mutation"
  | "google_ads_campaign_update"
  | "github_pull_request"
  | "shopify_operation"
  | "tiktok_ads_operation";

const SERVER_VERSION = "0.3.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const MAX_REQUEST_BYTES = 320 * 1024;
const MAX_TEXT_LENGTH = 4000;
const MAX_CHANGE_ITEMS = 30;

const ALLOWED_ORIGINS = new Set([
  "https://chatgpt.com",
  "https://www.chatgpt.com",
  "https://chat.openai.com",
]);

const PUBLIC_DISCOVERY_METHODS = new Set(["initialize", "ping", "tools/list"]);
const PUBLIC_DISCOVERY_NOTIFICATIONS = new Set(["notifications/initialized", "notifications/cancelled"]);
const PREVIEW_OPERATIONS: readonly PreviewOperation[] = [
  "klaviyo_campaign_draft",
  "klaviyo_campaign_update",
  "meta_ads_mutation",
  "google_ads_campaign_update",
  "github_pull_request",
  "shopify_operation",
  "tiktok_ads_operation",
];

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const CONTROLLED_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const TOOLS = [
  {
    name: "mare_operations_health",
    title: "MARE Operations OS health",
    description: "Checks Operations OS configuration and safety controls without exposing secrets or performing writes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_permissions_audit",
    title: "Audit MARE API permissions",
    description: "Returns a PII-free, secret-free matrix of configured providers, implemented read/write actions, missing permissions, approval policy and blocked operations.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_operations_preview",
    title: "Preview an operational change",
    description: "Builds a dry-run-only execution plan. It never writes to an external system.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: PREVIEW_OPERATIONS },
        dry_run: { type: "boolean", const: true },
        objective: { type: "string", minLength: 3, maxLength: MAX_TEXT_LENGTH },
        target: { type: "string", minLength: 1, maxLength: 500 },
        changes: {
          type: "array",
          minItems: 1,
          maxItems: MAX_CHANGE_ITEMS,
          items: { type: "string", minLength: 1, maxLength: 1000 },
        },
        rollback_plan: { type: "string", maxLength: 2000 },
      },
      required: ["operation", "dry_run", "objective", "target", "changes"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_klaviyo_create_campaign_draft",
    title: "Create a Klaviyo email campaign draft",
    description: "Creates one Klaviyo email campaign in Draft status only. It cannot send or schedule. Requires the exact confirmation CREATE KLAVIYO DRAFT and an idempotency key.",
    inputSchema: {
      type: "object",
      properties: {
        approval_confirmation: { type: "string", const: "CREATE KLAVIYO DRAFT" },
        idempotency_key: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" },
        campaign_name: { type: "string", minLength: 3, maxLength: 180 },
        audience_id: { type: "string", minLength: 3, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" },
        subject: { type: "string", minLength: 1, maxLength: 200 },
        preview_text: { type: "string", maxLength: 300 },
        template_id: { type: "string", minLength: 3, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" },
        use_smart_sending: { type: "boolean", default: true },
      },
      required: ["approval_confirmation", "idempotency_key", "campaign_name", "audience_id", "subject", "preview_text"],
      additionalProperties: false,
    },
    annotations: CONTROLLED_WRITE_ANNOTATIONS,
  },
  {
    name: "mare_klaviyo_update_campaign_draft",
    title: "Update a Klaviyo campaign draft",
    description: "Updates an existing Klaviyo campaign only while it is Draft. Supports name, subject, preview text and template assignment. It cannot send or schedule. Requires the exact confirmation UPDATE KLAVIYO DRAFT.",
    inputSchema: {
      type: "object",
      properties: {
        approval_confirmation: { type: "string", const: "UPDATE KLAVIYO DRAFT" },
        campaign_id: { type: "string", minLength: 3, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" },
        campaign_message_id: { type: "string", minLength: 3, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" },
        campaign_name: { type: "string", minLength: 3, maxLength: 180 },
        subject: { type: "string", maxLength: 200 },
        preview_text: { type: "string", maxLength: 300 },
        template_id: { type: "string", minLength: 3, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" },
      },
      required: ["approval_confirmation", "campaign_id"],
      additionalProperties: false,
    },
    annotations: CONTROLLED_WRITE_ANNOTATIONS,
  },
  {
    name: "mare_meta_mutate",
    title: "Create or update Meta Ads entities",
    description: "Creates or updates Meta campaigns, ad sets and ads. New entities default to PAUSED. Normal writes require EXECUTE META CHANGE; ACTIVE requires ACTIVATE META ADS. Delete is not exposed.",
    inputSchema: {
      type: "object",
      properties: {
        approval_confirmation: { type: "string", enum: ["EXECUTE META CHANGE", "ACTIVATE META ADS"] },
        idempotency_key: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" },
        action: {
          type: "string",
          enum: ["campaign_create", "campaign_update", "adset_create", "adset_update", "ad_create", "ad_update"],
        },
        object_id: { type: "string", pattern: "^\\d{5,40}$" },
        payload: { type: "object", additionalProperties: true },
      },
      required: ["approval_confirmation", "idempotency_key", "action", "payload"],
      additionalProperties: false,
    },
    annotations: CONTROLLED_WRITE_ANNOTATIONS,
  },
  {
    name: "mare_google_ads_update_campaign",
    title: "Update a Google Ads campaign",
    description: "Updates an existing Google Ads campaign name, PAUSED/ENABLED status and daily budget. Enable and budget changes require separate exact confirmations. Remove is not exposed.",
    inputSchema: {
      type: "object",
      properties: {
        approval_confirmation: { type: "string", enum: ["EXECUTE GOOGLE ADS CHANGE", "ENABLE GOOGLE ADS CAMPAIGN"] },
        budget_approval_confirmation: { type: "string", const: "CHANGE GOOGLE ADS BUDGET" },
        campaign_id: { type: "string", pattern: "^\\d{5,30}$" },
        name: { type: "string", minLength: 3, maxLength: 255 },
        status: { type: "string", enum: ["PAUSED", "ENABLED"] },
        daily_budget_eur: { type: "number", exclusiveMinimum: 0, maximum: 100000 },
      },
      required: ["approval_confirmation", "campaign_id"],
      additionalProperties: false,
    },
    annotations: CONTROLLED_WRITE_ANNOTATIONS,
  },
  {
    name: "mare_github_create_pull_request",
    title: "Apply files on a branch and open a GitHub draft PR",
    description: "Creates or reuses a mare/* branch, creates or updates allowlisted files on that branch, and opens a draft pull request. It cannot merge, modify the default branch directly, change workflow files or write secret-like files. Requires CREATE GITHUB PR.",
    inputSchema: {
      type: "object",
      properties: {
        approval_confirmation: { type: "string", const: "CREATE GITHUB PR" },
        repository: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
        base_branch: { type: "string", default: "main" },
        branch_name: { type: "string", pattern: "^mare/[A-Za-z0-9._/-]{3,120}$" },
        commit_message: { type: "string", minLength: 3, maxLength: 200 },
        pr_title: { type: "string", minLength: 3, maxLength: 240 },
        pr_body: { type: "string", maxLength: 10000 },
        files: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              path: { type: "string", minLength: 1, maxLength: 300 },
              content: { type: "string", maxLength: 50000 },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["approval_confirmation", "repository", "branch_name", "commit_message", "pr_title", "files"],
      additionalProperties: false,
    },
    annotations: CONTROLLED_WRITE_ANNOTATIONS,
  },
] as const;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function timingSafeEqualText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function configuredToken(env: MareOperationsEnv): string {
  return normalize(env.MARE_OPS_ACCESS_TOKEN);
}

function suppliedToken(request: Request): string {
  const authorization = request.headers.get("Authorization") || "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return normalize(request.headers.get("X-MARE-OPS-Key"));
}

function isAuthorized(request: Request, env: MareOperationsEnv): boolean {
  const expected = configuredToken(env);
  return Boolean(expected) && timingSafeEqualText(suppliedToken(request), expected);
}

function isAllowedOrigin(request: Request): boolean {
  const origin = normalize(request.headers.get("Origin"));
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function responseHeaders(version = DEFAULT_PROTOCOL_VERSION): HeadersInit {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "MCP-Protocol-Version": version,
  };
}

function protocolVersion(request: Request, rpc?: RpcRequest): string {
  const requested = normalize(rpc?.params?.protocolVersion);
  return requested || normalize(request.headers.get("MCP-Protocol-Version")) || DEFAULT_PROTOCOL_VERSION;
}

function rpcResult(id: RpcRequest["id"], result: unknown, version: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), {
    status: 200,
    headers: responseHeaders(version),
  });
}

function rpcError(
  id: RpcRequest["id"],
  code: number,
  message: string,
  status = 200,
  data?: unknown,
  version = DEFAULT_PROTOCOL_VERSION,
): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }), { status, headers: responseHeaders(version) });
}

function authError(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      ...responseHeaders(),
      "WWW-Authenticate": "Bearer realm=\"MARE Operations OS MCP\"",
    },
  });
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => normalize(item)).filter(Boolean) : [];
}

function containsSensitiveContent(values: string[]): boolean {
  const joined = values.join("\n");
  return [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
    /\b(?:sk|pk)_[A-Za-z0-9_-]{12,}\b/i,
    /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/i,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /\b(?:password|passwd|secret|access[_ -]?token|api[_ -]?key)\s*[:=]\s*\S+/i,
  ].some((pattern) => pattern.test(joined));
}

function audit(event: string, details: {
  requestId: string;
  tool?: string;
  operation?: string;
  dryRun?: boolean;
  success: boolean;
  inputBytes?: number;
  reason?: string;
}): void {
  console.info(JSON.stringify({
    audit_schema: "mare_operations_v2",
    generated_at: new Date().toISOString(),
    event,
    request_id: details.requestId,
    tool: details.tool || null,
    operation: details.operation || null,
    dry_run: details.dryRun ?? null,
    success: details.success,
    input_bytes: details.inputBytes ?? null,
    reason: details.reason || null,
    raw_arguments_logged: false,
    pii_logged: false,
  }));
}

function toolResult(payload: JsonObject): JsonObject {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolFailure(message: string, detail?: JsonObject): JsonObject {
  return {
    content: [{ type: "text", text: detail ? `${message}: ${JSON.stringify(detail)}` : message }],
    structuredContent: detail || { error: message },
    isError: true,
  };
}

function operationsHealth(env: MareOperationsEnv): JsonObject {
  return {
    ok: true,
    service: "mare_operations_os_mcp",
    version: SERVER_VERSION,
    generated_at: new Date().toISOString(),
    configured: Boolean(configuredToken(env)),
    authentication: {
      isolated_secret: "MARE_OPS_ACCESS_TOKEN",
      commerce_token_fallback: false,
      reporting_key_fallback: false,
      public_discovery_only: true,
      tool_calls_require_authentication: true,
    },
    mode: "controlled_execution_with_explicit_approval",
    external_writes_enabled: true,
    irreversible_actions_enabled: false,
    tools: TOOLS.map((tool) => tool.name),
    write_capabilities: {
      klaviyo_campaign_create: klaviyoCampaignDraftConfiguration(env),
      klaviyo_campaign_update: klaviyoCampaignUpdateConfiguration(env),
      meta_ads: metaOperationsConfiguration(env),
      google_ads: googleAdsOperationsConfiguration(env),
      github_pull_request: githubOperationsConfiguration(env),
    },
    blocked_actions: [
      "send or schedule Klaviyo campaign",
      "activate Klaviyo flow",
      "modify consent or profiles",
      "remove Google Ads campaign",
      "delete Meta entities through Operations OS",
      "merge pull request",
      "push directly to default branch",
      "deploy or publish live theme",
      "modify Shopify live data",
      "operate TikTok Ads before API approval and bridge implementation",
    ],
    approval_contract: {
      every_write_requires_exact_confirmation: true,
      active_ads_require_separate_confirmation: true,
      budget_changes_require_separate_confirmation: true,
      provider_side_permissions_still_required: true,
    },
    audit: {
      mode: "structured_cloudflare_logs",
      raw_arguments_logged: false,
      customer_pii_logged: false,
    },
  };
}

function previewOperation(args: JsonObject): JsonObject {
  const operation = normalize(args.operation) as PreviewOperation;
  if (!PREVIEW_OPERATIONS.includes(operation)) throw new Error("invalid_preview_operation");
  if (args.dry_run !== true) throw new Error("dry_run_must_be_true");
  const objective = normalize(args.objective);
  const target = normalize(args.target);
  const changes = stringArray(args.changes);
  const rollbackPlan = normalize(args.rollback_plan);
  if (objective.length < 3 || objective.length > MAX_TEXT_LENGTH) throw new Error("invalid_objective");
  if (!target || target.length > 500) throw new Error("invalid_target");
  if (!changes.length || changes.length > MAX_CHANGE_ITEMS || changes.some((item) => item.length > 1000)) {
    throw new Error("invalid_changes");
  }
  if (rollbackPlan.length > 2000) throw new Error("invalid_rollback_plan");
  if (containsSensitiveContent([objective, target, ...changes, rollbackPlan])) throw new Error("sensitive_content_not_allowed");
  return {
    ok: true,
    plan_id: `ops-preview-${crypto.randomUUID()}`,
    generated_at: new Date().toISOString(),
    status: "preview_only",
    operation,
    dry_run: true,
    objective,
    target,
    proposed_changes: changes,
    rollback_plan: rollbackPlan || "Abandon the preview; no external state has been changed.",
    safety: {
      external_write_performed: false,
      execution_available: TOOLS.some((tool) => tool.annotations.readOnlyHint === false),
      approval_required_before_future_execution: true,
      irreversible_action_available: false,
      credentials_or_customer_pii_accepted: false,
    },
  };
}

async function callTool(name: string, args: JsonObject, env: MareOperationsEnv): Promise<JsonObject> {
  if (name === "mare_operations_health") return toolResult(operationsHealth(env));
  if (name === "mare_permissions_audit") return toolResult(buildOperationsPermissionsAudit(env));
  if (name === "mare_operations_preview") return toolResult(previewOperation(args));
  if (name === "mare_klaviyo_create_campaign_draft") return toolResult(await createKlaviyoCampaignDraft(args, env));
  if (name === "mare_klaviyo_update_campaign_draft") return toolResult(await updateKlaviyoCampaignDraft(args, env));
  if (name === "mare_meta_mutate") return toolResult(await executeMetaMutation(args, env));
  if (name === "mare_google_ads_update_campaign") return toolResult(await updateGoogleAdsCampaign(args, env));
  if (name === "mare_github_create_pull_request") return toolResult(await createGitHubPullRequest(args, env));
  return toolFailure(`Unknown tool: ${name}`);
}

async function parseRpcRequest(request: Request): Promise<{ rpc: RpcRequest; inputBytes: number }> {
  const declaredLength = Number(request.headers.get("Content-Length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) throw new Error("request_too_large");
  const text = await request.text();
  const inputBytes = new TextEncoder().encode(text).byteLength;
  if (inputBytes > MAX_REQUEST_BYTES) throw new Error("request_too_large");
  try {
    return { rpc: JSON.parse(text) as RpcRequest, inputBytes };
  } catch {
    throw new Error("parse_error");
  }
}

export async function handleMareOperationsMcpRequest(
  request: Request,
  env: MareOperationsEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp-operations" && url.pathname !== "/mcp-operations/health") return null;
  const requestId = crypto.randomUUID();

  if (!isAllowedOrigin(request)) {
    audit("request_denied", { requestId, success: false, reason: "origin_not_allowed" });
    return new Response(JSON.stringify({ error: "origin_not_allowed" }), { status: 403, headers: responseHeaders() });
  }

  if (url.pathname === "/mcp-operations/health") {
    const health = operationsHealth(env);
    return new Response(JSON.stringify({
      ok: true,
      service: health.service,
      version: health.version,
      transport: "streamable_http",
      configured: health.configured,
      mode: health.mode,
      public_discovery_enabled: true,
      tool_calls_require_authentication: true,
      external_writes_enabled: true,
      irreversible_actions_enabled: false,
      klaviyo_campaign_draft_configured: klaviyoCampaignDraftConfigured(env),
      tools: TOOLS.length,
    }), { status: 200, headers: responseHeaders() });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": request.headers.get("Origin") || "https://chatgpt.com",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, X-MARE-OPS-Key",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Max-Age": "600",
      },
    });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...responseHeaders(), Allow: "POST, OPTIONS" },
    });
  }

  let rpc: RpcRequest;
  let inputBytes = 0;
  try {
    const parsed = await parseRpcRequest(request);
    rpc = parsed.rpc;
    inputBytes = parsed.inputBytes;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "parse_error";
    audit("request_rejected", { requestId, success: false, reason });
    if (reason === "request_too_large") return rpcError(null, -32001, "Request too large", 413);
    return rpcError(null, -32700, "Parse error", 400);
  }

  const version = protocolVersion(request, rpc);
  const method = normalize(rpc.method);
  if (rpc.jsonrpc !== "2.0" || !method) return rpcError(rpc.id, -32600, "Invalid Request", 400, undefined, version);

  if (PUBLIC_DISCOVERY_NOTIFICATIONS.has(method)) {
    audit("discovery_notification", { requestId, success: true, inputBytes, reason: method });
    return new Response(null, { status: 202, headers: { "Cache-Control": "no-store", "MCP-Protocol-Version": version } });
  }

  if (PUBLIC_DISCOVERY_METHODS.has(method)) {
    audit("discovery_request", { requestId, success: true, inputBytes, reason: method });
    if (method === "initialize") {
      return rpcResult(rpc.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "MARE Operations OS", version: SERVER_VERSION },
        instructions: "Operational execution for M.A.R.E. S.R.L. Every tools/call requires the isolated Operations token. Every write tool requires an exact approval clause. Draft/paused/branch-and-PR actions are available; sending, scheduling, merging, direct default-branch writes and unapproved activation are unavailable.",
      }, version);
    }
    if (method === "ping") return rpcResult(rpc.id, {}, version);
    return rpcResult(rpc.id, { tools: TOOLS }, version);
  }

  if (!isAuthorized(request, env)) {
    audit("request_denied", { requestId, success: false, inputBytes, reason: "unauthorized_non_discovery_method" });
    return authError();
  }

  if (method === "tools/call") {
    const params = asObject(rpc.params);
    const name = normalize(params.name);
    const args = asObject(params.arguments);
    if (!name) return rpcError(rpc.id, -32602, "Missing tool name", 200, undefined, version);
    try {
      const result = await callTool(name, args, env);
      audit("tool_call", {
        requestId,
        tool: name,
        operation: normalize(args.operation) || normalize(args.action) || name,
        dryRun: args.dry_run === true,
        success: result.isError !== true,
        inputBytes,
      });
      return rpcResult(rpc.id, result, version);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "tool_execution_failed";
      audit("tool_call", {
        requestId,
        tool: name,
        operation: normalize(args.operation) || normalize(args.action) || name,
        dryRun: args.dry_run === true,
        success: false,
        inputBytes,
        reason,
      });
      return rpcResult(rpc.id, toolFailure(reason), version);
    }
  }

  return rpcError(rpc.id, -32601, "Method not found", 200, { method }, version);
}
