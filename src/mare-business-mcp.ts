import { handleMareMcpRequest } from "./mare-mcp.js";
import { handleMareOperationsMcpRequest } from "./mare-operations-mcp.js";
import { handleMareProductMediaMcpRequest } from "./mare-product-media-mcp.js";
import {
  buildMareBusinessCapabilities,
  findCapability,
  type MareBusinessCapabilityEnv,
  type MareBusinessCapability,
} from "./mare-business-capabilities.js";
import {
  getBusinessArtifact,
  readShopifyCatalog,
  type MareBusinessShopifyEnv,
} from "./mare-business-shopify.js";
import { generateMarketplaceFeed, generateMatrixifyCatalog } from "./mare-business-marketplace.js";
import {
  createTikTokCampaign,
  readTikTokCampaigns,
  tiktokAuthorizationStatus,
  updateTikTokCampaign,
  type MareBusinessTikTokEnv,
} from "./mare-business-tiktok.js";

type JsonObject = Record<string, unknown>;
type LegacyHandler = (request: Request, env: any) => Promise<Response | null>;

type KVNamespaceLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

type MareBusinessEnv = MareBusinessCapabilityEnv & MareBusinessShopifyEnv & MareBusinessTikTokEnv & {
  MARE_BUSINESS_ACCESS_TOKEN?: string;
  SHOPIFY_TOKENS_KV?: KVNamespaceLike;
  [key: string]: unknown;
};

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonObject;
};

type StoredPlan = {
  plan_id: string;
  capability_id: string;
  request: JsonObject;
  risk: MareBusinessCapability["risk"];
  approval: MareBusinessCapability["approval"];
  status: "prepared" | "executing" | "completed" | "failed" | "cancelled";
  created_at: string;
  expires_at: string;
  executed_at?: string;
  result_summary?: JsonObject;
  error?: string;
};

const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const MAX_REQUEST_BYTES = 512 * 1024;
const PLAN_TTL_SECONDS = 24 * 60 * 60;
const ALLOWED_ORIGINS = new Set(["https://chatgpt.com", "https://www.chatgpt.com", "https://chat.openai.com"]);
const PUBLIC_DISCOVERY_METHODS = new Set(["initialize", "ping", "tools/list"]);
const PUBLIC_DISCOVERY_NOTIFICATIONS = new Set(["notifications/initialized", "notifications/cancelled"]);
const SENSITIVE_KEY_PATTERN = /(password|secret|access.?token|refresh.?token|api.?key|private.?key|credit.?card|customer.?email|customer.?phone)/i;

const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const PREPARE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const EXECUTE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const GENERIC_REQUEST_SCHEMA = {
  type: "object",
  description: "Capability-specific request. Call mare_describe first and follow the returned schema.",
  additionalProperties: true,
};

const TOOLS = [
  {
    name: "mare_system_status",
    title: "MARE Business OS status",
    description: "Returns unified provider, permission, capability and safety status without exposing secret values.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_capabilities",
    title: "Discover MARE capabilities",
    description: "Lists dynamic business capabilities. New provider functions are added behind this stable tool without changing the Workspace app.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", maxLength: 80 },
        domain: { type: "string", maxLength: 80 },
        available_only: { type: "boolean", default: false },
        implemented_only: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_describe",
    title: "Describe one MARE capability",
    description: "Returns the current request schema, risk, approval requirement and missing configuration for one capability.",
    inputSchema: {
      type: "object",
      properties: { capability_id: { type: "string", minLength: 3, maxLength: 160 } },
      required: ["capability_id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_read",
    title: "Read business data",
    description: "Executes any available read-only capability across Shopify, advertising, analytics, CRM, SEO, marketplaces and artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        capability_id: { type: "string", minLength: 3, maxLength: 160 },
        request: GENERIC_REQUEST_SCHEMA,
      },
      required: ["capability_id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_prepare",
    title: "Prepare a controlled business action",
    description: "Creates an immutable plan or a non-live artifact. It never performs a live provider mutation unless the capability itself is an approved preview/artifact operation.",
    inputSchema: {
      type: "object",
      properties: {
        capability_id: { type: "string", minLength: 3, maxLength: 160 },
        request: GENERIC_REQUEST_SCHEMA,
      },
      required: ["capability_id", "request"],
      additionalProperties: false,
    },
    annotations: PREPARE_ANNOTATIONS,
  },
  {
    name: "mare_validate",
    title: "Validate a prepared MARE plan",
    description: "Rechecks plan integrity, expiry, capability availability, configuration and approval level without executing it.",
    inputSchema: {
      type: "object",
      properties: { plan_id: { type: "string", pattern: "^mbp_[A-Za-z0-9-]{20,80}$" } },
      required: ["plan_id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_execute",
    title: "Execute an approved MARE plan",
    description: "Executes only the exact immutable plan previously returned by mare_prepare. Reversible writes require EXECUTE MARE PLAN; live writes require EXECUTE MARE LIVE PLAN.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "string", pattern: "^mbp_[A-Za-z0-9-]{20,80}$" },
        approval_confirmation: { type: "string", enum: ["EXECUTE MARE PLAN", "EXECUTE MARE LIVE PLAN"] },
      },
      required: ["plan_id", "approval_confirmation"],
      additionalProperties: false,
    },
    annotations: EXECUTE_ANNOTATIONS,
  },
  {
    name: "mare_job_status",
    title: "Get MARE job or plan status",
    description: "Returns status and result summary for a prepared or executed MARE plan. The plan ID is also the initial job ID.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string", pattern: "^mbp_[A-Za-z0-9-]{20,80}$" } },
      required: ["job_id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_job_control",
    title: "Control a MARE job",
    description: "Cancels a plan that has not started. Running or completed external writes cannot be cancelled through this tool.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", pattern: "^mbp_[A-Za-z0-9-]{20,80}$" },
        action: { type: "string", enum: ["cancel"] },
      },
      required: ["job_id", "action"],
      additionalProperties: false,
    },
    annotations: PREPARE_ANNOTATIONS,
  },
  {
    name: "mare_artifact_get",
    title: "Retrieve a MARE artifact",
    description: "Retrieves a generated report, catalog export, feed, Matrixify file or other stored artifact by ID.",
    inputSchema: {
      type: "object",
      properties: { artifact_id: { type: "string", pattern: "^mba_[A-Za-z0-9-]{20,80}$" } },
      required: ["artifact_id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
] as const;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function timingSafeEqualText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function suppliedToken(request: Request): string {
  const authorization = request.headers.get("Authorization") || "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return normalize(request.headers.get("X-MARE-BUSINESS-Key"));
}

function isAuthorized(request: Request, env: MareBusinessEnv): boolean {
  const expected = normalize(env.MARE_BUSINESS_ACCESS_TOKEN);
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
  return normalize(rpc?.params?.protocolVersion) || normalize(request.headers.get("MCP-Protocol-Version")) || DEFAULT_PROTOCOL_VERSION;
}

function rpcResult(id: RpcRequest["id"], result: unknown, version: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), { status: 200, headers: responseHeaders(version) });
}

function rpcError(id: RpcRequest["id"], code: number, message: string, status = 200, data?: unknown, version = DEFAULT_PROTOCOL_VERSION): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }), { status, headers: responseHeaders(version) });
}

function authError(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { ...responseHeaders(), "WWW-Authenticate": "Bearer realm=\"MARE Business OS MCP\"" },
  });
}

function textToolResult(payload: unknown): JsonObject {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
}

function toolFailure(message: string, detail?: unknown): JsonObject {
  return {
    content: [{ type: "text", text: detail === undefined ? message : `${message}: ${JSON.stringify(detail)}` }],
    structuredContent: { error: message, detail: detail ?? null },
    isError: true,
  };
}

function planKey(planId: string): string {
  return `mare-business:plan:${planId}`;
}

function containsSensitiveKeys(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(value)) return value.some((item) => containsSensitiveKeys(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value as JsonObject)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) return true;
    if (containsSensitiveKeys(item, depth + 1)) return true;
  }
  return false;
}

function assertRequestSafe(request: JsonObject): void {
  const serialized = JSON.stringify(request);
  if (new TextEncoder().encode(serialized).byteLength > 400 * 1024) throw new Error("capability_request_too_large");
  if (containsSensitiveKeys(request)) throw new Error("credentials_or_customer_contact_data_not_accepted");
}

async function storePlan(plan: StoredPlan, env: MareBusinessEnv): Promise<void> {
  if (!env.SHOPIFY_TOKENS_KV) throw new Error("business_plan_store_not_configured");
  await env.SHOPIFY_TOKENS_KV.put(planKey(plan.plan_id), JSON.stringify(plan), { expirationTtl: PLAN_TTL_SECONDS });
}

async function loadPlan(planId: string, env: MareBusinessEnv): Promise<StoredPlan> {
  if (!env.SHOPIFY_TOKENS_KV) throw new Error("business_plan_store_not_configured");
  if (!/^mbp_[A-Za-z0-9-]{20,80}$/.test(planId)) throw new Error("invalid_plan_id");
  const raw = await env.SHOPIFY_TOKENS_KV.get(planKey(planId));
  if (!raw) throw new Error("plan_not_found_or_expired");
  const plan = JSON.parse(raw) as StoredPlan;
  if (plan.plan_id !== planId) throw new Error("plan_record_invalid");
  return plan;
}

async function invokeLegacyTool(
  handler: LegacyHandler,
  path: string,
  token: string,
  toolName: string,
  args: JsonObject,
  env: MareBusinessEnv,
): Promise<JsonObject> {
  if (!token) throw new Error("legacy_module_token_not_configured");
  const response = await handler(new Request(`https://internal.mare${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }),
  }), env as any);
  if (!response) throw new Error("legacy_module_handler_not_found");
  const body = await response.json() as JsonObject;
  const result = asObject(body.result);
  if (!response.ok || result.isError === true || body.error) {
    const content = Array.isArray(result.content) ? result.content as JsonObject[] : [];
    throw new Error(normalize(content[0]?.text) || normalize(asObject(body.error).message) || `legacy_module_error_${response.status}`);
  }
  return result;
}

function filterCapabilities(args: JsonObject, env: MareBusinessEnv): MareBusinessCapability[] {
  const provider = normalize(args.provider);
  const domain = normalize(args.domain);
  const availableOnly = args.available_only === true;
  const implementedOnly = args.implemented_only === true;
  return buildMareBusinessCapabilities(env).filter((item) => {
    if (provider && item.provider !== provider) return false;
    if (domain && item.domain !== domain) return false;
    if (availableOnly && !item.available) return false;
    if (implementedOnly && !item.implemented) return false;
    return true;
  });
}

async function systemStatus(env: MareBusinessEnv): Promise<JsonObject> {
  const capabilities = buildMareBusinessCapabilities(env);
  const tiktok = await tiktokAuthorizationStatus(env);
  let permissions: unknown = null;
  if (normalize(env.MARE_OPS_ACCESS_TOKEN)) {
    try {
      const result = await invokeLegacyTool(handleMareOperationsMcpRequest, "/mcp-operations", normalize(env.MARE_OPS_ACCESS_TOKEN), "mare_permissions_audit", {}, env);
      permissions = result.structuredContent ?? null;
    } catch (error) {
      permissions = { ok: false, error: error instanceof Error ? error.message : "permissions_audit_failed" };
    }
  }
  return {
    ok: true,
    service: "mare_business_os_mcp",
    version: SERVER_VERSION,
    generated_at: new Date().toISOString(),
    configured: Boolean(normalize(env.MARE_BUSINESS_ACCESS_TOKEN)),
    stable_contract_tools: TOOLS.map((tool) => tool.name),
    capability_counts: {
      total: capabilities.length,
      implemented: capabilities.filter((item) => item.implemented).length,
      configured: capabilities.filter((item) => item.configured).length,
      available: capabilities.filter((item) => item.available).length,
    },
    providers: {
      shopify: { configured: Boolean(env.SHOPIFY_SHOP_DOMAIN && env.SHOPIFY_TOKENS_KV) },
      commerce_os_internal: { configured: Boolean(normalize(env.MARE_MCP_ACCESS_TOKEN)) },
      operations_os_internal: { configured: Boolean(normalize(env.MARE_OPS_ACCESS_TOKEN)) },
      product_media_internal: { configured: Boolean(normalize(env.MARE_PRODUCT_MEDIA_ACCESS_TOKEN)) },
      tiktok,
      google_merchant: { configured: Boolean(normalize(env.GOOGLE_MERCHANT_ACCOUNT_ID) && (normalize(env.GOOGLE_MERCHANT_SERVICE_ACCOUNT_JSON) || normalize(env.GOOGLE_MERCHANT_REFRESH_TOKEN))) },
      amazon_sp_api: { configured: Boolean(normalize(env.AMAZON_SP_API_REFRESH_TOKEN) && normalize(env.AMAZON_SP_API_CLIENT_ID) && normalize(env.AMAZON_SP_API_CLIENT_SECRET)) },
      anthropic: { configured: Boolean(normalize(env.ANTHROPIC_API_KEY)) },
      gemini: { configured: Boolean(normalize(env.GEMINI_API_KEY)) },
    },
    permissions_audit: permissions,
    safety: {
      secrets_exposed: false,
      immutable_plan_before_external_write: true,
      read_after_write_required_by_agent_policy: true,
      direct_delete_capability_exposed: false,
      live_writes_require_explicit_confirmation: true,
    },
  };
}

async function executeRead(capabilityId: string, request: JsonObject, env: MareBusinessEnv): Promise<JsonObject> {
  if (capabilityId === "shopify.catalog.read" || capabilityId === "shopify.catalog.export") return textToolResult(await readShopifyCatalog(request, env));
  if (capabilityId === "artifact.get") return textToolResult(await getBusinessArtifact(request, env));
  if (capabilityId === "tiktok.authorization.status") return textToolResult(await tiktokAuthorizationStatus(env));
  if (capabilityId === "tiktok.campaign.read") return textToolResult(await readTikTokCampaigns(request, env));

  const commerceMap: Record<string, string> = {
    "commerce.daily_pulse": "mare_daily_pulse",
    "shopify.commerce.report": "mare_shopify_commerce",
    "paid_media.report": "mare_paid_media",
    "ga4.report": "mare_ga4",
    "ga4.realtime": "mare_ga4_realtime",
    "search_console.report": "mare_search_console",
    "klaviyo.report": "mare_klaviyo",
  };
  if (commerceMap[capabilityId]) {
    return invokeLegacyTool(handleMareMcpRequest, "/mcp", normalize(env.MARE_MCP_ACCESS_TOKEN), commerceMap[capabilityId], request, env);
  }
  if (capabilityId === "permissions.audit") {
    return invokeLegacyTool(handleMareOperationsMcpRequest, "/mcp-operations", normalize(env.MARE_OPS_ACCESS_TOKEN), "mare_permissions_audit", request, env);
  }
  if (capabilityId === "shopify.media.find") {
    return invokeLegacyTool(handleMareProductMediaMcpRequest, "/mcp-product-media", normalize(env.MARE_PRODUCT_MEDIA_ACCESS_TOKEN), "mare_shopify_find_product_media", request, env);
  }
  if (capabilityId === "shopify.media.read") {
    return invokeLegacyTool(handleMareProductMediaMcpRequest, "/mcp-product-media", normalize(env.MARE_PRODUCT_MEDIA_ACCESS_TOKEN), "mare_shopify_get_product_image", request, env);
  }
  throw new Error("read_capability_router_not_implemented");
}

async function executePreparedCapability(plan: StoredPlan, env: MareBusinessEnv): Promise<JsonObject> {
  const request = { ...plan.request };
  const deterministicIdempotency = `mare-${plan.plan_id}`.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 128);

  if (plan.capability_id === "marketplace.feed.generate") return textToolResult(await generateMarketplaceFeed(request, env));
  if (plan.capability_id === "matrixify.catalog.generate") return textToolResult(await generateMatrixifyCatalog(request, env));
  if (plan.capability_id === "shopify.media.preview") {
    return invokeLegacyTool(handleMareProductMediaMcpRequest, "/mcp-product-media", normalize(env.MARE_PRODUCT_MEDIA_ACCESS_TOKEN), "mare_product_image_generate_preview", {
      ...request,
      approval_confirmation: "GENERATE PRODUCT IMAGE PREVIEW",
      idempotency_key: normalize(request.idempotency_key) || deterministicIdempotency,
    }, env);
  }
  if (plan.capability_id === "shopify.media.publish") {
    return invokeLegacyTool(handleMareProductMediaMcpRequest, "/mcp-product-media", normalize(env.MARE_PRODUCT_MEDIA_ACCESS_TOKEN), "mare_product_image_publish", {
      ...request,
      approval_confirmation: "PUBLISH PRODUCT IMAGE TO SHOPIFY",
      idempotency_key: normalize(request.idempotency_key) || deterministicIdempotency,
    }, env);
  }
  if (plan.capability_id === "klaviyo.campaign.draft.create") {
    return invokeLegacyTool(handleMareOperationsMcpRequest, "/mcp-operations", normalize(env.MARE_OPS_ACCESS_TOKEN), "mare_klaviyo_create_campaign_draft", {
      ...request,
      approval_confirmation: "CREATE KLAVIYO DRAFT",
      idempotency_key: normalize(request.idempotency_key) || deterministicIdempotency,
    }, env);
  }
  if (plan.capability_id === "klaviyo.campaign.draft.update") {
    return invokeLegacyTool(handleMareOperationsMcpRequest, "/mcp-operations", normalize(env.MARE_OPS_ACCESS_TOKEN), "mare_klaviyo_update_campaign_draft", {
      ...request,
      approval_confirmation: "UPDATE KLAVIYO DRAFT",
    }, env);
  }
  if (plan.capability_id === "meta.entity.mutate") {
    const payload = asObject(request.payload);
    const active = normalize(payload.status).toUpperCase() === "ACTIVE" || normalize(payload.effective_status).toUpperCase() === "ACTIVE";
    return invokeLegacyTool(handleMareOperationsMcpRequest, "/mcp-operations", normalize(env.MARE_OPS_ACCESS_TOKEN), "mare_meta_mutate", {
      ...request,
      approval_confirmation: active ? "ACTIVATE META ADS" : "EXECUTE META CHANGE",
      idempotency_key: normalize(request.idempotency_key) || deterministicIdempotency,
    }, env);
  }
  if (plan.capability_id === "google_ads.campaign.update") {
    return invokeLegacyTool(handleMareOperationsMcpRequest, "/mcp-operations", normalize(env.MARE_OPS_ACCESS_TOKEN), "mare_google_ads_update_campaign", {
      ...request,
      approval_confirmation: normalize(request.status).toUpperCase() === "ENABLED" ? "ENABLE GOOGLE ADS CAMPAIGN" : "EXECUTE GOOGLE ADS CHANGE",
      ...(request.daily_budget_eur === undefined ? {} : { budget_approval_confirmation: "CHANGE GOOGLE ADS BUDGET" }),
    }, env);
  }
  if (plan.capability_id === "github.pull_request.create") {
    return invokeLegacyTool(handleMareOperationsMcpRequest, "/mcp-operations", normalize(env.MARE_OPS_ACCESS_TOKEN), "mare_github_create_pull_request", {
      ...request,
      approval_confirmation: "CREATE GITHUB PR",
    }, env);
  }
  if (plan.capability_id === "tiktok.campaign.create") {
    return textToolResult(await createTikTokCampaign({ ...request, approval_confirmation: "CREATE TIKTOK CAMPAIGN PAUSED" }, env));
  }
  if (plan.capability_id === "tiktok.campaign.update") {
    const payload = asObject(request.payload);
    const confirmation = normalize(payload.operation_status) === "ENABLE" ? "ENABLE TIKTOK CAMPAIGN" : "UPDATE TIKTOK CAMPAIGN";
    return textToolResult(await updateTikTokCampaign({ ...request, approval_confirmation: confirmation }, env));
  }
  throw new Error("execute_capability_router_not_implemented");
}

async function prepareCapability(capability: MareBusinessCapability, request: JsonObject, env: MareBusinessEnv): Promise<JsonObject> {
  assertRequestSafe(request);
  if (!capability.implemented) throw new Error("capability_not_implemented");
  if (!capability.available) throw new Error(`capability_not_available:${capability.missing.join(",")}`);
  const planId = `mbp_${crypto.randomUUID()}`;
  const now = new Date();
  const plan: StoredPlan = {
    plan_id: planId,
    capability_id: capability.id,
    request,
    risk: capability.risk,
    approval: capability.approval,
    status: "prepared",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + PLAN_TTL_SECONDS * 1000).toISOString(),
  };
  await storePlan(plan, env);

  if (capability.risk === "artifact_only" && capability.approval === "none") {
    const result = await executePreparedCapability(plan, env);
    plan.status = "completed";
    plan.executed_at = new Date().toISOString();
    plan.result_summary = asObject(result.structuredContent);
    await storePlan(plan, env);
    return { ...result, structuredContent: { plan, result: result.structuredContent } };
  }

  return textToolResult({
    ok: true,
    status: "prepared",
    plan,
    required_confirmation: capability.risk === "live_write" ? "EXECUTE MARE LIVE PLAN" : "EXECUTE MARE PLAN",
    immutable_request: true,
    external_write_performed: false,
  });
}

async function executePlan(args: JsonObject, env: MareBusinessEnv): Promise<JsonObject> {
  const planId = normalize(args.plan_id);
  const confirmation = normalize(args.approval_confirmation);
  const plan = await loadPlan(planId, env);
  if (plan.status === "completed") return textToolResult({ ok: true, status: "completed", idempotent_replay: true, plan });
  if (plan.status === "cancelled") throw new Error("plan_cancelled");
  if (plan.status === "executing") throw new Error("plan_already_executing");
  if (Date.parse(plan.expires_at) <= Date.now()) throw new Error("plan_expired");
  const capability = findCapability(plan.capability_id, env);
  if (!capability || !capability.available) throw new Error(`capability_no_longer_available:${capability?.missing.join(",") || "unknown"}`);
  const required = plan.risk === "live_write" ? "EXECUTE MARE LIVE PLAN" : "EXECUTE MARE PLAN";
  if (confirmation !== required) throw new Error(`approval_confirmation_required:${required}`);
  plan.status = "executing";
  await storePlan(plan, env);
  try {
    const result = await executePreparedCapability(plan, env);
    plan.status = "completed";
    plan.executed_at = new Date().toISOString();
    plan.result_summary = asObject(result.structuredContent);
    await storePlan(plan, env);
    return { ...result, structuredContent: { plan_id: plan.plan_id, status: plan.status, result: result.structuredContent } };
  } catch (error) {
    plan.status = "failed";
    plan.error = error instanceof Error ? error.message : "plan_execution_failed";
    await storePlan(plan, env);
    throw error;
  }
}

async function callTool(name: string, args: JsonObject, env: MareBusinessEnv): Promise<JsonObject> {
  if (name === "mare_system_status") return textToolResult(await systemStatus(env));
  if (name === "mare_capabilities") return textToolResult({ ok: true, generated_at: new Date().toISOString(), capabilities: filterCapabilities(args, env) });
  if (name === "mare_describe") {
    const id = normalize(args.capability_id);
    const capability = findCapability(id, env);
    return capability ? textToolResult({ ok: true, capability }) : toolFailure("capability_not_found");
  }
  if (name === "mare_read") {
    const capabilityId = normalize(args.capability_id);
    const capability = findCapability(capabilityId, env);
    if (!capability) return toolFailure("capability_not_found");
    if (!capability.implemented) return toolFailure("capability_not_implemented", capability);
    if (!capability.available) return toolFailure("capability_not_available", capability);
    if (!["read", "artifact"].includes(capability.operation)) return toolFailure("capability_is_not_readable_use_mare_prepare", capability);
    const request = asObject(args.request);
    assertRequestSafe(request);
    return executeRead(capabilityId, request, env);
  }
  if (name === "mare_prepare") {
    const capabilityId = normalize(args.capability_id);
    const capability = findCapability(capabilityId, env);
    if (!capability) return toolFailure("capability_not_found");
    if (capability.operation === "read") return toolFailure("read_capability_use_mare_read", capability);
    return prepareCapability(capability, asObject(args.request), env);
  }
  if (name === "mare_validate") {
    const plan = await loadPlan(normalize(args.plan_id), env);
    const capability = findCapability(plan.capability_id, env);
    return textToolResult({
      ok: true,
      plan,
      valid: plan.status === "prepared" && Date.parse(plan.expires_at) > Date.now() && Boolean(capability?.available),
      capability,
      required_confirmation: plan.risk === "live_write" ? "EXECUTE MARE LIVE PLAN" : "EXECUTE MARE PLAN",
    });
  }
  if (name === "mare_execute") return executePlan(args, env);
  if (name === "mare_job_status") return textToolResult({ ok: true, job: await loadPlan(normalize(args.job_id), env) });
  if (name === "mare_job_control") {
    const plan = await loadPlan(normalize(args.job_id), env);
    if (normalize(args.action) !== "cancel") return toolFailure("unsupported_job_action");
    if (plan.status !== "prepared") return toolFailure("job_cannot_be_cancelled_after_execution_started", plan);
    plan.status = "cancelled";
    await storePlan(plan, env);
    return textToolResult({ ok: true, status: "cancelled", job_id: plan.plan_id });
  }
  if (name === "mare_artifact_get") return textToolResult(await getBusinessArtifact(args, env));
  return toolFailure(`Unknown tool: ${name}`);
}

async function parseRpcRequest(request: Request): Promise<RpcRequest> {
  const declaredLength = Number(request.headers.get("Content-Length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) throw new Error("request_too_large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) throw new Error("request_too_large");
  try {
    return JSON.parse(text) as RpcRequest;
  } catch {
    throw new Error("parse_error");
  }
}

export async function handleMareBusinessMcpRequest(request: Request, env: MareBusinessEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp-business" && url.pathname !== "/mcp-business/health") return null;
  if (!isAllowedOrigin(request)) return new Response(JSON.stringify({ error: "origin_not_allowed" }), { status: 403, headers: responseHeaders() });
  if (url.pathname === "/mcp-business/health") {
    return new Response(JSON.stringify(await systemStatus(env)), { status: 200, headers: responseHeaders() });
  }
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": request.headers.get("Origin") || "https://chatgpt.com",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, X-MARE-BUSINESS-Key",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Max-Age": "600",
      },
    });
  }
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { ...responseHeaders(), Allow: "POST, OPTIONS" } });

  let rpc: RpcRequest;
  try {
    rpc = await parseRpcRequest(request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "parse_error";
    return rpcError(null, reason === "request_too_large" ? -32001 : -32700, reason === "request_too_large" ? "Request too large" : "Parse error", reason === "request_too_large" ? 413 : 400);
  }
  const version = protocolVersion(request, rpc);
  const method = normalize(rpc.method);
  if (rpc.jsonrpc !== "2.0" || !method) return rpcError(rpc.id, -32600, "Invalid Request", 400, undefined, version);
  if (PUBLIC_DISCOVERY_NOTIFICATIONS.has(method)) return new Response(null, { status: 202, headers: { "Cache-Control": "no-store", "MCP-Protocol-Version": version } });
  if (PUBLIC_DISCOVERY_METHODS.has(method)) {
    if (method === "initialize") {
      return rpcResult(rpc.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "MARE Business OS", version: SERVER_VERSION },
        instructions: "Unified operating system for M.A.R.E. S.R.L. Every agent must call mare_capabilities or mare_describe before claiming a limitation. All external writes require an immutable prepared plan and explicit execution approval.",
      }, version);
    }
    if (method === "ping") return rpcResult(rpc.id, {}, version);
    return rpcResult(rpc.id, { tools: TOOLS }, version);
  }
  if (!isAuthorized(request, env)) return authError();
  if (method === "tools/call") {
    const params = asObject(rpc.params);
    const name = normalize(params.name);
    if (!name) return rpcError(rpc.id, -32602, "Missing tool name", 200, undefined, version);
    try {
      return rpcResult(rpc.id, await callTool(name, asObject(params.arguments), env), version);
    } catch (error) {
      return rpcResult(rpc.id, toolFailure(error instanceof Error ? error.message : "tool_execution_failed"), version);
    }
  }
  return rpcError(rpc.id, -32601, "Method not found", 200, { method }, version);
}
