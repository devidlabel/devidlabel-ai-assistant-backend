type JsonObject = Record<string, unknown>;

type MareOperationsEnv = {
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

const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_TEXT_LENGTH = 2000;
const MAX_CHANGE_ITEMS = 20;

const ALLOWED_ORIGINS = new Set([
  "https://chatgpt.com",
  "https://www.chatgpt.com",
  "https://chat.openai.com",
]);

const PREVIEW_OPERATIONS: readonly PreviewOperation[] = [
  "klaviyo_campaign_draft",
  "klaviyo_template_draft",
  "klaviyo_segment_draft",
  "klaviyo_flow_draft",
  "github_branch",
  "github_pull_request",
];

const PREVIEW_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const TOOLS = [
  {
    name: "mare_operations_health",
    title: "MARE Operations OS health",
    description: "Checks the isolated Operations OS foundation. It reports configuration and planned capabilities without exposing secrets or performing writes.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: PREVIEW_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_operations_preview",
    title: "Preview an operational change",
    description: "Builds a dry-run-only execution plan for a future Klaviyo draft or GitHub branch/PR operation. It never writes to an external system.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: PREVIEW_OPERATIONS,
          description: "Future operation family to preview. No write action is enabled in this foundation version.",
        },
        dry_run: {
          type: "boolean",
          const: true,
          description: "Must be true. The foundation rejects every non-dry-run request.",
        },
        objective: {
          type: "string",
          minLength: 3,
          maxLength: MAX_TEXT_LENGTH,
          description: "Business objective of the proposed operation. Do not include credentials or customer PII.",
        },
        target: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Non-sensitive target, such as a campaign draft name or repository/branch label.",
        },
        changes: {
          type: "array",
          minItems: 1,
          maxItems: MAX_CHANGE_ITEMS,
          items: { type: "string", minLength: 1, maxLength: 500 },
          description: "Proposed changes, expressed without secrets or customer PII.",
        },
        rollback_plan: {
          type: "string",
          maxLength: 1000,
          description: "Proposed rollback or abandonment plan for the future executable operation.",
        },
      },
      required: ["operation", "dry_run", "objective", "target", "changes"],
      additionalProperties: false,
    },
    annotations: PREVIEW_ONLY_ANNOTATIONS,
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
  // Deliberately no fallback to MARE Commerce OS or other report tokens.
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
  // Structured Cloudflare log. Never include raw arguments, credentials or customer PII.
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
    },
    mode: "foundation_preview_only",
    external_writes_enabled: false,
    irreversible_actions_enabled: false,
    tools: TOOLS.map((tool) => tool.name),
    future_operation_families: {
      klaviyo_drafts: [
        "campaign draft",
        "template draft",
        "segment draft",
        "flow draft",
      ],
      github_controlled_changes: [
        "branch creation",
        "pull request creation",
      ],
    },
    blocked_actions: [
      "send or schedule Klaviyo campaign",
      "activate Klaviyo flow",
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

  const planId = `ops-preview-${crypto.randomUUID()}`;
  return {
    ok: true,
    plan_id: planId,
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
      "No write-capable tool is enabled in the foundation version.",
      "A separate reviewed release must add the exact allowlisted write action.",
      "The future executable action must require explicit approval and an idempotency strategy.",
    ],
    next_review: {
      required: true,
      checks: [
        "verify target and proposed changes",
        "verify least-privilege upstream credentials",
        "verify rollback or abandonment plan",
        "verify no send, merge, main push or deploy capability is enabled",
      ],
    },
  };
}

async function callTool(name: string, args: JsonObject, env: MareOperationsEnv): Promise<JsonObject> {
  if (name === "mare_operations_health") return toolResult(operationsHealth(env));
  if (name === "mare_operations_preview") return toolResult(previewOperation(args));
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
      mode: "foundation_preview_only",
      external_writes_enabled: false,
      irreversible_actions_enabled: false,
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

  if (!isAuthorized(request, env)) {
    audit("request_denied", { requestId, success: false, reason: "unauthorized" });
    return authError();
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
  if (rpc.jsonrpc !== "2.0" || !normalize(rpc.method)) {
    return rpcError(rpc.id, -32600, "Invalid Request", 400, undefined, version);
  }

  if (rpc.method === "notifications/initialized" || rpc.method === "notifications/cancelled") {
    return new Response(null, {
      status: 202,
      headers: { "Cache-Control": "no-store", "MCP-Protocol-Version": version },
    });
  }

  if (rpc.method === "initialize") {
    return rpcResult(rpc.id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "MARE Operations OS", version: SERVER_VERSION },
      instructions: "Preview-only operational planning for M.A.R.E. S.R.L. No external write action is enabled in this foundation release. Every request must remain dry-run and contain no credentials or customer PII.",
    }, version);
  }

  if (rpc.method === "ping") return rpcResult(rpc.id, {}, version);
  if (rpc.method === "tools/list") return rpcResult(rpc.id, { tools: TOOLS }, version);

  if (rpc.method === "tools/call") {
    const params = asObject(rpc.params);
    const name = normalize(params.name);
    const args = asObject(params.arguments);
    if (!name) return rpcError(rpc.id, -32602, "Missing tool name", 200, undefined, version);

    const operation = normalize(args.operation);
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

  return rpcError(rpc.id, -32601, "Method not found", 200, { method: rpc.method }, version);
}
