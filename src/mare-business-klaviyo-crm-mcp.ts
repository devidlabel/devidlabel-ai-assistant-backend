import { handleMareBusinessMcpFinalRequest } from "./mare-business-mcp-final.js";
import {
  readKlaviyoAudienceOverview,
  readKlaviyoConsentAggregate,
  type KlaviyoCrmEnv,
} from "./mare-business-klaviyo-crm.js";

type JsonObject = Record<string, unknown>;
type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: JsonObject };
type KlaviyoBusinessEnv = KlaviyoCrmEnv & { MARE_BUSINESS_ACCESS_TOKEN?: string; [key: string]: unknown };

const CAPABILITIES = [
  {
    id: "klaviyo.crm.audiences.read",
    provider: "klaviyo",
    domain: "crm",
    operation: "read",
    risk: "read_only",
    implemented: true,
    approval: "none",
    description: "Read Klaviyo list and segment metadata with bounded optional audience counts. No individual contact records are returned.",
    request_schema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 160 },
        inline_limit: { type: "integer", minimum: 1, maximum: 100 },
        count_limit: { type: "integer", minimum: 0, maximum: 5 },
      },
      additionalProperties: false,
    },
  },
  {
    id: "klaviyo.crm.consent.aggregate",
    provider: "klaviyo",
    domain: "crm",
    operation: "read",
    risk: "read_only",
    implemented: true,
    approval: "none",
    description: "Read aggregate email-marketing eligibility and consent totals from Klaviyo without returning profile identifiers or contact data.",
    request_schema: {
      type: "object",
      properties: { max_records: { type: "integer", minimum: 100, maximum: 100000 } },
      additionalProperties: false,
    },
  },
] as const;

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

function isAuthorized(request: Request, env: KlaviyoBusinessEnv): boolean {
  const expected = normalize(env.MARE_BUSINESS_ACCESS_TOKEN);
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : normalize(request.headers.get("X-MARE-BUSINESS-Key"));
  return Boolean(expected) && timingSafeEqualText(expected, supplied);
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

function rpcResponse(request: Request, id: RpcRequest["id"], result: JsonObject): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), { status: 200, headers: responseHeaders(request) });
}

function capabilityRows(env: KlaviyoBusinessEnv): JsonObject[] {
  const configured = Boolean(normalize(env.KLAVIYO_PRIVATE_API_KEY));
  return CAPABILITIES.map((item) => ({
    ...item,
    configured,
    available: configured,
    missing: configured ? [] : ["KLAVIYO_PRIVATE_API_KEY with lists:read, segments:read and profiles:read scopes"],
    privacy: {
      individual_contact_data_returned: false,
      write_capability: false,
    },
  }));
}

function validateAudienceRequest(request: JsonObject): void {
  const allowed = new Set(["query", "inline_limit", "count_limit"]);
  for (const key of Object.keys(request)) if (!allowed.has(key)) throw new Error(`klaviyo_crm_request_field_not_allowed:${key}`);
  if (request.query !== undefined && typeof request.query !== "string") throw new Error("klaviyo_crm_query_must_be_string");
}

function validateConsentRequest(request: JsonObject): void {
  const allowed = new Set(["max_records"]);
  for (const key of Object.keys(request)) if (!allowed.has(key)) throw new Error(`klaviyo_crm_request_field_not_allowed:${key}`);
}

async function delegate(request: Request, env: KlaviyoBusinessEnv): Promise<Response> {
  const response = await handleMareBusinessMcpFinalRequest(request.clone(), env as any);
  if (!response) return new Response(JSON.stringify({ error: "business_mcp_handler_not_found" }), { status: 500, headers: responseHeaders(request) });
  return response;
}

async function augmentCapabilities(request: Request, rpc: RpcRequest, args: JsonObject, env: KlaviyoBusinessEnv): Promise<Response> {
  const base = await delegate(request, env);
  let body: JsonObject = {};
  try { body = await base.clone().json() as JsonObject; } catch { return base; }
  const result = object(body.result);
  if (result.isError === true || body.error) return base;
  const structured = object(result.structuredContent);
  const existing = Array.isArray(structured.capabilities) ? structured.capabilities as JsonObject[] : [];
  const provider = normalize(args.provider);
  const domain = normalize(args.domain);
  const availableOnly = args.available_only === true;
  const implementedOnly = args.implemented_only === true;
  const added = capabilityRows(env).filter((item) => {
    if (provider && item.provider !== provider) return false;
    if (domain && item.domain !== domain) return false;
    if (availableOnly && item.available !== true) return false;
    if (implementedOnly && item.implemented !== true) return false;
    return true;
  });
  const merged = [...existing];
  for (const item of added) if (!merged.some((row) => normalize(row.id) === normalize(item.id))) merged.push(item);
  return rpcResponse(request, rpc.id, textToolResult({ ...structured, capabilities: merged }));
}

export async function handleMareKlaviyoCrmMcpRequest(request: Request, env: KlaviyoBusinessEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp-business" || request.method !== "POST") return null;

  let rpc: RpcRequest;
  try { rpc = await request.clone().json() as RpcRequest; } catch { return null; }
  if (rpc.method !== "tools/call") return null;
  const params = object(rpc.params);
  const toolName = normalize(params.name);
  if (!["mare_capabilities", "mare_describe", "mare_read"].includes(toolName)) return null;
  if (!isAuthorized(request, env)) return null;
  const args = object(params.arguments);
  const capabilityId = normalize(args.capability_id);

  try {
    if (toolName === "mare_capabilities") return augmentCapabilities(request, rpc, args, env);

    const own = capabilityRows(env).find((item) => normalize(item.id) === capabilityId);
    if (!own) return null;

    if (toolName === "mare_describe") return rpcResponse(request, rpc.id, textToolResult({ ok: true, capability: own }));
    if (own.available !== true) return rpcResponse(request, rpc.id, toolFailure("capability_not_available", own));

    const payload = object(args.request);
    if (capabilityId === "klaviyo.crm.audiences.read") {
      validateAudienceRequest(payload);
      return rpcResponse(request, rpc.id, textToolResult(await readKlaviyoAudienceOverview(payload, env)));
    }
    if (capabilityId === "klaviyo.crm.consent.aggregate") {
      validateConsentRequest(payload);
      return rpcResponse(request, rpc.id, textToolResult(await readKlaviyoConsentAggregate(payload, env)));
    }
    return rpcResponse(request, rpc.id, toolFailure("capability_not_implemented"));
  } catch (error) {
    return rpcResponse(request, rpc.id, toolFailure(error instanceof Error ? error.message : "klaviyo_crm_read_failed"));
  }
}
