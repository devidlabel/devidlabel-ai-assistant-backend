import { DurableObject } from "cloudflare:workers";
import { handleMareBusinessMcpFinalRequest } from "./mare-business-mcp-final.js";

type JsonObject = Record<string, unknown>;

type DurableStorageLike = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
};

type DurableStateLike = {
  storage: DurableStorageLike;
};

type DurableObjectStubLike = {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
};

type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
};

type AutonomyEnv = {
  MARE_BUSINESS_ACCESS_TOKEN?: string;
  MARE_AUTONOMY_RUNNER?: DurableObjectNamespaceLike;
  [key: string]: unknown;
};

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonObject;
};

type AutonomyStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

type AutonomyJob = {
  job_id: string;
  capability_id: string;
  request: JsonObject;
  policy: "auto_log";
  status: AutonomyStatus;
  attempts: number;
  max_attempts: number;
  created_at: string;
  updated_at: string;
  next_attempt_at?: string;
  plan_id?: string;
  completed_at?: string;
  result?: JsonObject;
  error?: string;
};

const SERVER_VERSION = "0.3.0";
const MAX_REQUEST_BYTES = 320 * 1024;
const MAX_ATTEMPTS = 3;
const BASE_RETRY_MS = 15_000;
const AUTO_CAPABILITIES = new Set([
  "klaviyo.campaign.draft.create",
  "klaviyo.campaign.draft.update",
  "github.pull_request.create",
  "shopify.metafields.update_existing",
]);

const AUTONOMY_TOOLS = [
  {
    name: "mare_autonomy_submit",
    title: "Run a safe MARE action autonomously",
    description: "Queues an allowlisted reversible write for persistent server-side execution. Supports Klaviyo draft create/update, GitHub draft PR creation and bounded updates of existing Shopify custom metafields. Every autonomous write goes through the standard immutable Business OS plan and execution coordinator. Jobs continue independently of the chat session, retry bounded transient failures and log the final result. It never sends email, activates ads, merges PRs, creates/deletes Shopify metafields or performs unapproved live writes.",
    inputSchema: {
      type: "object",
      properties: {
        capability_id: {
          type: "string",
          enum: [
            "klaviyo.campaign.draft.create",
            "klaviyo.campaign.draft.update",
            "github.pull_request.create",
            "shopify.metafields.update_existing",
          ],
        },
        request: {
          type: "object",
          description: "Capability-specific request. For shopify.metafields.update_existing pass metafields: 1-25 items with owner_id (Product/ProductVariant GID), namespace custom, key and string value. Shopify targets must already exist; the worker reads compareDigest before the atomic write and verifies readback afterward.",
          additionalProperties: true,
        },
      },
      required: ["capability_id", "request"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "mare_autonomy_status",
    title: "Read autonomous MARE job status",
    description: "Returns the durable status, attempts, immutable Business OS plan id and final result for an autonomous MARE job.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", pattern: "^maj_[A-Za-z0-9-]{20,80}$" },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "mare_autonomy_policy",
    title: "Read MARE autonomy policy",
    description: "Returns the autonomous capability allowlist and actions that still require human approval.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
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

function suppliedToken(request: Request): string {
  const authorization = request.headers.get("Authorization") || "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return normalize(request.headers.get("X-MARE-BUSINESS-Key"));
}

function isAuthorized(request: Request, env: AutonomyEnv): boolean {
  const expected = normalize(env.MARE_BUSINESS_ACCESS_TOKEN);
  return Boolean(expected) && timingSafeEqualText(expected, suppliedToken(request));
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

function policyPayload(): JsonObject {
  return {
    ok: true,
    version: "p2",
    model: "risk_tiered_autonomy",
    autonomous_mode: "AUTO+LOG",
    autonomous_capabilities: Array.from(AUTO_CAPABILITIES),
    approval_required: [
      "send or schedule Klaviyo campaigns",
      "activate or materially increase paid-media spend",
      "publish live product-media replacements",
      "create or delete Shopify metafields",
      "merge pull requests",
      "bulk destructive writes",
      "delete or irreversible provider actions",
    ],
    shopify_guardrails: {
      existing_metafields_only: true,
      namespace_allowlist: ["custom"],
      owner_type_allowlist: ["Product", "ProductVariant"],
      maximum_items_per_atomic_write: 25,
      compare_and_set: true,
      read_before_write: true,
      read_after_write: true,
      create_allowed: false,
      delete_allowed: false,
    },
    guarantees: {
      durable_execution: true,
      bounded_retries: true,
      immutable_provider_plan: true,
      coordinated_plan_ledger: true,
      provider_idempotency_reused_when_supported: true,
      external_write_on_submit: false,
    },
  };
}

function validateJobId(value: string): boolean {
  return /^maj_[A-Za-z0-9-]{20,80}$/.test(value);
}

function assertRequestSize(payload: JsonObject): void {
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  if (bytes > MAX_REQUEST_BYTES) throw new Error("autonomy_request_too_large");
}

function extractToolError(body: JsonObject): string | null {
  if (body.error) {
    const rpcError = object(body.error);
    return normalize(rpcError.message) || "business_mcp_rpc_error";
  }
  const result = object(body.result);
  if (result.isError === true) {
    const structured = object(result.structuredContent);
    return normalize(structured.error) || "business_mcp_tool_error";
  }
  return null;
}

async function callBusinessTool(env: AutonomyEnv, name: string, args: JsonObject): Promise<JsonObject> {
  const token = normalize(env.MARE_BUSINESS_ACCESS_TOKEN);
  if (!token) throw new Error("mare_business_access_token_not_configured");
  const rpc: RpcRequest = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name, arguments: args },
  };
  const request = new Request("https://internal.mare/mcp-business", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify(rpc),
  });
  const response = await handleMareBusinessMcpFinalRequest(request, env as any);
  if (!response) throw new Error("business_mcp_handler_not_found");
  let body: JsonObject = {};
  try { body = await response.json() as JsonObject; } catch { throw new Error("business_mcp_invalid_json"); }
  const error = extractToolError(body);
  if (!response.ok || error) throw new Error(error || `business_mcp_http_${response.status}`);
  return object(object(body.result).structuredContent);
}

function requestForJob(job: AutonomyJob): JsonObject {
  const payload = { ...job.request };
  if (job.capability_id === "klaviyo.campaign.draft.create" && !normalize(payload.idempotency_key)) {
    payload.idempotency_key = `mare-autonomy-${job.job_id}`.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 128);
  }
  return payload;
}

async function executeAutonomousJob(job: AutonomyJob, env: AutonomyEnv): Promise<{ planId: string; result: JsonObject }> {
  if (!AUTO_CAPABILITIES.has(job.capability_id)) throw new Error("capability_not_autonomous");

  const prepared = await callBusinessTool(env, "mare_prepare", {
    capability_id: job.capability_id,
    request: requestForJob(job),
  });
  const plan = object(prepared.plan);
  const planId = normalize(plan.plan_id);
  if (!planId) throw new Error("autonomy_prepare_missing_plan_id");

  const validated = await callBusinessTool(env, "mare_validate", { plan_id: planId });
  if (validated.valid !== true) throw new Error("autonomy_plan_validation_failed");

  const executed = await callBusinessTool(env, "mare_execute", {
    plan_id: planId,
    approval_confirmation: "EXECUTE MARE PLAN",
  });
  return { planId, result: executed };
}

function isTransientError(message: string): boolean {
  return /(429|rate.?limit|timeout|timed.?out|temporar|unavailable|network|fetch|too many|http_5\d\d|request_failed_5\d\d)/i.test(message);
}

function retryDelay(attempt: number): number {
  return Math.min(BASE_RETRY_MS * Math.max(1, 2 ** (attempt - 1)), 120_000);
}

function audit(event: string, job: AutonomyJob, detail?: string): void {
  console.info(JSON.stringify({
    audit_schema: "mare_autonomy_p2",
    event,
    generated_at: new Date().toISOString(),
    job_id: job.job_id,
    capability_id: job.capability_id,
    status: job.status,
    attempts: job.attempts,
    ...(job.plan_id ? { plan_id: job.plan_id } : {}),
    ...(detail ? { detail: detail.slice(0, 1000) } : {}),
  }));
}

export class MareAutonomyRunner extends DurableObject<Record<string, unknown>> {
  private readonly runtimeEnv: AutonomyEnv;

  constructor(ctx: DurableStateLike, env: AutonomyEnv) {
    super(ctx as any, env as any);
    this.runtimeEnv = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405 });
    let body: JsonObject;
    try { body = await request.json() as JsonObject; } catch {
      return new Response(JSON.stringify({ ok: false, error: "invalid_json" }), { status: 400 });
    }
    const action = normalize(body.action);
    const jobId = normalize(body.job_id);
    if (!validateJobId(jobId)) return new Response(JSON.stringify({ ok: false, error: "invalid_job_id" }), { status: 400 });

    if (action === "enqueue") {
      const existing = await this.ctx.storage.get<AutonomyJob>("job");
      if (existing) return new Response(JSON.stringify({ ok: true, idempotent_replay: true, job: existing }), { status: 200 });
      const capabilityId = normalize(body.capability_id);
      const payload = object(body.request);
      if (!AUTO_CAPABILITIES.has(capabilityId)) return new Response(JSON.stringify({ ok: false, error: "capability_not_autonomous" }), { status: 400 });
      try { assertRequestSize(payload); } catch (error) {
        return new Response(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "invalid_request" }), { status: 413 });
      }
      const now = new Date();
      const job: AutonomyJob = {
        job_id: jobId,
        capability_id: capabilityId,
        request: payload,
        policy: "auto_log",
        status: "queued",
        attempts: 0,
        max_attempts: MAX_ATTEMPTS,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        next_attempt_at: now.toISOString(),
      };
      await this.ctx.storage.put("job", job);
      await this.ctx.storage.setAlarm(Date.now() + 100);
      audit("queued", job);
      return new Response(JSON.stringify({ ok: true, job }), { status: 202, headers: { "Content-Type": "application/json" } });
    }

    if (action === "status") {
      const job = await this.ctx.storage.get<AutonomyJob>("job");
      return new Response(JSON.stringify({ ok: true, job: job || null }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ ok: false, error: "unknown_action" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<AutonomyJob>("job");
    if (!job || ["completed", "failed", "cancelled"].includes(job.status)) return;

    job.status = "running";
    job.attempts += 1;
    job.updated_at = new Date().toISOString();
    delete job.next_attempt_at;
    await this.ctx.storage.put("job", job);
    audit("started", job);

    try {
      const execution = await executeAutonomousJob(job, this.runtimeEnv);
      job.plan_id = execution.planId;
      job.result = execution.result;
      job.status = "completed";
      job.completed_at = new Date().toISOString();
      job.updated_at = job.completed_at;
      delete job.error;
      await this.ctx.storage.put("job", job);
      audit("completed", job);
    } catch (error) {
      const message = error instanceof Error ? error.message : "autonomy_execution_failed";
      job.error = message.slice(0, 2000);
      job.updated_at = new Date().toISOString();
      if (job.attempts < job.max_attempts && isTransientError(message)) {
        const delay = retryDelay(job.attempts);
        job.status = "queued";
        job.next_attempt_at = new Date(Date.now() + delay).toISOString();
        await this.ctx.storage.put("job", job);
        await this.ctx.storage.setAlarm(Date.now() + delay);
        audit("retry_scheduled", job, message);
        return;
      }
      job.status = "failed";
      await this.ctx.storage.put("job", job);
      audit("failed", job, message);
    }
  }
}

async function delegateDiscovery(request: Request, env: AutonomyEnv): Promise<Response | null> {
  return handleMareBusinessMcpFinalRequest(request.clone(), env as any);
}

async function augmentDiscovery(request: Request, rpc: RpcRequest, env: AutonomyEnv): Promise<Response | null> {
  const delegated = await delegateDiscovery(request, env);
  if (!delegated) return null;
  let body: JsonObject;
  try { body = await delegated.clone().json() as JsonObject; } catch { return delegated; }
  const result = object(body.result);

  if (rpc.method === "tools/list") {
    const baseTools = Array.isArray(result.tools) ? result.tools : [];
    const tools = [...baseTools];
    for (const tool of AUTONOMY_TOOLS) {
      if (!tools.some((candidate) => object(candidate).name === tool.name)) tools.push(tool as unknown as JsonObject);
    }
    return new Response(JSON.stringify({ ...body, result: { ...result, tools } }), {
      status: delegated.status,
      headers: responseHeaders(request),
    });
  }

  if (rpc.method === "initialize") {
    const instructions = normalize(result.instructions);
    const autonomyInstruction = " For reversible low-risk operations, prefer mare_autonomy_submit for Klaviyo draft create/update, GitHub draft PR creation, and updates to already-existing Shopify custom metafields on products or variants. These jobs are AUTO+LOG, persist independently of the chat session, and must not ask the user for an execution confirmation. All autonomous writes still pass through the immutable Business OS plan, validation and execution coordinator. Shopify metafield autonomy is update-only with compareDigest CAS and readback; creation/deletion is not allowed. Sending email, activating ads, merging PRs, destructive writes and other live actions still require explicit approval.";
    return new Response(JSON.stringify({ ...body, result: { ...result, instructions: `${instructions}${autonomyInstruction}`.trim() } }), {
      status: delegated.status,
      headers: responseHeaders(request),
    });
  }

  return delegated;
}

async function submitJob(request: Request, env: AutonomyEnv, args: JsonObject): Promise<JsonObject> {
  if (!env.MARE_AUTONOMY_RUNNER) return toolFailure("mare_autonomy_runner_not_configured");
  const capabilityId = normalize(args.capability_id);
  const payload = object(args.request);
  if (!AUTO_CAPABILITIES.has(capabilityId)) return toolFailure("capability_not_autonomous", policyPayload());
  try { assertRequestSize(payload); } catch (error) {
    return toolFailure(error instanceof Error ? error.message : "autonomy_request_invalid");
  }
  const jobId = `maj_${crypto.randomUUID()}`;
  const durableId = env.MARE_AUTONOMY_RUNNER.idFromName(jobId);
  const stub = env.MARE_AUTONOMY_RUNNER.get(durableId);
  const response = await stub.fetch("https://mare-autonomy/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "enqueue", job_id: jobId, capability_id: capabilityId, request: payload }),
  });
  let body: JsonObject = {};
  try { body = await response.json() as JsonObject; } catch { body = {}; }
  if (!response.ok && response.status !== 202) return toolFailure(normalize(body.error) || `autonomy_enqueue_failed_${response.status}`, body);
  return textToolResult({
    ok: true,
    status: "queued",
    job_id: jobId,
    capability_id: capabilityId,
    policy: "AUTO+LOG",
    external_write_performed_on_submit: false,
    durable_execution: true,
    coordinated_plan_ledger: true,
    status_tool: "mare_autonomy_status",
  });
}

async function readJobStatus(env: AutonomyEnv, args: JsonObject): Promise<JsonObject> {
  if (!env.MARE_AUTONOMY_RUNNER) return toolFailure("mare_autonomy_runner_not_configured");
  const jobId = normalize(args.job_id);
  if (!validateJobId(jobId)) return toolFailure("invalid_job_id");
  const durableId = env.MARE_AUTONOMY_RUNNER.idFromName(jobId);
  const stub = env.MARE_AUTONOMY_RUNNER.get(durableId);
  const response = await stub.fetch("https://mare-autonomy/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "status", job_id: jobId }),
  });
  let body: JsonObject = {};
  try { body = await response.json() as JsonObject; } catch { body = {}; }
  if (!response.ok) return toolFailure(normalize(body.error) || `autonomy_status_failed_${response.status}`, body);
  return textToolResult(body);
}

export async function handleMareAutonomyMcpRequest(request: Request, env: AutonomyEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp-business" || request.method !== "POST") return null;

  let rpc: RpcRequest;
  try { rpc = await request.clone().json() as RpcRequest; } catch { return null; }

  if (rpc.method === "initialize" || rpc.method === "tools/list") {
    return augmentDiscovery(request, rpc, env);
  }

  if (rpc.method !== "tools/call") return null;
  const params = object(rpc.params);
  const toolName = normalize(params.name);
  if (!["mare_autonomy_submit", "mare_autonomy_status", "mare_autonomy_policy"].includes(toolName)) return null;
  if (!isAuthorized(request, env)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: responseHeaders(request) });

  const args = object(params.arguments);
  try {
    if (toolName === "mare_autonomy_submit") return rpcResponse(request, rpc.id, await submitJob(request, env, args));
    if (toolName === "mare_autonomy_status") return rpcResponse(request, rpc.id, await readJobStatus(env, args));
    return rpcResponse(request, rpc.id, textToolResult(policyPayload()));
  } catch (error) {
    return rpcResponse(request, rpc.id, toolFailure(error instanceof Error ? error.message : "mare_autonomy_runtime_failed"));
  }
}
