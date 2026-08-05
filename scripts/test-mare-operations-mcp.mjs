import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = readFileSync("src/mare-operations-mcp.ts", "utf8");
const requiredFragments = [
  'url.pathname !== "/mcp-operations"',
  'url.pathname !== "/mcp-operations/health"',
  'MARE_OPS_ACCESS_TOKEN',
  'name: "mare_operations_health"',
  'name: "mare_operations_preview"',
  'dry_run_must_be_true',
  'external_writes_enabled: false',
  'irreversible_actions_enabled: false',
  'console.info(JSON.stringify',
  'pii_logged: false',
];
for (const fragment of requiredFragments) {
  assert.ok(source.includes(fragment), `Missing Operations MCP contract fragment: ${fragment}`);
}
assert.equal(source.includes("MARE_MCP_ACCESS_TOKEN"), false, "Operations MCP must not fall back to the Commerce OS token");
assert.equal(source.includes("DAILY_PULSE_ACCESS_TOKEN"), false, "Operations MCP must not fall back to report tokens");

const out = mkdtempSync(join(tmpdir(), "mare-operations-mcp-"));
execFileSync("npx", [
  "tsc",
  "--outDir", out,
  "--noEmit", "false",
  "--module", "ESNext",
  "--target", "ES2022",
  "--moduleResolution", "Bundler",
  "--lib", "ES2022,WebWorker",
  "src/mare-operations-mcp.ts",
], { stdio: "inherit" });

const { handleMareOperationsMcpRequest } = await import(`file://${join(out, "mare-operations-mcp.js")}`);

const endpoint = "https://worker.test/mcp-operations";
const env = { MARE_OPS_ACCESS_TOKEN: "ops-secret" };

function rpc(method, params = {}, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function request(body, options = {}) {
  return new Request(endpoint, {
    method: "POST",
    headers: {
      Authorization: "Bearer ops-secret",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body,
  });
}

const health = await handleMareOperationsMcpRequest(
  new Request("https://worker.test/mcp-operations/health"),
  env,
);
assert.equal(health?.status, 200, "health should be public and available");
const healthBody = await health.json();
assert.equal(healthBody.configured, true, "health should confirm the isolated token is configured");
assert.equal(healthBody.external_writes_enabled, false, "foundation health must disable external writes");
assert.equal(healthBody.tools, 2, "foundation should expose exactly two tools");
assert.equal(JSON.stringify(healthBody).includes("ops-secret"), false, "health must not leak the token");

const isolatedHealth = await handleMareOperationsMcpRequest(
  new Request("https://worker.test/mcp-operations/health"),
  { MARE_MCP_ACCESS_TOKEN: "commerce-secret", DAILY_PULSE_ACCESS_TOKEN: "report-secret" },
);
assert.equal((await isolatedHealth.json()).configured, false, "Commerce/report tokens must not configure Operations OS");

const denied = await handleMareOperationsMcpRequest(
  new Request(endpoint, { method: "POST", body: rpc("ping") }),
  env,
);
assert.equal(denied?.status, 401, "MCP calls must require the Operations token");

const wrongOrigin = await handleMareOperationsMcpRequest(
  request(rpc("ping"), { headers: { Origin: "https://example.com" } }),
  env,
);
assert.equal(wrongOrigin?.status, 403, "non-ChatGPT origins must be rejected");

const initialized = await handleMareOperationsMcpRequest(
  request(rpc("initialize", { protocolVersion: "2025-06-18" })),
  env,
);
assert.equal(initialized?.status, 200, "initialize should succeed");
const initializedBody = await initialized.json();
assert.equal(initializedBody.result.serverInfo.name, "MARE Operations OS");

const listed = await handleMareOperationsMcpRequest(
  request(rpc("tools/list")),
  env,
);
const listedBody = await listed.json();
assert.deepEqual(
  listedBody.result.tools.map((tool) => tool.name),
  ["mare_operations_health", "mare_operations_preview"],
  "only the foundation allowlist should be exposed",
);
assert.ok(listedBody.result.tools.every((tool) => tool.annotations.readOnlyHint === true), "foundation tools must be preview-only");

const previewArguments = {
  operation: "github_pull_request",
  dry_run: true,
  objective: "Prepare a controlled frontend pull request",
  target: "devidlabel/theme: feature/example",
  changes: ["Update one section", "Add regression tests"],
  rollback_plan: "Close the draft pull request without merging",
};
const preview = await handleMareOperationsMcpRequest(
  request(rpc("tools/call", { name: "mare_operations_preview", arguments: previewArguments })),
  env,
);
const previewBody = await preview.json();
const previewResult = previewBody.result.structuredContent;
assert.equal(previewBody.result.isError, false, "valid preview should succeed");
assert.equal(previewResult.status, "preview_only");
assert.equal(previewResult.safety.external_write_performed, false);
assert.equal(previewResult.safety.execution_available, false);
assert.equal(previewResult.safety.approval_required_before_future_execution, true);

const nonDryRun = await handleMareOperationsMcpRequest(
  request(rpc("tools/call", {
    name: "mare_operations_preview",
    arguments: { ...previewArguments, dry_run: false },
  })),
  env,
);
const nonDryRunBody = await nonDryRun.json();
assert.equal(nonDryRunBody.result.isError, true, "non-dry-run requests must be rejected");
assert.match(nonDryRunBody.result.content[0].text, /dry_run_must_be_true/);

const sensitive = await handleMareOperationsMcpRequest(
  request(rpc("tools/call", {
    name: "mare_operations_preview",
    arguments: {
      ...previewArguments,
      objective: "Use customer@example.com in a draft",
    },
  })),
  env,
);
const sensitiveBody = await sensitive.json();
assert.equal(sensitiveBody.result.isError, true, "customer PII must be rejected from preview arguments");
assert.match(sensitiveBody.result.content[0].text, /sensitive_content_not_allowed/);

const oversized = await handleMareOperationsMcpRequest(
  request(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", padding: "x".repeat(70_000) })),
  env,
);
assert.equal(oversized?.status, 413, "oversized payloads must be rejected");

console.log(JSON.stringify({
  ok: true,
  contract: "mare_operations_os_foundation",
  transport: "streamable_http",
  preview_only_tools: 2,
  isolated_token: true,
  external_writes_enabled: false,
}));
