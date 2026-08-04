import { handleDailyPulseRequest } from "./daily-pulse-organic";
import { handleGa4ReportingRequest } from "./ga4-reporting";
import { handleGoogleAdsReportingRequest } from "./google-ads-reporting";
import { handleKlaviyoReportingRequest } from "./klaviyo-reporting";
import { handleMetaReportingRequest } from "./meta-reporting";
import { handleSearchConsoleReportingRequest } from "./search-console-reporting";
import { handleShopifyReportingRequest } from "./shopify-reporting";

type JsonObject = Record<string, unknown>;
type ToolHandler = (request: Request, env: any) => Promise<Response | null>;

type MareMcpEnv = {
  MARE_MCP_ACCESS_TOKEN?: string;
  DAILY_PULSE_ACCESS_TOKEN?: string;
  SHOPIFY_REPORT_ACCESS_TOKEN?: string;
  META_REPORT_ACCESS_TOKEN?: string;
  GOOGLE_ADS_REPORT_ACCESS_TOKEN?: string;
  GOOGLE_ORGANIC_REPORT_ACCESS_TOKEN?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
  [key: string]: unknown;
};

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonObject;
};

const SERVER_VERSION = "1.0.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const ALLOWED_ORIGINS = new Set([
  "https://chatgpt.com",
  "https://www.chatgpt.com",
  "https://chat.openai.com",
]);

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const TOOLS = [
  {
    name: "mare_system_health",
    title: "MARE system health",
    description: "Checks whether Shopify, Meta, Google Ads, GA4, Search Console, Klaviyo and the Daily Pulse are configured and reachable. Read-only and contains no customer PII.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_daily_pulse",
    title: "MARE Daily Pulse",
    description: "Returns the executive commerce pulse for yesterday and the last 7 complete days, combining Shopify, paid media, GA4, Search Console and Klaviyo. Shopify remains the source of truth for revenue.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_shopify_commerce",
    title: "Shopify commerce report",
    description: "Returns PII-free Shopify commerce metrics, COGS proxy, contribution proxy and source/vendor breakdowns for a selected completed period.",
    inputSchema: {
      type: "object",
      properties: {
        timeframe: {
          type: "string",
          enum: ["yesterday", "last_7_days", "last_14_days", "month_to_yesterday"],
          description: "Completed reporting period in Europe/Rome timezone.",
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_paid_media",
    title: "Meta and Google Ads report",
    description: "Returns read-only campaign reporting from Meta Ads and Google Ads for the selected completed period. Platform conversions are attribution signals, not consolidated revenue.",
    inputSchema: {
      type: "object",
      properties: {
        timeframe: {
          type: "string",
          enum: ["yesterday", "last_7_days", "last_14_days", "month_to_yesterday"],
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_ga4",
    title: "GA4 traffic and funnel report",
    description: "Returns GA4 users, sessions, landing pages, source/medium, campaigns, devices, countries and the ecommerce event funnel for a selected completed period.",
    inputSchema: {
      type: "object",
      properties: {
        timeframe: {
          type: "string",
          enum: ["yesterday", "last_7_days", "last_14_days", "last_30_days", "month_to_yesterday"],
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_ga4_realtime",
    title: "GA4 realtime overview",
    description: "Returns the current GA4 realtime aggregate by country. Read-only and contains no user-level data.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_search_console",
    title: "Google Search Console report",
    description: "Returns finalized Search Console totals, top queries, pages, devices and countries. Default data lag is applied to avoid incomplete SEO data.",
    inputSchema: {
      type: "object",
      properties: {
        timeframe: {
          type: "string",
          enum: ["last_7_days", "last_28_days", "last_90_days", "month_to_date"],
        },
        top_rows: {
          type: "integer",
          minimum: 5,
          maximum: 100,
          description: "Maximum number of rows retained for query/page tables. Default 30.",
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "mare_klaviyo",
    title: "Klaviyo campaign and flow report",
    description: "Returns read-only Klaviyo campaign and flow performance for a completed period. Klaviyo-attributed revenue must not be added to Shopify revenue.",
    inputSchema: {
      type: "object",
      properties: {
        timeframe: {
          type: "string",
          enum: ["yesterday", "last_7_days", "last_30_days"],
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
] as const;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function timingSafeEqualText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function configuredToken(env: MareMcpEnv): string {
  return normalize(env.MARE_MCP_ACCESS_TOKEN) || normalize(env.DAILY_PULSE_ACCESS_TOKEN);
}

function suppliedToken(request: Request): string {
  const authorization = request.headers.get("Authorization") || "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return normalize(request.headers.get("X-MARE-MCP-Key"));
}

function isAuthorized(request: Request, env: MareMcpEnv): boolean {
  const expected = configuredToken(env);
  return Boolean(expected) && timingSafeEqualText(suppliedToken(request), expected);
}

function isAllowedOrigin(request: Request): boolean {
  const origin = normalize(request.headers.get("Origin"));
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function protocolVersion(request: Request, rpc?: RpcRequest): string {
  const requested = normalize(rpc?.params?.protocolVersion);
  return requested || normalize(request.headers.get("MCP-Protocol-Version")) || DEFAULT_PROTOCOL_VERSION;
}

function responseHeaders(version = DEFAULT_PROTOCOL_VERSION): HeadersInit {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "MCP-Protocol-Version": version,
  };
}

function rpcResult(id: RpcRequest["id"], result: unknown, version: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), {
    status: 200,
    headers: responseHeaders(version),
  });
}

function rpcError(id: RpcRequest["id"], code: number, message: string, status = 200, data?: unknown, version = DEFAULT_PROTOCOL_VERSION): Response {
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
      "WWW-Authenticate": "Bearer realm=\"MARE Commerce OS MCP\"",
    },
  });
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function pickEnum(value: unknown, allowed: readonly string[], fallback: string): string {
  const candidate = normalize(value);
  return allowed.includes(candidate) ? candidate : fallback;
}

function trimValue(value: unknown, depth = 0, maxArray = 30): unknown {
  if (depth > 7) return "[truncated]";
  if (typeof value === "string") return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, maxArray).map((item) => trimValue(item, depth + 1, maxArray));
  if (value && typeof value === "object") {
    const output: JsonObject = {};
    for (const [key, item] of Object.entries(value as JsonObject)) {
      output[key] = trimValue(item, depth + 1, maxArray);
    }
    return output;
  }
  return value;
}

function toolResult(payload: unknown): JsonObject {
  const structuredContent = trimValue(payload);
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: false,
  };
}

function toolFailure(message: string, detail?: unknown): JsonObject {
  return {
    content: [{ type: "text", text: detail === undefined ? message : `${message}: ${JSON.stringify(trimValue(detail))}` }],
    isError: true,
  };
}

function reportToken(env: MareMcpEnv, kind: "daily" | "shopify" | "meta" | "google" | "organic" | "klaviyo"): string {
  if (kind === "daily") return normalize(env.DAILY_PULSE_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);
  if (kind === "shopify") return normalize(env.SHOPIFY_REPORT_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN) || normalize(env.DAILY_PULSE_ACCESS_TOKEN);
  if (kind === "meta") return normalize(env.META_REPORT_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN) || normalize(env.DAILY_PULSE_ACCESS_TOKEN);
  if (kind === "google") return normalize(env.GOOGLE_ADS_REPORT_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN) || normalize(env.DAILY_PULSE_ACCESS_TOKEN);
  if (kind === "organic") return normalize(env.GOOGLE_ORGANIC_REPORT_ACCESS_TOKEN) || normalize(env.GOOGLE_ADS_REPORT_ACCESS_TOKEN) || normalize(env.DAILY_PULSE_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);
  return normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN) || normalize(env.DAILY_PULSE_ACCESS_TOKEN);
}

async function invoke(handler: ToolHandler, path: string, token: string, env: MareMcpEnv, overrides: JsonObject = {}): Promise<JsonObject> {
  if (!token) throw new Error("internal_report_token_not_configured");
  const response = await handler(new Request(`https://internal.mare${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  }), { ...env, ...overrides });
  if (!response) throw new Error("internal_handler_not_found");
  const body = await response.json() as JsonObject;
  if (!response.ok || body.ok === false) {
    const error = new Error(normalize(body.error) || normalize(body.message) || `upstream_${response.status}`);
    (error as Error & { status?: number; detail?: unknown }).status = response.status;
    (error as Error & { status?: number; detail?: unknown }).detail = body;
    throw error;
  }
  return body;
}

function withoutShopifyOrders(body: JsonObject): JsonObject {
  const { orders: _orders, ...safe } = body;
  return safe;
}

function limitSearchConsole(body: JsonObject, topRows: number): JsonObject {
  const limitTable = (value: unknown): unknown => {
    const table = asObject(value);
    return { ...table, rows: Array.isArray(table.rows) ? table.rows.slice(0, topRows) : [] };
  };
  return {
    ...body,
    daily: limitTable(body.daily),
    queries: limitTable(body.queries),
    pages: limitTable(body.pages),
    devices: limitTable(body.devices),
    countries: limitTable(body.countries),
  };
}

async function systemHealth(env: MareMcpEnv): Promise<JsonObject> {
  const calls: Array<[string, ToolHandler, string]> = [
    ["daily_pulse", handleDailyPulseRequest, "/internal/daily-pulse/health"],
    ["shopify", handleShopifyReportingRequest, "/internal/shopify/health"],
    ["meta", handleMetaReportingRequest, "/internal/meta/health"],
    ["google_ads", handleGoogleAdsReportingRequest, "/internal/google-ads/health"],
    ["ga4", handleGa4ReportingRequest, "/internal/ga4/health"],
    ["search_console", handleSearchConsoleReportingRequest, "/internal/search-console/health"],
    ["klaviyo", handleKlaviyoReportingRequest, "/internal/klaviyo/health"],
  ];
  const entries = await Promise.all(calls.map(async ([name, handler, path]) => {
    try {
      const response = await handler(new Request(`https://internal.mare${path}`), env);
      const body = response ? await response.json() as JsonObject : { ok: false, error: "handler_not_found" };
      return [name, { status: response?.status || 500, ...body }] as const;
    } catch (error) {
      return [name, { ok: false, error: error instanceof Error ? error.message : "health_check_failed" }] as const;
    }
  }));
  return { generated_at: new Date().toISOString(), services: Object.fromEntries(entries) };
}

async function callTool(name: string, args: JsonObject, env: MareMcpEnv): Promise<JsonObject> {
  if (name === "mare_system_health") return toolResult(await systemHealth(env));

  if (name === "mare_daily_pulse") {
    const token = reportToken(env, "daily");
    const body = await invoke(handleDailyPulseRequest, "/internal/daily-pulse/report", token, env, {
      DAILY_PULSE_ACCESS_TOKEN: token,
      SHOPIFY_REPORT_ACCESS_TOKEN: reportToken(env, "shopify"),
    });
    return toolResult(body);
  }

  if (name === "mare_shopify_commerce") {
    const timeframe = pickEnum(args.timeframe, ["yesterday", "last_7_days", "last_14_days", "month_to_yesterday"], "last_7_days");
    const token = reportToken(env, "shopify");
    const body = await invoke(handleShopifyReportingRequest, `/internal/shopify/report?timeframe=${encodeURIComponent(timeframe)}`, token, env, {
      SHOPIFY_REPORT_ACCESS_TOKEN: token,
    });
    return toolResult(withoutShopifyOrders(body));
  }

  if (name === "mare_paid_media") {
    const timeframe = pickEnum(args.timeframe, ["yesterday", "last_7_days", "last_14_days", "month_to_yesterday"], "last_7_days");
    const metaToken = reportToken(env, "meta");
    const googleToken = reportToken(env, "google");
    const [meta, google_ads] = await Promise.all([
      invoke(handleMetaReportingRequest, `/internal/meta/report?timeframe=${encodeURIComponent(timeframe)}&level=campaign&daily=0`, metaToken, env),
      invoke(handleGoogleAdsReportingRequest, `/internal/google-ads/report?timeframe=${encodeURIComponent(timeframe)}`, googleToken, env),
    ]);
    return toolResult({ timeframe, meta, google_ads, attribution_note: "Platform conversions overlap and are not consolidated revenue." });
  }

  if (name === "mare_ga4") {
    const timeframe = pickEnum(args.timeframe, ["yesterday", "last_7_days", "last_14_days", "last_30_days", "month_to_yesterday"], "last_7_days");
    const token = reportToken(env, "organic");
    const body = await invoke(handleGa4ReportingRequest, `/internal/ga4/report?timeframe=${encodeURIComponent(timeframe)}`, token, env);
    return toolResult(body);
  }

  if (name === "mare_ga4_realtime") {
    const token = reportToken(env, "organic");
    return toolResult(await invoke(handleGa4ReportingRequest, "/internal/ga4/realtime", token, env));
  }

  if (name === "mare_search_console") {
    const timeframe = pickEnum(args.timeframe, ["last_7_days", "last_28_days", "last_90_days", "month_to_date"], "last_28_days");
    const topRows = integer(args.top_rows, 30, 5, 100);
    const token = reportToken(env, "organic");
    const body = await invoke(handleSearchConsoleReportingRequest, `/internal/search-console/report?timeframe=${encodeURIComponent(timeframe)}`, token, env);
    return toolResult(limitSearchConsole(body, topRows));
  }

  if (name === "mare_klaviyo") {
    const timeframe = pickEnum(args.timeframe, ["yesterday", "last_7_days", "last_30_days"], "last_7_days");
    const token = reportToken(env, "klaviyo");
    const body = await invoke(handleKlaviyoReportingRequest, `/internal/klaviyo/report?timeframe=${encodeURIComponent(timeframe)}`, token, env);
    return toolResult(body);
  }

  return toolFailure(`Unknown tool: ${name}`);
}

export async function handleMareMcpRequest(request: Request, env: MareMcpEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp" && url.pathname !== "/mcp/health") return null;

  if (!isAllowedOrigin(request)) {
    return new Response(JSON.stringify({ error: "origin_not_allowed" }), {
      status: 403,
      headers: responseHeaders(),
    });
  }

  if (url.pathname === "/mcp/health") {
    return new Response(JSON.stringify({
      ok: true,
      service: "mare_commerce_os_mcp",
      version: SERVER_VERSION,
      transport: "streamable_http",
      configured: Boolean(configuredToken(env)),
      read_only: true,
      tools: TOOLS.length,
    }), { status: 200, headers: responseHeaders() });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": request.headers.get("Origin") || "https://chatgpt.com",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, X-MARE-MCP-Key",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Max-Age": "600",
      },
    });
  }

  if (!isAuthorized(request, env)) return authError();

  if (request.method === "GET") {
    return new Response(JSON.stringify({ error: "sse_not_supported", hint: "Use Streamable HTTP POST." }), {
      status: 405,
      headers: { ...responseHeaders(), Allow: "POST, OPTIONS" },
    });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...responseHeaders(), Allow: "POST, OPTIONS" },
    });
  }

  let rpc: RpcRequest;
  try {
    rpc = await request.json() as RpcRequest;
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }

  const version = protocolVersion(request, rpc);
  if (rpc.jsonrpc !== "2.0" || !normalize(rpc.method)) {
    return rpcError(rpc.id, -32600, "Invalid Request", 400, undefined, version);
  }

  if (rpc.method === "notifications/initialized" || rpc.method === "notifications/cancelled") {
    return new Response(null, { status: 202, headers: { "Cache-Control": "no-store", "MCP-Protocol-Version": version } });
  }

  if (rpc.method === "initialize") {
    return rpcResult(rpc.id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "MARE Commerce OS", version: SERVER_VERSION },
      instructions: "Read-only business intelligence tools for M.A.R.E. S.R.L. and Devid Label. Treat Shopify as the revenue source of truth and platform-attributed conversions as non-additive signals.",
    }, version);
  }

  if (rpc.method === "ping") return rpcResult(rpc.id, {}, version);

  if (rpc.method === "tools/list") {
    return rpcResult(rpc.id, { tools: TOOLS }, version);
  }

  if (rpc.method === "tools/call") {
    const params = asObject(rpc.params);
    const name = normalize(params.name);
    if (!name) return rpcError(rpc.id, -32602, "Missing tool name", 200, undefined, version);
    try {
      const result = await callTool(name, asObject(params.arguments), env);
      return rpcResult(rpc.id, result, version);
    } catch (error) {
      const detail = error && typeof error === "object" && "detail" in error ? (error as { detail?: unknown }).detail : undefined;
      return rpcResult(rpc.id, toolFailure(error instanceof Error ? error.message : "Tool execution failed", detail), version);
    }
  }

  return rpcError(rpc.id, -32601, "Method not found", 200, { method: rpc.method }, version);
}
