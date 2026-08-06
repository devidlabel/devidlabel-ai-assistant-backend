type JsonObject = Record<string, unknown>;

export type GitHubOperationsEnv = {
  GITHUB_OPERATIONS_TOKEN?: string;
  GITHUB_OPERATIONS_REPOSITORIES?: string;
  [key: string]: unknown;
};

const API_BASE = "https://api.github.com";
const APPROVAL_CONFIRMATION = "CREATE GITHUB PR";
const MAX_FILES = 20;
const MAX_FILE_BYTES = 48 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function token(env: GitHubOperationsEnv): string {
  return normalize(env.GITHUB_OPERATIONS_TOKEN);
}

function allowlist(env: GitHubOperationsEnv): string[] {
  return normalize(env.GITHUB_OPERATIONS_REPOSITORIES)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value));
}

export function githubOperationsConfiguration(env: GitHubOperationsEnv): JsonObject {
  return {
    configured: Boolean(token(env) && allowlist(env).length),
    repository_allowlist: allowlist(env),
    required_token_permissions: ["Metadata: Read", "Contents: Read and write", "Pull requests: Read and write"],
    supported_actions: ["create or reuse branch", "create or update files on branch", "open pull request"],
    blocked_actions: ["merge pull request", "delete branch", "push to default branch", "modify workflow files", "write secret-like files"],
  };
}

function safeRepository(value: string, env: GitHubOperationsEnv): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && allowlist(env).includes(value);
}

function safeBranch(value: string): boolean {
  return /^mare\/[A-Za-z0-9._/-]{3,120}$/.test(value) && !value.includes("..") && !value.endsWith("/");
}

function safeBaseBranch(value: string): boolean {
  return /^[A-Za-z0-9._/-]{1,120}$/.test(value) && !value.includes("..") && !value.endsWith("/");
}

function safePath(value: string): boolean {
  if (!value || value.length > 300 || value.startsWith("/") || value.includes("..")) return false;
  const lower = value.toLowerCase();
  if (lower.startsWith(".github/workflows/")) return false;
  if (lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".pem") || lower.endsWith(".key")) return false;
  if (/(^|\/)(secrets?|credentials?)(\/|\.|$)/i.test(value)) return false;
  return /^[A-Za-z0-9._/@+ -]+(?:\/[A-Za-z0-9._/@+ -]+)*$/.test(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64Decode(value: string): string {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

async function githubFetch(
  env: GitHubOperationsEnv,
  path: string,
  init: RequestInit = {},
  allow404 = false,
): Promise<{ status: number; body: JsonObject | JsonObject[] | null }> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token(env)}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "MARE-Operations-OS",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  let body: JsonObject | JsonObject[] | null = null;
  try {
    body = await response.json() as JsonObject | JsonObject[];
  } catch {
    body = null;
  }
  if (!response.ok && !(allow404 && response.status === 404)) {
    const error = new Error(`github_api_request_failed_${response.status}`) as Error & { status?: number; detail?: unknown };
    error.status = response.status;
    error.detail = body;
    throw error;
  }
  return { status: response.status, body };
}

function validateFiles(value: unknown): Array<{ path: string; content: string }> {
  if (!Array.isArray(value) || !value.length || value.length > MAX_FILES) throw new Error("invalid_github_files");
  const files: Array<{ path: string; content: string }> = [];
  let total = 0;
  for (const raw of value) {
    const item = asObject(raw);
    const path = normalize(item.path);
    const content = typeof item.content === "string" ? item.content : "";
    if (!safePath(path)) throw new Error(`unsafe_github_path:${path || "missing"}`);
    const bytes = utf8Bytes(content);
    if (bytes > MAX_FILE_BYTES) throw new Error(`github_file_too_large:${path}`);
    total += bytes;
    files.push({ path, content });
  }
  if (total > MAX_TOTAL_BYTES) throw new Error("github_payload_too_large");
  return files;
}

function repoParts(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repository.split("/");
  return { owner, repo };
}

async function getBranchSha(env: GitHubOperationsEnv, repository: string, branch: string): Promise<string> {
  const { owner, repo } = repoParts(repository);
  const ref = encodeURIComponent(`heads/${branch}`);
  const response = await githubFetch(env, `/repos/${owner}/${repo}/git/ref/${ref}`);
  return normalize(asObject(asObject(response.body).object).sha);
}

async function ensureBranch(
  env: GitHubOperationsEnv,
  repository: string,
  baseBranch: string,
  branchName: string,
): Promise<{ created: boolean; sha: string }> {
  try {
    const existing = await getBranchSha(env, repository, branchName);
    if (existing) return { created: false, sha: existing };
  } catch (error) {
    const status = (error as Error & { status?: number }).status;
    if (status !== 404) throw error;
  }
  const baseSha = await getBranchSha(env, repository, baseBranch);
  if (!baseSha) throw new Error("github_base_branch_not_found");
  const { owner, repo } = repoParts(repository);
  const created = await githubFetch(env, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  });
  const sha = normalize(asObject(asObject(created.body).object).sha) || baseSha;
  return { created: true, sha };
}

async function currentFile(
  env: GitHubOperationsEnv,
  repository: string,
  branchName: string,
  path: string,
): Promise<{ sha: string; content: string } | null> {
  const { owner, repo } = repoParts(repository);
  const response = await githubFetch(
    env,
    `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branchName)}`,
    {},
    true,
  );
  if (response.status === 404 || !response.body || Array.isArray(response.body)) return null;
  const body = asObject(response.body);
  const sha = normalize(body.sha);
  const content = normalize(body.encoding) === "base64" && typeof body.content === "string"
    ? base64Decode(body.content)
    : "";
  return sha ? { sha, content } : null;
}

async function upsertFile(
  env: GitHubOperationsEnv,
  repository: string,
  branchName: string,
  commitMessage: string,
  file: { path: string; content: string },
): Promise<{ path: string; changed: boolean; commit_sha: string | null }> {
  const existing = await currentFile(env, repository, branchName, file.path);
  if (existing?.content === file.content) return { path: file.path, changed: false, commit_sha: null };
  const { owner, repo } = repoParts(repository);
  const payload: JsonObject = {
    message: commitMessage,
    content: base64Encode(file.content),
    branch: branchName,
    ...(existing?.sha ? { sha: existing.sha } : {}),
  };
  const response = await githubFetch(
    env,
    `/repos/${owner}/${repo}/contents/${file.path.split("/").map(encodeURIComponent).join("/")}`,
    { method: "PUT", body: JSON.stringify(payload) },
  );
  const commitSha = normalize(asObject(asObject(response.body).commit).sha);
  return { path: file.path, changed: true, commit_sha: commitSha || null };
}

async function existingPullRequest(
  env: GitHubOperationsEnv,
  repository: string,
  baseBranch: string,
  branchName: string,
): Promise<JsonObject | null> {
  const { owner, repo } = repoParts(repository);
  const query = new URLSearchParams({ state: "open", head: `${owner}:${branchName}`, base: baseBranch, per_page: "10" });
  const response = await githubFetch(env, `/repos/${owner}/${repo}/pulls?${query.toString()}`);
  const rows = Array.isArray(response.body) ? response.body : [];
  return rows.length ? asObject(rows[0]) : null;
}

export async function createGitHubPullRequest(args: JsonObject, env: GitHubOperationsEnv): Promise<JsonObject> {
  if (!token(env) || !allowlist(env).length) throw new Error("github_operations_not_configured");
  if (normalize(args.approval_confirmation) !== APPROVAL_CONFIRMATION) {
    throw new Error("github_pr_confirmation_required");
  }

  const repository = normalize(args.repository);
  const baseBranch = normalize(args.base_branch) || "main";
  const branchName = normalize(args.branch_name);
  const commitMessage = normalize(args.commit_message);
  const prTitle = normalize(args.pr_title);
  const prBody = normalize(args.pr_body);
  const files = validateFiles(args.files);

  if (!safeRepository(repository, env)) throw new Error("github_repository_not_allowlisted");
  if (!safeBaseBranch(baseBranch)) throw new Error("invalid_github_base_branch");
  if (!safeBranch(branchName)) throw new Error("invalid_github_branch_name");
  if (!commitMessage || commitMessage.length > 200) throw new Error("invalid_github_commit_message");
  if (!prTitle || prTitle.length > 240) throw new Error("invalid_github_pr_title");
  if (prBody.length > 10_000) throw new Error("invalid_github_pr_body");
  if (branchName === baseBranch) throw new Error("github_branch_must_differ_from_base");

  const branch = await ensureBranch(env, repository, baseBranch, branchName);
  const fileResults = [];
  for (const file of files) {
    fileResults.push(await upsertFile(env, repository, branchName, commitMessage, file));
  }

  const existing = await existingPullRequest(env, repository, baseBranch, branchName);
  if (existing) {
    return {
      ok: true,
      operation: "github_branch_files_pull_request",
      status: "pull_request_already_exists",
      idempotent_replay: true,
      external_write_performed: fileResults.some((item) => item.changed),
      branch_created: branch.created,
      branch_name: branchName,
      files: fileResults,
      pull_request: {
        number: existing.number || null,
        url: existing.html_url || null,
        state: existing.state || "open",
      },
      safety: {
        merge_performed: false,
        default_branch_modified: false,
        workflow_files_allowed: false,
        secret_files_allowed: false,
        requires_human_review: true,
      },
    };
  }

  const { owner, repo } = repoParts(repository);
  const created = await githubFetch(env, `/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title: prTitle, head: branchName, base: baseBranch, body: prBody, draft: true }),
  });
  const pr = asObject(created.body);
  return {
    ok: true,
    operation: "github_branch_files_pull_request",
    status: "draft_pull_request_created",
    idempotent_replay: false,
    external_write_performed: true,
    branch_created: branch.created,
    branch_name: branchName,
    files: fileResults,
    pull_request: {
      number: pr.number || null,
      url: pr.html_url || null,
      state: pr.state || "open",
      draft: pr.draft !== false,
    },
    safety: {
      merge_performed: false,
      default_branch_modified: false,
      workflow_files_allowed: false,
      secret_files_allowed: false,
      requires_human_review: true,
    },
  };
}
