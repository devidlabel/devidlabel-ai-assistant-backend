import { handleMareBusinessMcpFinalRequest } from "./mare-business-mcp-final.js";
import {
  createYouTubeAuthorizationUrl,
  readYouTubeAnalyticsSummary,
  readYouTubeChannel,
  readYouTubeSearchTerms,
  readYouTubeTrafficSources,
  readYouTubeVideoPerformance,
  youtubeAuthorizationStatus,
  type MareBusinessYouTubeEnv,
} from "./mare-business-youtube.js";

type JsonObject = Record<string, unknown>;

type YouTubeBusinessEnv = MareBusinessYouTubeEnv & {
  MARE_BUSINESS_ACCESS_TOKEN?: string;
  [key: string]: unknown;
};

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonObject;
};

type Capability = {
  id: string;
  provider: string;
  domain: string;
  operation: "read" | "prepare";
  risk: "read_only" | "artifact_only";
  implemented: boolean;
  configured: boolean;
  available: boolean;
  approval: "none";
  description: string;
  request_schema: JsonObject;
  missing: string[];
};

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

function isAuthorized(request: Request, env: YouTubeBusinessEnv): boolean {
  const expected = normalize(env.MARE_BUSINESS_ACCESS_TOKEN);
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : normalize(request.headers.get("X-MARE-BUSINESS-Key"));
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

function rpcResponse(request: Request, id: RpcRequest["id"], result: JsonObject): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), {
    status: 200,
    headers: responseHeaders(request),
  });
}

function schema(properties: JsonObject = {}, required: string[] = []): JsonObject {
  return { type: "object", properties, required, additionalProperties: false };
}

async function youtubeCapabilities(env: YouTubeBusinessEnv): Promise<Capability[]> {
  const status = await youtubeAuthorizationStatus(env);
  const appConfigured = status.app_configured === true && status.kv_store_configured === true;
  const authorized = status.authorized === true;
  const authMissing = [
    ...(status.app_configured === true ? [] : ["YouTube/Google OAuth client credentials"]),
    ...(status.kv_store_configured === true ? [] : ["SHOPIFY_TOKENS_KV"]),
  ];
  const readMissing = authorized ? [] : [...authMissing, "YouTube channel authorization"];
  const reportRequest = schema({
    days: { type: "integer", minimum: 1, maximum: 365 },
    start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    end_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  });

  return [
    {
      id: "youtube.authorization.status",
      provider: "youtube",
      domain: "content",
      operation: "read",
      risk: "read_only",
      implemented: true,
      configured: appConfigured,
      available: true,
      approval: "none",
      description: "Read YouTube OAuth configuration and authorization state without exposing tokens.",
      request_schema: schema(),
      missing: authMissing,
    },
    {
      id: "youtube.authorization.start",
      provider: "youtube",
      domain: "content",
      operation: "prepare",
      risk: "artifact_only",
      implemented: true,
      configured: appConfigured,
      available: appConfigured,
      approval: "none",
      description: "Create a short-lived read-only Google OAuth URL for the Devid Label YouTube channel.",
      request_schema: schema(),
      missing: authMissing,
    },
    {
      id: "youtube.channel.read",
      provider: "youtube",
      domain: "content",
      operation: "read",
      risk: "read_only",
      implemented: true,
      configured: authorized,
      available: authorized,
      approval: "none",
      description: "Read the authorized YouTube channel profile, statistics, uploads playlist and branding metadata.",
      request_schema: schema(),
      missing: readMissing,
    },
    {
      id: "youtube.analytics.summary",
      provider: "youtube",
      domain: "analytics",
      operation: "read",
      risk: "read_only",
      implemented: true,
      configured: authorized,
      available: authorized,
      approval: "none",
      description: "Read aggregate YouTube views, watch time, average view duration, engagement and subscriber movement.",
      request_schema: reportRequest,
      missing: readMissing,
    },
    {
      id: "youtube.video.performance",
      provider: "youtube",
      domain: "analytics",
      operation: "read",
      risk: "read_only",
      implemented: true,
      configured: authorized,
      available: authorized,
      approval: "none",
      description: "Rank videos by views and return watch time, engagement, subscriber impact and video metadata.",
      request_schema: schema({
        days: { type: "integer", minimum: 1, maximum: 365 },
        start_date: { type: "string" },
        end_date: { type: "string" },
        max_results: { type: "integer", minimum: 1, maximum: 100 },
      }),
      missing: readMissing,
    },
    {
      id: "youtube.traffic_sources",
      provider: "youtube",
      domain: "analytics",
      operation: "read",
      risk: "read_only",
      implemented: true,
      configured: authorized,
      available: authorized,
      approval: "none",
      description: "Read YouTube traffic-source mix including Shorts, Search, Suggested/related, browse, external and subscriber sources.",
      request_schema: reportRequest,
      missing: readMissing,
    },
    {
      id: "youtube.search_terms",
      provider: "youtube",
      domain: "analytics",
      operation: "read",
      risk: "read_only",
      implemented: true,
      configured: authorized,
      available: authorized,
      approval: "none",
      description: "Read the YouTube Search terms that generated the most views for the channel's top videos in the selected period.",
      request_schema: schema({
        days: { type: "integer", minimum: 1, maximum: 365 },
        start_date: { type: "string" },
        end_date: { type: "string" },
        max_results: { type: "integer", minimum: 1, maximum: 25 },
        video_limit: { type: "integer", minimum: 1, maximum: 500 },
      }),
      missing: readMissing,
    },
  ];
}

async function delegatedJson(request: Request, env: YouTubeBusinessEnv): Promise<{ response: Response; body: JsonObject }> {
  const response = await handleMareBusinessMcpFinalRequest(request.clone(), env as any);
  if (!response) throw new Error("business_mcp_handler_not_found");
  let body: JsonObject = {};
  try { body = await response.clone().json() as JsonObject; } catch { body = {}; }
  return { response, body };
}

function filteredCapabilities(capabilities: Capability[], args: JsonObject): Capability[] {
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

export async function handleMareBusinessYouTubeMcpRequest(
  request: Request,
  env: YouTubeBusinessEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp-business" || request.method !== "POST") return null;
  if (!isAuthorized(request, env)) return null;

  let rpc: RpcRequest;
  try { rpc = await request.clone().json() as RpcRequest; } catch { return null; }
  if (rpc.method !== "tools/call") return null;
  const params = object(rpc.params);
  const toolName = normalize(params.name);
  const args = object(params.arguments);

  try {
    const ownCapabilities = await youtubeCapabilities(env);

    if (toolName === "mare_capabilities") {
      const delegated = await delegatedJson(request, env);
      const result = object(delegated.body.result);
      const structured = object(result.structuredContent);
      const base = Array.isArray(structured.capabilities) ? structured.capabilities : [];
      const filteredOwn = filteredCapabilities(ownCapabilities, args);
      const merged = [
        ...base,
        ...filteredOwn.filter((item) => !base.some((candidate) => object(candidate).id === item.id)),
      ];
      return rpcResponse(request, rpc.id, textToolResult({
        ...structured,
        ok: true,
        generated_at: new Date().toISOString(),
        capabilities: merged,
      }));
    }

    if (toolName === "mare_describe") {
      const id = normalize(args.capability_id);
      const capability = ownCapabilities.find((item) => item.id === id);
      if (!capability) return null;
      return rpcResponse(request, rpc.id, textToolResult({ ok: true, capability }));
    }

    if (toolName === "mare_system_status") {
      const delegated = await delegatedJson(request, env);
      const result = object(delegated.body.result);
      const structured = object(result.structuredContent);
      const providers = object(structured.providers);
      const youtube = await youtubeAuthorizationStatus(env);
      const existingCounts = object(structured.capability_counts);
      const addTotal = ownCapabilities.length;
      const addImplemented = ownCapabilities.filter((item) => item.implemented).length;
      const addConfigured = ownCapabilities.filter((item) => item.configured).length;
      const addAvailable = ownCapabilities.filter((item) => item.available).length;
      return rpcResponse(request, rpc.id, textToolResult({
        ...structured,
        capability_counts: {
          total: Number(existingCounts.total || 0) + addTotal,
          implemented: Number(existingCounts.implemented || 0) + addImplemented,
          configured: Number(existingCounts.configured || 0) + addConfigured,
          available: Number(existingCounts.available || 0) + addAvailable,
        },
        providers: { ...providers, youtube },
      }));
    }

    if (toolName === "mare_read") {
      const capabilityId = normalize(args.capability_id);
      const requestPayload = object(args.request);
      const capability = ownCapabilities.find((item) => item.id === capabilityId);
      if (!capability || capability.operation !== "read") return null;
      if (!capability.available) return rpcResponse(request, rpc.id, toolFailure("capability_not_available", capability));

      if (capabilityId === "youtube.authorization.status") return rpcResponse(request, rpc.id, textToolResult(await youtubeAuthorizationStatus(env)));
      if (capabilityId === "youtube.channel.read") return rpcResponse(request, rpc.id, textToolResult(await readYouTubeChannel(requestPayload, env)));
      if (capabilityId === "youtube.analytics.summary") return rpcResponse(request, rpc.id, textToolResult(await readYouTubeAnalyticsSummary(requestPayload, env)));
      if (capabilityId === "youtube.video.performance") return rpcResponse(request, rpc.id, textToolResult(await readYouTubeVideoPerformance(requestPayload, env)));
      if (capabilityId === "youtube.traffic_sources") return rpcResponse(request, rpc.id, textToolResult(await readYouTubeTrafficSources(requestPayload, env)));
      if (capabilityId === "youtube.search_terms") return rpcResponse(request, rpc.id, textToolResult(await readYouTubeSearchTerms(requestPayload, env)));
    }

    if (toolName === "mare_prepare") {
      const capabilityId = normalize(args.capability_id);
      if (capabilityId !== "youtube.authorization.start") return null;
      const capability = ownCapabilities.find((item) => item.id === capabilityId);
      if (!capability?.available) return rpcResponse(request, rpc.id, toolFailure("capability_not_available", capability));
      const result = await createYouTubeAuthorizationUrl(env);
      return rpcResponse(request, rpc.id, textToolResult({
        ok: true,
        status: "completed",
        capability_id: capabilityId,
        external_write_performed: false,
        result,
      }));
    }
  } catch (error) {
    return rpcResponse(request, rpc.id, toolFailure(error instanceof Error ? error.message : "youtube_business_runtime_failed"));
  }

  return null;
}
