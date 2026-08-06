import {
  createKlaviyoCampaignDraft,
  klaviyoCampaignDraftConfiguration,
  klaviyoCampaignDraftConfigured,
  type KlaviyoOperationsEnv,
} from "./mare-operations-klaviyo.js";

type JsonObject = Record<string, unknown>;

type MareOperationsEnv = KlaviyoOperationsEnv & {
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
  | "klaviyo_template_draft"
  | "klaviyo_segment_draft"
  | "klaviyo_flow_draft"
  | "github_branch"
  | "github_pull_request";

const SERVER_VERSION = "0.2.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_TEXT_LENGTH = 2000;
const MAX_CHANGE_ITEMS = 20;

const ALLOWED_ORIGINS = new Set([
  "https://chatgpt.com",
  "https://www.chatgpt.com",
  "https://chat.openai.com",
]);

const PUBLIC_DISCOVERY_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
]);
const PUBLIC_DISCOVERY_NOTIFICATIONS = new Set([
  "notifications/initialized",
  "notifications/cancelled",
]);

const PREVIEW_OPERATIONS: readonly PreviewOperation[] = [
  "klaviyo_campaign_draft",
  "klaviyo_template_draft",
  "klaviyo_segment_draft",
  "klaviyo_flow_draft",
  "github_branch",
  "github_pull_request",
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
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_operations_preview",
    title: "Preview an operational change",
    description: "Builds a dry-run-only execution plan. It never writes to an external system.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: PREVIEW_OPERATIONS,
          description: "Operation family to preview.",
        },
        dry_run: {
          type: "boolean",
          const: true,
          description: "Must be true.",
        },
        objective: {
          type: "string",
          minLength: 3,
          maxLength: MAX_TEXT_LENGTH,
          description: "Business objective. Do not include credentials or customer PII.",
        },
        target: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Non-sensitive target label.",
        },
        changes: {
          type: "array",
          minItems: 1,
          maxItems: MAX_CHANGE_ITEMS,
          items: { type: "string", minLength: 1, maxLength: 500 },
        },
        rollback_plan: {
          type: "string",
          maxLength: 1000,
        },
      },
      required: ["operation", "dry_run", "objective", "target", "changes"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_klaviyo_create_campaign_draft",
    title: "Create a Klaviyo email campaign draft",
    description: "Creates one Klaviyo email campaign in Draft status only. It cannot send or schedule. Requires explicit confirmation, an idempotency key, an existing audience ID, and optionally an existing template ID. Sender identities come only from server-side configuration.",
    inputSchema: {
      type: "object",
      properties: {
        approval_confirmation: {
          type: "string",
          const: "CREATE KLAVIYO DRAFT",
          description: "Explicit acknowledgement required before the external write.",
        },
        idempotency_key: {
          type: "string",
          minLength: 8,
          maxLength: 128,
          pattern: "^[A-Za-z0-9._:-]+$",
          description: "Stable unique key for this intended draft. Reusing it returns the existing campaign instead of creating a duplicate.",
        },
        campaign_name: {
          type: "string",
          minLength: 3,
          maxLength: 180,
        },
        audience_id: {
          type: "string",
          minLength: 3,
          maxLength: 100,
          pattern: "^[A-Za-z0-9_-]+$",
          description: "Existing Klaviyo list or segment ID.",
        },
        subject: {
          type: "string",
          minLength: 1,
          maxLength: 200,
        },
        preview_text: {
          type: "string",
          maxLength: 300,
        },
        template_id: {
          type: "string",
          minLength: 3,
          maxLength: 100,
          pattern: "^[A-Za-z0-9_-]+$",
          description: "Optional existing reusable Klaviyo template ID to clone and assign to the campaign message.",
        },
        use_smart_sending: {
          type: "boolean",
          default: true,
        },
      },
      required: [
        "approval_confirmation",
        "idempotency_key",
        "campaign_name",
        "audience_id",
        "subject",
        "preview_text"
      ],
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
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
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
  }), {
    status,
    headers: responseHeaders(version),
  });
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
  return Array.isArray(value)
    ? value.map((item) => normalize(item)).filter(Boolean)
    : [];
}

function pickOperation(value: unknown): PreviewOperation | null {
  const candidate = normalize(value) as PreviewOperation;
  return PREVIEW_OPERATIONS.includes(candidate) ? candidate : null;
}

function containsSensitiveContent(values: string[]): boolean {
  const joined = values.join("\n");
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
    /\b(?:sk|pk)_[A-Za-z0-9_-]{12,}\b/i,
    /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/i,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /\b(?:password|passwd|secret|access[_ -]?token|api[_ -]?key)\s*[:=]\s*\S+/i,
  ];
  return patterns.some((pattern) => pattern.test(joined));
}

function audit(
  event: string,
  details: {
    requestId: string;
    tool?: string;
    operation?: string;
    dryRun?: boolean;
    success: boolean;
    inputBytes?: number;
    reason?: string;
  },
): void {
  console.info(JSON.stringify({
    audit_schema: "mare_operations_v1",
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
    mode: "controlled_draft_writes",
    external_writes_enabled: true,
    irreversible_actions_enabled: false,
    tools: TOOLS.map((tool) => tool.name),
    write_capabilities: {
      klaviyo_campaign_draft: klaviyoCampaignDraftConfiguration(env),
    },
    blocked_actions: [
      "send or schedule Klaviyo campaign",
      "activate Klaviyo flow",
      "modify consent or profiles",
      "merge pull request",
      "push to main",
      "deploy or publish live theme",
      "modify Shopify live data",
    ],
    audit: {
      mode: "structured_cloudflare_logs",
      raw_arguments_logged: false,
      customer_pii_logged: false,
    },
  };
}

function previewOperation(args: JsonObject): JsonObject {
  const operation = pickOperation(args.operation);
  const objective = normalize(args.objective);
  const target = normalize(args.target);
  const changes = stringArray(args.changes);
  const rollbackPlan = normalize(args.rollback_plan);

  if (!operation) throw new Error("invalid_preview_operation");
  if (args.dry_run !== true) throw new Error("dry_run_must_be_true");
  if (objective.length < 3 || objective.length > MAX_TEXT_LENGTH) throw new Error("invalid_objective");
  if (!target || target.length > 500) throw new Error("invalid_target");
  if (!changes.length || changes.length > MAX_CHANGE_ITEMS || changes.some((item) => item.length > 500)) {
    throw new Error("invalid_changes");
  }
  if (rollbackPlan.length > 1000) throw new Error("invalid_rollback_plan");
  if (containsSensitiveContent([objective, target, ...changes, rollbackPlan])) {
    throw new Error("sensitive_content_not_allowed");
  }

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
      execution_available: false,
      approval_required_before_future_execution: true,
      irreversible_action_available: false,
      credentials_or_customer_pii_accepted: false,
    },
    blockers: [
      "Only the exact allowlisted Klaviyo campaign-draft action can write.",
      "Every executable draft request requires explicit confirmation and idempotency.",
      "Send, scheduling, live activation, consent and profile changes remain unavailable.",
    ],
  };
}

async function callTool(name: string, args: JsonObject, env: MareOperationsEnv): Promise<JsonObject> {
  if (name === "mare_operations_health") return toolResult(operationsHealth(env));
  if (name === "mare_operations_preview") return toolResult(previewOperation(args));
  if (name === "mare_klaviyo_create_campaign_draft") {
    return toolResult(await createKlaviyoCampaignDraft(args, env));
  }
  return toolFailure(`Unknown tool: ${name}`);
}

async function parseRpcRequest(request: Request): Promise<{ rpc: RpcRequest; inputBytes: number }> {
  const declaredLength = Number(request.headers.get("Content-Length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new Error("request_too_large");
  }
  const text = await request.text();
  const inputBytes = new TextEncoder().encode(text).byteLength;
  if (inputBytes > MAX_REQUEST_BYTES) throw new Error("request_too_large");
  let rpc: RpcRequest;
  try {
    rpc = JSON.parse(text) as RpcRequest;
  } catch {
    throw new Error("parse_error");
  }
  return { rpc, inputBytes };
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
    return new Response(JSON.stringify({ error: "origin_not_allowed" }), {
      status: 403,
      headers: responseHeaders(),
    });
  }

  if (url.pathname === "/mcp-operations/health") {
    return new Response(JSON.stringify({
      ok: true,
      service: "mare_operations_os_mcp",
      version: SERVER_VERSION,
      transport: "streamable_http",
      configured: Boolean(configuredToken(env)),
      mode: "controlled_draft_writes",
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
  if (rpc.jsonrpc !== "2.0" || !method) {
    return rpcError(rpc.id, -32600, "Invalid Request", 400, undefined, version);
  }

  if (PUBLIC_DISCOVERY_NOTIFICATIONS.has(method)) {
    audit("discovery_notification", { requestId, success: true, inputBytes, reason: method });
    return new Response(null, {
      status: 202,
      headers: { "Cache-Control": "no-store", "MCP-Protocol-Version": version },
    });
  }

  if (PUBLIC_DISCOVERY_METHODS.has(method)) {
    audit("discovery_request", { requestId, success: true, inputBytes, reason: method });

    if (method === "initialize") {
      return rpcResult(rpc.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "MARE Operations OS", version: SERVER_VERSION },
        instructions: "Controlled operations for M.A.R.E. S.R.L. Discovery is public, every tools/call requires the isolated Operations token, and the only enabled external write creates a Klaviyo email campaign draft. Sending and scheduling are unavailable.",
      }, version);
    }

    if (method === "ping") return rpcResult(rpc.id, {}, version);
    return rpcResult(rpc.id, { tools: TOOLS }, version);
  }

  if (!isAuthorized(request, env)) {
    audit("request_denied", {
      requestId,
      success: false,
      inputBytes,
      reason: "unauthorized_non_discovery_method",
    });
    return authError();
  }

  if (method === "tools/call") {
    const params = asObject(rpc.params);
    const name = normalize(params.name);
    const args = asObject(params.arguments);
    if (!name) return rpcError(rpc.id, -32602, "Missing tool name", 200, undefined, version);

    const operation = normalize(args.operation) || name;
    try {
      const result = await callTool(name, args, env);
      audit("tool_call", {
        requestId,
        tool: name,
        operation,
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
        operation,
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
