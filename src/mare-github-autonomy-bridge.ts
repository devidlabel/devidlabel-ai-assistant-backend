import { isMareAutoLogCapability } from "./mare-autonomy-policy.js";

type JsonObject = Record<string, unknown>;

type DurableObjectStubLike = {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
};

type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
};

type GitHubAutonomyBridgeEnv = {
  MARE_AUTONOMY_RUNNER?: DurableObjectNamespaceLike;
};

const BRIDGE_PATH = "/internal/github-autonomy-bridge";
const REQUEST_PATH_PATTERN = /^ops\/autonomy-requests\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/;
const RAW_REPOSITORY_BASE = "https://raw.githubusercontent.com/devidlabel/devidlabel-ai-assistant-backend/main/";
const MAX_REQUEST_BYTES = 320 * 1024;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadAuthorizedRequest(requestPath: string): Promise<{
  requestPath: string;
  requestHash: string;
  jobId: string;
  capabilityId: string;
  payload: JsonObject;
}> {
  if (!REQUEST_PATH_PATTERN.test(requestPath)) throw new Error("invalid_autonomy_request_path");

  const response = await fetch(`${RAW_REPOSITORY_BASE}${requestPath}`, {
    headers: { Accept: "application/json", "User-Agent": "MARE-Business-OS" },
    cf: { cacheTtl: 0, cacheEverything: false },
  } as RequestInit);
  if (!response.ok) throw new Error(`autonomy_request_fetch_failed_${response.status}`);

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) throw new Error("autonomy_request_too_large");

  let parsed: JsonObject;
  try { parsed = object(JSON.parse(text)); } catch { throw new Error("autonomy_request_invalid_json"); }
  if (normalize(parsed.schema) !== "mare_autonomy_request_v1") throw new Error("autonomy_request_schema_invalid");

  const capabilityId = normalize(parsed.capability_id);
  if (!isMareAutoLogCapability(capabilityId)) throw new Error("capability_not_autonomous");
  const payload = object(parsed.request);
  if (!Object.keys(payload).length) throw new Error("autonomy_request_payload_missing");

  const requestHash = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const jobId = `maj_gh_${requestHash.slice(0, 48)}`;
  return { requestPath, requestHash, jobId, capabilityId, payload };
}

async function submit(env: GitHubAutonomyBridgeEnv, authorized: Awaited<ReturnType<typeof loadAuthorizedRequest>>): Promise<Response> {
  if (!env.MARE_AUTONOMY_RUNNER) return json({ ok: false, error: "mare_autonomy_runner_not_configured" }, 503);
  const durableId = env.MARE_AUTONOMY_RUNNER.idFromName(authorized.jobId);
  const stub = env.MARE_AUTONOMY_RUNNER.get(durableId);
  const response = await stub.fetch("https://mare-autonomy/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "enqueue",
      job_id: authorized.jobId,
      capability_id: authorized.capabilityId,
      request: authorized.payload,
    }),
  });
  let body: JsonObject = {};
  try { body = object(await response.json()); } catch { body = {}; }
  if (!response.ok && response.status !== 202) {
    return json({
      ok: false,
      error: normalize(body.error) || `autonomy_enqueue_failed_${response.status}`,
      request_path: authorized.requestPath,
      request_hash: authorized.requestHash,
      job_id: authorized.jobId,
    }, response.status >= 400 && response.status < 600 ? response.status : 502);
  }
  return json({
    ok: true,
    bridge: "github_main_request_v1",
    request_path: authorized.requestPath,
    request_hash: authorized.requestHash,
    job_id: authorized.jobId,
    capability_id: authorized.capabilityId,
    policy: "AUTO+LOG",
    deterministic_idempotency: true,
    durable_execution: true,
    job: object(body.job),
  }, response.status === 202 ? 202 : 200);
}

async function status(env: GitHubAutonomyBridgeEnv, authorized: Awaited<ReturnType<typeof loadAuthorizedRequest>>): Promise<Response> {
  if (!env.MARE_AUTONOMY_RUNNER) return json({ ok: false, error: "mare_autonomy_runner_not_configured" }, 503);
  const durableId = env.MARE_AUTONOMY_RUNNER.idFromName(authorized.jobId);
  const stub = env.MARE_AUTONOMY_RUNNER.get(durableId);
  const response = await stub.fetch("https://mare-autonomy/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "status", job_id: authorized.jobId }),
  });
  let body: JsonObject = {};
  try { body = object(await response.json()); } catch { body = {}; }
  if (!response.ok) return json({ ok: false, error: normalize(body.error) || `autonomy_status_failed_${response.status}` }, response.status);
  return json({
    ok: true,
    bridge: "github_main_request_v1",
    request_path: authorized.requestPath,
    request_hash: authorized.requestHash,
    job_id: authorized.jobId,
    capability_id: authorized.capabilityId,
    job: body.job ?? null,
  });
}

export async function handleGitHubAutonomyBridgeRequest(request: Request, env: GitHubAutonomyBridgeEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== BRIDGE_PATH) return null;
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  let args: JsonObject;
  try { args = object(await request.json()); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const action = normalize(args.action);
  const requestPath = normalize(args.request_path);
  if (!["submit", "status"].includes(action)) return json({ ok: false, error: "invalid_action" }, 400);

  try {
    const authorized = await loadAuthorizedRequest(requestPath);
    return action === "submit" ? submit(env, authorized) : status(env, authorized);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "github_autonomy_bridge_failed" }, 400);
  }
}
