import {
  MARE_GIT_COMMAND_CAPABILITIES,
  MARE_GIT_COMMAND_PREFIX,
  MARE_GIT_COMMAND_REPOSITORY,
  MARE_GIT_COMMAND_SCHEMA_VERSION,
  MARE_GIT_COMMAND_WORKFLOW_PATH,
  MARE_GIT_RECEIPT_PREFIX,
  isMareGitCommandCapability,
} from "./mare-git-command-policy.js";

type JsonObject = Record<string, unknown>;

type DurableObjectStubLike = {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
};

type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
};

type GitCommandEnv = {
  GITHUB_OPERATIONS_TOKEN?: string;
  GITHUB_OPERATIONS_REPOSITORIES?: string;
  MARE_AUTONOMY_RUNNER?: DurableObjectNamespaceLike;
  [key: string]: unknown;
};

type GitCommand = {
  schema_version: 1;
  command_id: string;
  capability_id: "shopify.product.season.assign_missing";
  created_at: string;
  expires_at: string;
  purpose: string;
  request: {
    assignments: Array<{
      product_id: string;
      season_reference: string;
    }>;
  };
};

const GITHUB_API = "https://api.github.com";
const COMMAND_PATH_PATTERN = /^ops\/autonomy\/commands\/(mac_[A-Za-z0-9-]{20,80})\.json$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const PRODUCT_ID_PATTERN = /^gid:\/\/shopify\/Product\/\d+$/;
const SEASON_REFERENCE_PATTERN = /^product_feature_season\.[a-z0-9][a-z0-9-]{0,99}$/;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_COMMAND_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_COMMAND_LIFETIME_MS = 24 * 60 * 60 * 1000;
const GITHUB_API_VERSION = "2022-11-28";

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function jsonResponse(payload: unknown, status = 200): Response {
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

function repositoryAllowed(env: GitCommandEnv): boolean {
  return normalize(env.GITHUB_OPERATIONS_REPOSITORIES)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(MARE_GIT_COMMAND_REPOSITORY);
}

function serverGithubToken(env: GitCommandEnv): string {
  const token = normalize(env.GITHUB_OPERATIONS_TOKEN);
  if (!token || !repositoryAllowed(env)) throw new Error("git_command_server_github_not_configured");
  return token;
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "MARE-Business-OS",
  };
}

async function githubJson(url: string, token: string, init: RequestInit = {}): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...githubHeaders(token),
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body: JsonObject = {};
  try { body = text ? JSON.parse(text) as JsonObject : {}; } catch { body = {}; }
  return { status: response.status, body };
}

function encodePath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function commandIdFromPath(path: string): string {
  const match = normalize(path).match(COMMAND_PATH_PATTERN);
  if (!match) throw new Error("git_command_path_not_allowed");
  return match[1];
}

function deterministicJobId(commandId: string): string {
  const jobId = `maj_${commandId.slice(4)}`;
  if (!/^maj_[A-Za-z0-9-]{20,80}$/.test(jobId)) throw new Error("git_command_job_id_invalid");
  return jobId;
}

function validateExactKeys(value: JsonObject, allowed: string[], errorCode: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) throw new Error(`${errorCode}:${key}`);
}

function validateCommand(raw: JsonObject, commandId: string): GitCommand {
  validateExactKeys(raw, ["schema_version", "command_id", "capability_id", "created_at", "expires_at", "purpose", "request"], "git_command_field_not_allowed");
  if (raw.schema_version !== MARE_GIT_COMMAND_SCHEMA_VERSION) throw new Error("git_command_schema_version_invalid");
  if (normalize(raw.command_id) !== commandId) throw new Error("git_command_id_mismatch");
  const capabilityId = normalize(raw.capability_id);
  if (!isMareGitCommandCapability(capabilityId)) throw new Error("git_command_capability_not_public_safe");

  const createdAt = normalize(raw.created_at);
  const expiresAt = normalize(raw.expires_at);
  const createdMs = Date.parse(createdAt);
  const expiresMs = Date.parse(expiresAt);
  const now = Date.now();
  if (!Number.isFinite(createdMs) || !Number.isFinite(expiresMs)) throw new Error("git_command_timestamp_invalid");
  if (createdMs > now + 5 * 60 * 1000 || createdMs < now - MAX_COMMAND_AGE_MS) throw new Error("git_command_created_at_out_of_window");
  if (expiresMs <= now || expiresMs <= createdMs || expiresMs - createdMs > MAX_COMMAND_LIFETIME_MS) throw new Error("git_command_expiry_invalid");

  const purpose = normalize(raw.purpose);
  if (!purpose || purpose.length > 240) throw new Error("git_command_purpose_invalid");

  const request = object(raw.request);
  validateExactKeys(request, ["assignments"], "git_command_request_field_not_allowed");
  if (!Array.isArray(request.assignments) || request.assignments.length < 1 || request.assignments.length > 25) {
    throw new Error("git_command_season_assignment_count_invalid");
  }
  const seen = new Set<string>();
  const assignments = request.assignments.map((entry, index) => {
    const item = object(entry);
    validateExactKeys(item, ["product_id", "season_reference"], "git_command_assignment_field_not_allowed");
    const productId = normalize(item.product_id);
    const seasonReference = normalize(item.season_reference).toLowerCase();
    if (!PRODUCT_ID_PATTERN.test(productId)) throw new Error(`git_command_product_id_invalid:${index}`);
    if (!SEASON_REFERENCE_PATTERN.test(seasonReference)) throw new Error(`git_command_season_reference_invalid:${index}`);
    if (seen.has(productId)) throw new Error(`git_command_duplicate_product:${index}`);
    seen.add(productId);
    return { product_id: productId, season_reference: seasonReference };
  });

  return {
    schema_version: 1,
    command_id: commandId,
    capability_id: capabilityId,
    created_at: createdAt,
    expires_at: expiresAt,
    purpose,
    request: { assignments },
  };
}

async function verifyActionsRun(request: Request, body: JsonObject): Promise<{ runId: number; sourceCommit: string }> {
  const token = normalize(request.headers.get("X-GitHub-Actions-Token"));
  if (!token) throw new Error("git_command_actions_token_required");
  const runId = Number(body.run_id);
  const sourceCommit = normalize(body.source_commit).toLowerCase();
  if (!Number.isSafeInteger(runId) || runId <= 0 || !SHA_PATTERN.test(sourceCommit)) throw new Error("git_command_actions_context_invalid");

  const result = await githubJson(`${GITHUB_API}/repos/${MARE_GIT_COMMAND_REPOSITORY}/actions/runs/${runId}`, token);
  if (result.status !== 200) throw new Error("git_command_actions_run_not_verified");
  const run = result.body;
  const repository = object(run.repository);
  const workflowPath = normalize(run.path).split("@")[0];
  if (normalize(repository.full_name) !== MARE_GIT_COMMAND_REPOSITORY) throw new Error("git_command_actions_repository_mismatch");
  if (normalize(run.event) !== "push" || normalize(run.head_branch) !== "main") throw new Error("git_command_actions_run_not_main_push");
  if (normalize(run.head_sha).toLowerCase() !== sourceCommit) throw new Error("git_command_actions_sha_mismatch");
  if (workflowPath !== MARE_GIT_COMMAND_WORKFLOW_PATH) throw new Error("git_command_actions_workflow_mismatch");
  return { runId, sourceCommit };
}

async function verifyCommandCommit(env: GitCommandEnv, sourceCommit: string, commandPath: string): Promise<{ command: GitCommand; blobSha: string }> {
  const token = serverGithubToken(env);
  const commandId = commandIdFromPath(commandPath);
  const commitResult = await githubJson(`${GITHUB_API}/repos/${MARE_GIT_COMMAND_REPOSITORY}/commits/${sourceCommit}`, token);
  if (commitResult.status !== 200 || normalize(commitResult.body.sha).toLowerCase() !== sourceCommit) throw new Error("git_command_source_commit_not_found");
  const parents = Array.isArray(commitResult.body.parents) ? commitResult.body.parents as JsonObject[] : [];
  const files = Array.isArray(commitResult.body.files) ? commitResult.body.files as JsonObject[] : [];
  if (parents.length !== 1) throw new Error("git_command_merge_commit_not_allowed");
  if (files.length !== 1) throw new Error("git_command_commit_must_contain_exactly_one_file");
  const changed = files[0];
  if (normalize(changed.filename) !== commandPath || normalize(changed.status) !== "added") throw new Error("git_command_file_must_be_new_and_only_change");

  const contentResult = await githubJson(`${GITHUB_API}/repos/${MARE_GIT_COMMAND_REPOSITORY}/contents/${encodePath(commandPath)}?ref=${sourceCommit}`, token);
  if (contentResult.status !== 200 || normalize(contentResult.body.type) !== "file" || normalize(contentResult.body.encoding) !== "base64") {
    throw new Error("git_command_file_not_readable");
  }
  const declaredSize = Number(contentResult.body.size || 0);
  if (!Number.isFinite(declaredSize) || declaredSize <= 0 || declaredSize > MAX_COMMAND_BYTES) throw new Error("git_command_file_size_invalid");
  const decoded = decodeBase64Utf8(normalize(contentResult.body.content));
  if (new TextEncoder().encode(decoded).byteLength > MAX_COMMAND_BYTES) throw new Error("git_command_file_too_large");
  let raw: JsonObject;
  try { raw = JSON.parse(decoded) as JsonObject; } catch { throw new Error("git_command_json_invalid"); }
  return { command: validateCommand(raw, commandId), blobSha: normalize(contentResult.body.sha) };
}

async function durableFetch(env: GitCommandEnv, jobId: string, payload: JsonObject): Promise<{ status: number; body: JsonObject }> {
  if (!env.MARE_AUTONOMY_RUNNER) throw new Error("git_command_autonomy_runner_not_configured");
  const id = env.MARE_AUTONOMY_RUNNER.idFromName(jobId);
  const stub = env.MARE_AUTONOMY_RUNNER.get(id);
  const response = await stub.fetch("https://mare-autonomy/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let body: JsonObject = {};
  try { body = await response.json() as JsonObject; } catch { body = {}; }
  return { status: response.status, body };
}

function findScalar(value: unknown, key: string, depth = 0): unknown {
  if (depth > 6 || !value || typeof value !== "object") return undefined;
  if (!Array.isArray(value)) {
    const record = value as JsonObject;
    if (record[key] !== undefined && ["string", "number", "boolean"].includes(typeof record[key])) return record[key];
    for (const child of Object.values(record)) {
      const found = findScalar(child, key, depth + 1);
      if (found !== undefined) return found;
    }
  } else {
    for (const child of value) {
      const found = findScalar(child, key, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function safeJobSummary(commandId: string, sourceCommit: string, jobId: string, job: JsonObject): JsonObject {
  const status = normalize(job.status) || "unknown";
  const result = object(job.result);
  const errorCode = normalize(job.error).split(":")[0].slice(0, 120) || null;
  return {
    schema_version: 1,
    command_id: commandId,
    source_commit: sourceCommit,
    job_id: jobId,
    capability_id: normalize(job.capability_id) || MARE_GIT_COMMAND_CAPABILITIES[0],
    status,
    attempts: Number(job.attempts || 0),
    max_attempts: Number(job.max_attempts || 0),
    completed_at: normalize(job.completed_at) || null,
    error_code: errorCode,
    safe_result: {
      ok: findScalar(result, "ok") ?? null,
      operation: findScalar(result, "operation") ?? null,
      assigned_count: findScalar(result, "assigned_count") ?? null,
      updated_count: findScalar(result, "updated_count") ?? null,
      atomic_write: findScalar(result, "atomic_write") ?? null,
      concurrency_control: findScalar(result, "concurrency_control") ?? null,
    },
  };
}

async function putReceipt(env: GitCommandEnv, commandId: string, receipt: JsonObject): Promise<boolean> {
  const token = serverGithubToken(env);
  const path = `${MARE_GIT_RECEIPT_PREFIX}${commandId}.json`;
  const url = `${GITHUB_API}/repos/${MARE_GIT_COMMAND_REPOSITORY}/contents/${encodePath(path)}`;
  const serialized = JSON.stringify({ ...receipt, generated_at: new Date().toISOString() }, null, 2) + "\n";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await githubJson(`${url}?ref=main`, token);
    let sha = "";
    if (existing.status === 200) {
      sha = normalize(existing.body.sha);
      try {
        const previous = JSON.parse(decodeBase64Utf8(normalize(existing.body.content))) as JsonObject;
        if (normalize(previous.status) === normalize(receipt.status) && normalize(previous.source_commit) === normalize(receipt.source_commit)) return true;
      } catch {}
    } else if (existing.status !== 404) {
      throw new Error("git_command_receipt_lookup_failed");
    }

    const payload: JsonObject = {
      message: `MARE autonomy receipt ${commandId}: ${normalize(receipt.status) || "unknown"}`,
      content: encodeBase64Utf8(serialized),
      branch: "main",
      ...(sha ? { sha } : {}),
    };
    const put = await githubJson(url, token, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (put.status === 200 || put.status === 201) return true;
    if (![409, 422].includes(put.status) || attempt === 2) throw new Error("git_command_receipt_publish_failed");
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  return false;
}

async function submitCommand(request: Request, body: JsonObject, env: GitCommandEnv): Promise<Response> {
  const context = await verifyActionsRun(request, body);
  const commandPath = normalize(body.command_path);
  const verified = await verifyCommandCommit(env, context.sourceCommit, commandPath);
  const command = verified.command;
  const jobId = deterministicJobId(command.command_id);
  const queued = await durableFetch(env, jobId, {
    action: "enqueue",
    job_id: jobId,
    capability_id: command.capability_id,
    request: command.request,
  });
  if (![200, 202].includes(queued.status) || queued.body.ok !== true) throw new Error("git_command_enqueue_failed");
  const queuedJob = object(queued.body.job);
  return jsonResponse({
    ok: true,
    command_id: command.command_id,
    command_blob_sha: verified.blobSha,
    source_commit: context.sourceCommit,
    job_id: jobId,
    capability_id: command.capability_id,
    status: normalize(queuedJob.status) || "queued",
    idempotent_replay: queued.body.idempotent_replay === true,
    durable_execution: true,
    receipt_path: `${MARE_GIT_RECEIPT_PREFIX}${command.command_id}.json`,
  }, queued.status === 202 ? 202 : 200);
}

async function commandStatus(request: Request, body: JsonObject, env: GitCommandEnv): Promise<Response> {
  const context = await verifyActionsRun(request, body);
  const commandPath = normalize(body.command_path);
  const commandId = commandIdFromPath(commandPath);
  const jobId = deterministicJobId(commandId);
  const response = await durableFetch(env, jobId, { action: "status", job_id: jobId });
  if (response.status !== 200 || response.body.ok !== true) throw new Error("git_command_status_failed");
  const job = object(response.body.job);
  if (!Object.keys(job).length) return jsonResponse({ ok: true, command_id: commandId, job_id: jobId, status: "not_found" });
  const summary = safeJobSummary(commandId, context.sourceCommit, jobId, job);
  const terminal = ["completed", "failed", "cancelled"].includes(normalize(summary.status));
  let receiptPublished = false;
  let receiptError: string | null = null;
  if (terminal) {
    try { receiptPublished = await putReceipt(env, commandId, summary); }
    catch (error) { receiptError = error instanceof Error ? error.message : "git_command_receipt_publish_failed"; }
  }
  return jsonResponse({
    ok: true,
    ...summary,
    terminal,
    receipt_published: receiptPublished,
    receipt_error: receiptError,
    receipt_path: `${MARE_GIT_RECEIPT_PREFIX}${commandId}.json`,
  });
}

function health(env: GitCommandEnv): JsonObject {
  const configured = Boolean(normalize(env.GITHUB_OPERATIONS_TOKEN) && repositoryAllowed(env) && env.MARE_AUTONOMY_RUNNER);
  return {
    ok: true,
    service: "mare_git_command_bridge",
    version: "1.0.0",
    configured,
    repository: MARE_GIT_COMMAND_REPOSITORY,
    workflow_path: MARE_GIT_COMMAND_WORKFLOW_PATH,
    command_prefix: MARE_GIT_COMMAND_PREFIX,
    receipt_prefix: MARE_GIT_RECEIPT_PREFIX,
    accepted_capabilities: [...MARE_GIT_COMMAND_CAPABILITIES],
    authentication: "temporary_github_actions_token_verified_against_exact_run",
    command_commit_policy: "single_parent_single_new_command_file_only",
    request_data_policy: "public_safe_schema_only",
    secrets_exposed: false,
  };
}

export async function handleMareGitCommandBridge(request: Request, env: GitCommandEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/internal/autonomy/git-command/health") {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    return jsonResponse(health(env));
  }
  if (!["/internal/autonomy/git-command/submit", "/internal/autonomy/git-command/status"].includes(url.pathname)) return null;
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);

  let body: JsonObject;
  try { body = await request.json() as JsonObject; } catch { return jsonResponse({ ok: false, error: "invalid_json" }, 400); }
  try {
    if (url.pathname.endsWith("/submit")) return await submitCommand(request, body, env);
    return await commandStatus(request, body, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "git_command_bridge_failed";
    const status = /token_required|not_verified|repository_mismatch|run_not_main_push|sha_mismatch|workflow_mismatch/.test(message) ? 401 : 400;
    return jsonResponse({ ok: false, error: message }, status);
  }
}
