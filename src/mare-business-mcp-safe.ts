import { handleMareBusinessMcpRequest } from "./mare-business-mcp.js";
import { buildMareBusinessCapabilities, type MareBusinessCapability } from "./mare-business-capabilities.js";
import { readShopifyCatalogComplete } from "./mare-business-shopify-complete.js";
import {
  generateMarketplaceFeedComplete,
  generateMatrixifyCatalogComplete,
} from "./mare-business-marketplace-complete.js";
import {
  createTikTokAuthorizationUrl,
  createTikTokCampaignSafe,
  readTikTokCampaignsSafe,
  tiktokSafeAuthorizationStatus,
  updateTikTokCampaignSafe,
  type MareBusinessTikTokSafeEnv,
} from "./mare-business-tiktok-safe.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

type JsonObject = Record<string, unknown>;
type KVNamespaceLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

type SafeBusinessEnv = MareBusinessTikTokSafeEnv & MareBusinessShopifyEnv & {
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

type PlanStatus = "prepared" | "executing" | "completed" | "failed" | "reconciliation_required" | "cancelled";
type StoredPlan = {
  plan_id: string;
  capability_id: string;
  request: JsonObject;
  risk: MareBusinessCapability["risk"];
  approval: MareBusinessCapability["approval"];
  status: PlanStatus;
  created_at: string;
  expires_at: string;
  executed_at?: string;
  result_summary?: JsonObject;
  error?: string;
};

const PLAN_TTL_SECONDS = 24 * 60 * 60;
const TIKTOK_CAPABILITIES = new Set([
  "tiktok.authorization.status",
  "tiktok.authorization.start",
  "tiktok.campaign.read",
  "tiktok.campaign.create",
  "tiktok.campaign.update",
]);

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function timingSafeEqualText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function isAuthorized(request: Request, env: SafeBusinessEnv): boolean {
  const expected = normalize(env.MARE_BUSINESS_ACCESS_TOKEN);
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : normalize(request.headers.get("X-MARE-BUSINESS-Key"));
  return Boolean(expected) && timingSafeEqualText(expected, supplied);
}

function protocolVersion(request: Request): string {
  return normalize(request.headers.get("MCP-Protocol-Version")) || "2025-06-18";
}

function responseHeaders(request: Request): HeadersInit {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "MCP-Protocol-Version": protocolVersion(request),
  };
}

function textToolResult(payload: unknown): JsonObject {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolFailure(message: string, detail?: unknown): JsonObject {
  return {
    content: [{ type: "text", text: detail === undefined ? message : `${message}: ${JSON.stringify(detail)}` }],
    structuredContent: { error: message, detail: detail ?? null },
    isError: true,
  };
}

function rpcToolResponse(request: Request, id: RpcRequest["id"], result: JsonObject): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), {
    status: 200,
    headers: responseHeaders(request),
  });
}

function planKey(planId: string): string {
  return `mare-business:plan:${planId}`;
}

async function storePlan(plan: StoredPlan, env: SafeBusinessEnv): Promise<void> {
  if (!env.SHOPIFY_TOKENS_KV) throw new Error("business_plan_store_not_configured");
  await env.SHOPIFY_TOKENS_KV.put(planKey(plan.plan_id), JSON.stringify(plan), { expirationTtl: PLAN_TTL_SECONDS });
}

async function loadPlan(planId: string, env: SafeBusinessEnv): Promise<StoredPlan> {
  if (!env.SHOPIFY_TOKENS_KV) throw new Error("business_plan_store_not_configured");
  if (!/^mbp_[A-Za-z0-9-]{20,80}$/.test(planId)) throw new Error("invalid_plan_id");
  const raw = await env.SHOPIFY_TOKENS_KV.get(planKey(planId));
  if (!raw) throw new Error("plan_not_found_or_expired");
  const plan = JSON.parse(raw) as StoredPlan;
  if (plan.plan_id !== planId) throw new Error("plan_record_invalid");
  return plan;
}

function startCapability(status: JsonObject): MareBusinessCapability {
  const configured = status.app_configured === true && status.authorization_url_configured === true && status.kv_store_configured === true;
  const missing = [
    ...(status.app_configured === true ? [] : ["TIKTOK_APP_ID and TIKTOK_APP_SECRET"]),
    ...(status.authorization_url_configured === true ? [] : ["TIKTOK_AUTHORIZATION_URL"]),
    ...(status.kv_store_configured === true ? [] : ["SHOPIFY_TOKENS_KV"]),
  ];
  return {
    id: "tiktok.authorization.start",
    provider: "tiktok",
    domain: "advertising",
    operation: "prepare",
    risk: "artifact_only",
    implemented: true,
    configured,
    available: configured,
    approval: "none",
    description: "Create a short-lived TikTok advertiser authorization URL through an authenticated MARE request.",
    request_schema: { type: "object", properties: {}, additionalProperties: false },
    missing,
  };
}

async function resolvedCapabilities(env: SafeBusinessEnv): Promise<MareBusinessCapability[]> {
  const status = await tiktokSafeAuthorizationStatus(env);
  const authorized = status.authorized === true;
  const capabilities = buildMareBusinessCapabilities(env).map((capability) => {
    if (!["tiktok.campaign.read", "tiktok.campaign.create", "tiktok.campaign.update"].includes(capability.id)) return capability;
    return {
      ...capability,
      configured: authorized,
      available: capability.implemented && authorized,
      missing: authorized ? [] : ["TikTok long-term access token and advertiser authorization"],
    };
  });
  const existingStart = capabilities.findIndex((item) => item.id === "tiktok.authorization.start");
  const start = startCapability(status);
  if (existingStart >= 0) capabilities[existingStart] = start;
  else capabilities.push(start);
  return capabilities;
}

async function resolveCapability(id: string, env: SafeBusinessEnv): Promise<MareBusinessCapability | null> {
  return (await resolvedCapabilities(env)).find((item) => item.id === id) || null;
}

function filterCapabilityList(capabilities: MareBusinessCapability[], args: JsonObject): MareBusinessCapability[] {
  const provider = normalize(args.provider);
  const domain = normalize(args.domain);
  return capabilities.filter((item) => {
    if (provider && item.provider !== provider) return false;
    if (domain && item.domain !== domain) return false;
    if (args.available_only === true && !item.available) return false;
    if (args.implemented_only === true && !item.implemented) return false;
    return true;
  });
}

function createPlan(capability: MareBusinessCapability, request: JsonObject): StoredPlan {
  const now = new Date();
  return {
    plan_id: `mbp_${crypto.randomUUID()}`,
    capability_id: capability.id,
    request,
    risk: capability.risk,
    approval: capability.approval,
    status: "prepared",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + PLAN_TTL_SECONDS * 1000).toISOString(),
  };
}

async function completeArtifactPlan(
  capability: MareBusinessCapability,
  requestPayload: JsonObject,
  env: SafeBusinessEnv,
): Promise<JsonObject> {
  const plan = createPlan(capability, requestPayload);
  let result: JsonObject;
  if (capability.id === "marketplace.feed.generate") {
    result = await generateMarketplaceFeedComplete(requestPayload, env);
  } else if (capability.id === "matrixify.catalog.generate") {
    result = await generateMatrixifyCatalogComplete(requestPayload, env);
  } else if (capability.id === "tiktok.authorization.start") {
    result = await createTikTokAuthorizationUrl(env);
  } else {
    throw new Error("safe_artifact_router_not_implemented");
  }
  plan.status = "completed";
  plan.executed_at = new Date().toISOString();
  plan.result_summary = result;
  await storePlan(plan, env);
  return textToolResult({ plan, result });
}

async function prepareTikTokWrite(
  capability: MareBusinessCapability,
  requestPayload: JsonObject,
  env: SafeBusinessEnv,
): Promise<JsonObject> {
  const plan = createPlan(capability, requestPayload);
  await storePlan(plan, env);
  return textToolResult({
    ok: true,
    status: "prepared",
    plan,
    required_confirmation: "EXECUTE MARE LIVE PLAN",
    immutable_request: true,
    external_write_performed: false,
  });
}

async function executeTikTokPlan(
  plan: StoredPlan,
  confirmation: string,
  env: SafeBusinessEnv,
): Promise<JsonObject> {
  if (confirmation !== "EXECUTE MARE LIVE PLAN") throw new Error("approval_confirmation_required:EXECUTE MARE LIVE PLAN");
  if (plan.status === "completed") return textToolResult({ ok: true, status: "completed", idempotent_replay: true, plan });
  if (plan.status === "failed" || plan.status === "reconciliation_required") throw new Error("plan_reconciliation_required");
  if (plan.status === "cancelled") throw new Error("plan_cancelled");
  if (plan.status === "executing") throw new Error("plan_already_executing");
  if (Date.parse(plan.expires_at) <= Date.now()) throw new Error("plan_expired");
  const capability = await resolveCapability(plan.capability_id, env);
  if (!capability?.available) throw new Error(`capability_no_longer_available:${capability?.missing.join(",") || "unknown"}`);

  plan.status = "executing";
  await storePlan(plan, env);
  try {
    let result: JsonObject;
    if (plan.capability_id === "tiktok.campaign.create") {
      result = await createTikTokCampaignSafe({
        ...plan.request,
        approval_confirmation: "CREATE TIKTOK CAMPAIGN PAUSED",
        idempotency_key: plan.plan_id,
      }, env);
    } else if (plan.capability_id === "tiktok.campaign.update") {
      const payload = object(plan.request.payload);
      const operationStatus = normalize(payload.operation_status).toUpperCase();
      const providerConfirmation = operationStatus === "ENABLE"
        ? "ENABLE TIKTOK CAMPAIGN"
        : operationStatus === "DISABLE"
          ? "PAUSE TIKTOK CAMPAIGN"
          : "UPDATE TIKTOK CAMPAIGN";
      result = await updateTikTokCampaignSafe({
        ...plan.request,
        approval_confirmation: providerConfirmation,
      }, env);
    } else {
      throw new Error("safe_tiktok_execute_router_not_implemented");
    }
    plan.status = "completed";
    plan.executed_at = new Date().toISOString();
    plan.result_summary = result;
    await storePlan(plan, env);
    return textToolResult({ plan_id: plan.plan_id, status: plan.status, result });
  } catch (error) {
    plan.status = "reconciliation_required";
    plan.error = error instanceof Error ? error.message : "tiktok_plan_execution_failed";
    await storePlan(plan, env);
    throw error;
  }
}

async function delegateAndReadJson(request: Request, env: SafeBusinessEnv): Promise<{ response: Response; body: JsonObject }> {
  const response = await handleMareBusinessMcpRequest(request, env as any);
  if (!response) throw new Error("business_mcp_handler_not_found");
  let body: JsonObject = {};
  try { body = await response.clone().json() as JsonObject; } catch { body = {}; }
  return { response, body };
}

export async function handleMareBusinessMcpSafeRequest(
  request: Request,
  env: SafeBusinessEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp-business" && url.pathname !== "/mcp-business/health") return null;
  if (url.pathname === "/mcp-business/health" || request.method !== "POST") {
    return handleMareBusinessMcpRequest(request, env as any);
  }

  let rpc: RpcRequest;
  try { rpc = await request.clone().json() as RpcRequest; } catch { return handleMareBusinessMcpRequest(request, env as any); }
  if (rpc.method !== "tools/call") return handleMareBusinessMcpRequest(request, env as any);
  if (!isAuthorized(request, env)) return handleMareBusinessMcpRequest(request, env as any);

  const params = object(rpc.params);
  const toolName = normalize(params.name);
  const args = object(params.arguments);

  try {
    if (toolName === "mare_capabilities") {
      const capabilities = filterCapabilityList(await resolvedCapabilities(env), args);
      return rpcToolResponse(request, rpc.id, textToolResult({ ok: true, generated_at: new Date().toISOString(), capabilities }));
    }

    if (toolName === "mare_describe") {
      const capability = await resolveCapability(normalize(args.capability_id), env);
      return rpcToolResponse(request, rpc.id, capability ? textToolResult({ ok: true, capability }) : toolFailure("capability_not_found"));
    }

    if (toolName === "mare_system_status") {
      const delegated = await delegateAndReadJson(request, env);
      const result = object(delegated.body.result);
      const structured = object(result.structuredContent);
      const providers = object(structured.providers);
      const tiktok = await tiktokSafeAuthorizationStatus(env);
      const capabilities = await resolvedCapabilities(env);
      const payload = {
        ...structured,
        capability_counts: {
          total: capabilities.length,
          implemented: capabilities.filter((item) => item.implemented).length,
          configured: capabilities.filter((item) => item.configured).length,
          available: capabilities.filter((item) => item.available).length,
        },
        providers: { ...providers, tiktok },
        hardening: {
          secure_tiktok_oauth_start: true,
          failed_live_plan_replay_blocked: true,
          complete_variant_pagination: true,
          correct_regular_and_sale_price_mapping: true,
        },
      };
      return rpcToolResponse(request, rpc.id, textToolResult(payload));
    }

    if (toolName === "mare_read") {
      const capabilityId = normalize(args.capability_id);
      const requestPayload = object(args.request);
      if (capabilityId === "shopify.catalog.read" || capabilityId === "shopify.catalog.export") {
        return rpcToolResponse(request, rpc.id, textToolResult(await readShopifyCatalogComplete(requestPayload, env)));
      }
      if (capabilityId === "tiktok.authorization.status") {
        return rpcToolResponse(request, rpc.id, textToolResult(await tiktokSafeAuthorizationStatus(env)));
      }
      if (capabilityId === "tiktok.campaign.read") {
        const capability = await resolveCapability(capabilityId, env);
        if (!capability?.available) return rpcToolResponse(request, rpc.id, toolFailure("capability_not_available", capability));
        return rpcToolResponse(request, rpc.id, textToolResult(await readTikTokCampaignsSafe(requestPayload, env)));
      }
    }

    if (toolName === "mare_prepare") {
      const capabilityId = normalize(args.capability_id);
      const requestPayload = object(args.request);
      const capability = await resolveCapability(capabilityId, env);
      if (["marketplace.feed.generate", "matrixify.catalog.generate", "tiktok.authorization.start"].includes(capabilityId)) {
        if (!capability?.available) return rpcToolResponse(request, rpc.id, toolFailure("capability_not_available", capability));
        return rpcToolResponse(request, rpc.id, await completeArtifactPlan(capability, requestPayload, env));
      }
      if (["tiktok.campaign.create", "tiktok.campaign.update"].includes(capabilityId)) {
        if (!capability?.available) return rpcToolResponse(request, rpc.id, toolFailure("capability_not_available", capability));
        return rpcToolResponse(request, rpc.id, await prepareTikTokWrite(capability, requestPayload, env));
      }
    }

    if (toolName === "mare_validate") {
      const plan = await loadPlan(normalize(args.plan_id), env);
      if (TIKTOK_CAPABILITIES.has(plan.capability_id)) {
        const capability = await resolveCapability(plan.capability_id, env);
        return rpcToolResponse(request, rpc.id, textToolResult({
          ok: true,
          plan,
          valid: plan.status === "prepared" && Date.parse(plan.expires_at) > Date.now() && Boolean(capability?.available),
          capability,
          required_confirmation: plan.risk === "live_write" ? "EXECUTE MARE LIVE PLAN" : "EXECUTE MARE PLAN",
          replay_blocked_after_failure: true,
        }));
      }
    }

    if (toolName === "mare_execute") {
      const plan = await loadPlan(normalize(args.plan_id), env);
      if (plan.status === "failed" || plan.status === "reconciliation_required") {
        return rpcToolResponse(request, rpc.id, toolFailure("plan_reconciliation_required", plan));
      }
      if (["tiktok.campaign.create", "tiktok.campaign.update"].includes(plan.capability_id)) {
        return rpcToolResponse(request, rpc.id, await executeTikTokPlan(plan, normalize(args.approval_confirmation), env));
      }
    }
  } catch (error) {
    return rpcToolResponse(request, rpc.id, toolFailure(error instanceof Error ? error.message : "safe_business_runtime_failed"));
  }

  return handleMareBusinessMcpRequest(request, env as any);
}
