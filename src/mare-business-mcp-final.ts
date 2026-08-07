import { handleMareBusinessMcpSafeRequest } from "./mare-business-mcp-safe.js";
import { readShopifyCatalogComplete } from "./mare-business-shopify-complete.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";
import type { MareBusinessTikTokSafeEnv } from "./mare-business-tiktok-safe.js";

type JsonObject = Record<string, unknown>;

type KVNamespaceLike = {
  get(key: string): Promise<string | null>;
};

type DurableObjectStubLike = {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
};

type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
};

type FinalBusinessEnv = MareBusinessShopifyEnv & MareBusinessTikTokSafeEnv & {
  MARE_BUSINESS_ACCESS_TOKEN?: string;
  SHOPIFY_TOKENS_KV?: KVNamespaceLike;
  MARE_PLAN_COORDINATOR?: DurableObjectNamespaceLike;
  [key: string]: unknown;
};

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonObject;
};

const SENSITIVE_KEY_PATTERN = /(password|secret|access.?token|refresh.?token|api.?key|private.?key|credit.?card|customer.?email|customer.?phone)/i;
const MAX_CAPABILITY_REQUEST_BYTES = 400 * 1024;
const FULL_CATALOG_PRODUCT_LIMIT = 2500;
const TIKTOK_NAME_MARKER_RESERVE = 24;
const TIKTOK_MAX_CAMPAIGN_NAME = 512;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function timingSafeEqualText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function isAuthorized(request: Request, env: FinalBusinessEnv): boolean {
  const expected = normalize(env.MARE_BUSINESS_ACCESS_TOKEN);
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : normalize(request.headers.get("X-MARE-BUSINESS-Key"));
  return Boolean(expected) && timingSafeEqualText(expected, supplied);
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

function assertRequestSafe(payload: JsonObject): void {
  const serialized = JSON.stringify(payload);
  if (new TextEncoder().encode(serialized).byteLength > MAX_CAPABILITY_REQUEST_BYTES) throw new Error("capability_request_too_large");
  if (containsSensitiveKeys(payload)) throw new Error("credentials_or_customer_contact_data_not_accepted");
}

function responseHeaders(request: Request): HeadersInit {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "MCP-Protocol-Version": normalize(request.headers.get("MCP-Protocol-Version")) || "2025-06-18",
  };
}

function toolFailure(message: string, detail?: unknown): JsonObject {
  return {
    content: [{ type: "text", text: detail === undefined ? message : `${message}: ${JSON.stringify(detail)}` }],
    structuredContent: { error: message, detail: detail ?? null },
    isError: true,
  };
}

function rpcToolFailure(request: Request, id: RpcRequest["id"], message: string, detail?: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result: toolFailure(message, detail) }), {
    status: 200,
    headers: responseHeaders(request),
  });
}

function rebuildRequest(original: Request, rpc: RpcRequest): Request {
  return new Request(original.url, {
    method: "POST",
    headers: new Headers(original.headers),
    body: JSON.stringify(rpc),
  });
}

function planKey(planId: string): string {
  return `mare-business:plan:${planId}`;
}

async function planCapability(planId: string, env: FinalBusinessEnv): Promise<string> {
  if (!env.SHOPIFY_TOKENS_KV || !/^mbp_[A-Za-z0-9-]{20,80}$/.test(planId)) return "";
  const raw = await env.SHOPIFY_TOKENS_KV.get(planKey(planId));
  if (!raw) return "";
  try {
    return normalize((JSON.parse(raw) as JsonObject).capability_id);
  } catch {
    return "";
  }
}

async function coordinatorAction(
  env: FinalBusinessEnv,
  planId: string,
  action: "claim" | "complete" | "reconciliation_required" | "status",
  claimId?: string,
  detail?: string,
): Promise<{ ok: boolean; status: number; body: JsonObject }> {
  if (!env.MARE_PLAN_COORDINATOR) throw new Error("mare_plan_coordinator_not_configured");
  const durableId = env.MARE_PLAN_COORDINATOR.idFromName(planId);
  const stub = env.MARE_PLAN_COORDINATOR.get(durableId);
  const response = await stub.fetch("https://mare-plan-coordinator/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, plan_id: planId, ...(claimId ? { claim_id: claimId } : {}), ...(detail ? { detail } : {}) }),
  });
  let body: JsonObject = {};
  try { body = await response.json() as JsonObject; } catch { body = {}; }
  return { ok: response.ok && body.ok === true, status: response.status, body };
}

function delegatedToolFailed(responseBody: JsonObject): { failed: boolean; message: string } {
  if (responseBody.error) return { failed: true, message: normalize(object(responseBody.error).message) || "business_mcp_error" };
  const result = object(responseBody.result);
  if (result.isError === true) {
    const structured = object(result.structuredContent);
    return { failed: true, message: normalize(structured.error) || "tool_execution_failed" };
  }
  return { failed: false, message: "" };
}

async function strictCatalogPreflight(payload: JsonObject, env: FinalBusinessEnv): Promise<number> {
  const requestedLimit = payload.max_products === undefined
    ? FULL_CATALOG_PRODUCT_LIMIT
    : integer(payload.max_products, FULL_CATALOG_PRODUCT_LIMIT, 1, FULL_CATALOG_PRODUCT_LIMIT);
  const catalog = await readShopifyCatalogComplete({
    ...payload,
    max_products: requestedLimit,
    inline_limit: 0,
    include_csv: false,
  }, env);
  if (catalog.truncated === true) {
    throw new Error(`catalog_truncated_artifact_blocked:requested_limit_${requestedLimit}`);
  }
  return requestedLimit;
}

function normalizeTikTokCreatePayload(payload: JsonObject): JsonObject {
  const next = JSON.parse(JSON.stringify(payload)) as JsonObject;
  const campaignPayload = object(next.payload);
  const requestedName = normalize(campaignPayload.campaign_name);
  if (requestedName) {
    const maximumRequestedLength = TIKTOK_MAX_CAMPAIGN_NAME - TIKTOK_NAME_MARKER_RESERVE;
    campaignPayload.campaign_name = requestedName.slice(0, maximumRequestedLength);
    next.payload = campaignPayload;
  }
  return next;
}

export async function handleMareBusinessMcpFinalRequest(
  request: Request,
  env: FinalBusinessEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp-business" || request.method !== "POST") {
    return handleMareBusinessMcpSafeRequest(request, env as any);
  }

  let rpc: RpcRequest;
  try {
    rpc = await request.clone().json() as RpcRequest;
  } catch {
    return handleMareBusinessMcpSafeRequest(request, env as any);
  }
  if (rpc.method !== "tools/call" || !isAuthorized(request, env)) {
    return handleMareBusinessMcpSafeRequest(request, env as any);
  }

  const params = object(rpc.params);
  const toolName = normalize(params.name);
  const args = object(params.arguments);

  try {
    if (toolName === "mare_read" || toolName === "mare_prepare") {
      const payload = object(args.request);
      assertRequestSafe(payload);
    }

    if (toolName === "mare_prepare") {
      const capabilityId = normalize(args.capability_id);
      let payload = object(args.request);

      if (capabilityId === "marketplace.feed.generate" || capabilityId === "matrixify.catalog.generate") {
        const safeLimit = await strictCatalogPreflight(payload, env);
        payload = { ...payload, max_products: safeLimit };
      }

      if (capabilityId === "tiktok.campaign.create") {
        payload = normalizeTikTokCreatePayload(payload);
      }

      if (payload !== args.request) {
        const forwardedArgs = { ...args, request: payload };
        const forwardedRpc: RpcRequest = { ...rpc, params: { ...params, arguments: forwardedArgs } };
        return handleMareBusinessMcpSafeRequest(rebuildRequest(request, forwardedRpc), env as any);
      }
    }

    if (toolName === "mare_execute") {
      const planId = normalize(args.plan_id);
      const capabilityId = await planCapability(planId, env);
      if (capabilityId === "tiktok.campaign.create" || capabilityId === "tiktok.campaign.update") {
        if (normalize(args.approval_confirmation) !== "EXECUTE MARE LIVE PLAN") {
          return rpcToolFailure(request, rpc.id, "approval_confirmation_required:EXECUTE MARE LIVE PLAN");
        }
        const claim = await coordinatorAction(env, planId, "claim");
        if (!claim.ok) return rpcToolFailure(request, rpc.id, normalize(claim.body.error) || "plan_execution_claim_rejected", claim.body.ledger || null);
        const ledger = object(claim.body.ledger);
        const claimId = normalize(ledger.claim_id);
        if (!claimId) return rpcToolFailure(request, rpc.id, "plan_execution_claim_invalid");

        let delegated: Response;
        try {
          delegated = await handleMareBusinessMcpSafeRequest(request, env as any) as Response;
        } catch (error) {
          await coordinatorAction(env, planId, "reconciliation_required", claimId, error instanceof Error ? error.message : "delegate_failed");
          throw error;
        }

        let responseBody: JsonObject = {};
        try { responseBody = await delegated.clone().json() as JsonObject; } catch { responseBody = {}; }
        const failure = delegatedToolFailed(responseBody);
        if (failure.failed || !delegated.ok) {
          await coordinatorAction(env, planId, "reconciliation_required", claimId, failure.message || `http_${delegated.status}`);
        } else {
          await coordinatorAction(env, planId, "complete", claimId);
        }
        return delegated;
      }
    }
  } catch (error) {
    return rpcToolFailure(request, rpc.id, error instanceof Error ? error.message : "mare_business_final_guard_failed");
  }

  return handleMareBusinessMcpSafeRequest(request, env as any);
}
