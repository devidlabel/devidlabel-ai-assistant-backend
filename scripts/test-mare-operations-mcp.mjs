import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = readFileSync("src/mare-operations-mcp.ts", "utf8");
const klaviyoSource = readFileSync("src/mare-operations-klaviyo.ts", "utf8");
const requiredFragments = [
  'url.pathname !== "/mcp-operations"',
  'url.pathname !== "/mcp-operations/health"',
  'MARE_OPS_ACCESS_TOKEN',
  'PUBLIC_DISCOVERY_METHODS',
  'name: "mare_operations_health"',
  'name: "mare_operations_preview"',
  'name: "mare_klaviyo_create_campaign_draft"',
  'readOnlyHint: false',
  'destructiveHint: false',
  'idempotentHint: true',
  'external_writes_enabled: true',
  'irreversible_actions_enabled: false',
  'approval_confirmation',
  'CREATE KLAVIYO DRAFT',
  'console.info(JSON.stringify',
  'pii_logged: false',
];
for (const fragment of requiredFragments) {
  assert.ok(source.includes(fragment), `Missing Operations MCP contract fragment: ${fragment}`);
}

const klaviyoFragments = [
  'KLAVIYO_OPERATIONS_API_KEY',
  'KLAVIYO_DEFAULT_FROM_EMAIL',
  'KLAVIYO_DEFAULT_FROM_LABEL',
  'required_scopes: ["campaigns:read", "campaigns:write"]',
  '"/api/campaigns"',
  '"/api/campaign-message-assign-template"',
  'idempotent_replay',
  'send_or_schedule_performed: false',
  'hold_datetime',
];
for (const fragment of klaviyoFragments) {
  assert.ok(klaviyoSource.includes(fragment), `Missing Klaviyo draft contract fragment: ${fragment}`);
}

for (const forbidden of [
  "MARE_MCP_ACCESS_TOKEN",
  "DAILY_PULSE_ACCESS_TOKEN",
  "KLAVIYO_PRIVATE_API_KEY",
  "KLAVIYO_REPORT_ACCESS_TOKEN",
  "/api/campaign-send-jobs",
  "/api/flow-actions",
]) {
  assert.equal(
    source.includes(forbidden) || klaviyoSource.includes(forbidden),
    false,
    `Operations OS must not contain or fall back to forbidden capability: ${forbidden}`,
  );
}

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
const baseEnv = { MARE_OPS_ACCESS_TOKEN: "ops-secret" };
const configuredEnv = {
  ...baseEnv,
  KLAVIYO_OPERATIONS_API_KEY: "klaviyo-write-secret",
  KLAVIYO_DEFAULT_FROM_EMAIL: "operations@example.test",
  KLAVIYO_DEFAULT_FROM_LABEL: "MARE Test",
  KLAVIYO_DEFAULT_REPLY_TO_EMAIL: "reply@example.test",
  KLAVIYO_DRAFT_HOLD_DATETIME: "2099-12-31T23:59:00+01:00",
};

function rpc(method, params = {}, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function anonymousRequest(body, headers = {}) {
  return new Request(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body,
  });
}

function authorizedRequest(body, headers = {}) {
  return new Request(endpoint, {
    method: "POST",
    headers: {
      Authorization: "Bearer ops-secret",
      "Content-Type": "application/json",
      ...headers,
    },
    body,
  });
}

const health = await handleMareOperationsMcpRequest(
  new Request("https://worker.test/mcp-operations/health"),
  baseEnv,
);
assert.equal(health?.status, 200, "health should be public and available");
const healthBody = await health.json();
assert.equal(healthBody.configured, true, "health should confirm the isolated Operations token");
assert.equal(healthBody.public_discovery_enabled, true);
assert.equal(healthBody.tool_calls_require_authentication, true);
assert.equal(healthBody.external_writes_enabled, true, "the allowlisted draft write should be declared");
assert.equal(healthBody.irreversible_actions_enabled, false);
assert.equal(healthBody.klaviyo_campaign_draft_configured, false, "upstream draft writes must remain disabled without their separate key");
assert.equal(healthBody.tools, 3);
assert.equal(JSON.stringify(healthBody).includes("ops-secret"), false);

const configuredHealth = await handleMareOperationsMcpRequest(
  new Request("https://worker.test/mcp-operations/health"),
  configuredEnv,
);
assert.equal((await configuredHealth.json()).klaviyo_campaign_draft_configured, true);

const wrongOrigin = await handleMareOperationsMcpRequest(
  anonymousRequest(rpc("ping"), { Origin: "https://example.com" }),
  baseEnv,
);
assert.equal(wrongOrigin?.status, 403, "non-ChatGPT origins must be rejected even for discovery");

const initialized = await handleMareOperationsMcpRequest(
  anonymousRequest(rpc("initialize", { protocolVersion: "2025-06-18" })),
  baseEnv,
);
assert.equal(initialized?.status, 200);
const initializedBody = await initialized.json();
assert.equal(initializedBody.result.serverInfo.name, "MARE Operations OS");
assert.equal(initializedBody.result.serverInfo.version, "0.2.0");
assert.equal(JSON.stringify(initializedBody).includes("ops-secret"), false);

const listed = await handleMareOperationsMcpRequest(
  anonymousRequest(rpc("tools/list")),
  baseEnv,
);
const listedBody = await listed.json();
assert.deepEqual(
  listedBody.result.tools.map((tool) => tool.name),
  [
    "mare_operations_health",
    "mare_operations_preview",
    "mare_klaviyo_create_campaign_draft",
  ],
);
assert.equal(listedBody.result.tools[0].annotations.readOnlyHint, true);
assert.equal(listedBody.result.tools[1].annotations.readOnlyHint, true);
assert.equal(listedBody.result.tools[2].annotations.readOnlyHint, false);
assert.equal(listedBody.result.tools[2].annotations.destructiveHint, false);
assert.equal(listedBody.result.tools[2].annotations.idempotentHint, true);
assert.equal(JSON.stringify(listedBody).includes("klaviyo-write-secret"), false);

const previewArguments = {
  operation: "github_pull_request",
  dry_run: true,
  objective: "Prepare a controlled frontend pull request",
  target: "devidlabel/theme: feature/example",
  changes: ["Update one section", "Add regression tests"],
  rollback_plan: "Close the draft pull request without merging",
};

const deniedToolCall = await handleMareOperationsMcpRequest(
  anonymousRequest(rpc("tools/call", { name: "mare_operations_preview", arguments: previewArguments })),
  baseEnv,
);
assert.equal(deniedToolCall?.status, 401, "anonymous tools/call must be rejected");

const preview = await handleMareOperationsMcpRequest(
  authorizedRequest(rpc("tools/call", { name: "mare_operations_preview", arguments: previewArguments })),
  baseEnv,
);
const previewBody = await preview.json();
assert.equal(previewBody.result.isError, false);
assert.equal(previewBody.result.structuredContent.status, "preview_only");
assert.equal(previewBody.result.structuredContent.safety.external_write_performed, false);

const draftArguments = {
  approval_confirmation: "CREATE KLAVIYO DRAFT",
  idempotency_key: "draft-test-20260806-001",
  campaign_name: "MARE Test Draft",
  audience_id: "AUD123",
  subject: "Test subject",
  preview_text: "Test preview",
  template_id: "TPL123",
  use_smart_sending: true,
};

let fetchCalls = [];
let storedCampaignName = "";
let replayMode = false;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init.method || "GET").toUpperCase();
  const headers = new Headers(init.headers || {});
  const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
  fetchCalls.push({ url, method, headers, body });

  assert.equal(headers.get("revision"), "2026-07-15");
  assert.equal(headers.get("Authorization"), "Klaviyo-API-Key klaviyo-write-secret");

  if (method === "GET" && url.pathname === "/api/campaigns") {
    if (!replayMode) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/vnd.api+json" },
      });
    }
    return new Response(JSON.stringify({
      data: [
        {
          type: "campaign",
          id: "campaign_existing",
          attributes: { name: storedCampaignName, status: "Draft" },
          relationships: {
            "campaign-messages": {
              data: [{ type: "campaign-message", id: "message_existing" }],
            },
          },
        },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/vnd.api+json" },
    });
  }

  if (method === "POST" && url.pathname === "/api/campaigns") {
    storedCampaignName = body.data.attributes.name;
    return new Response(JSON.stringify({
      data: {
        type: "campaign",
        id: "campaign_created",
        attributes: { name: storedCampaignName, status: "Draft" },
        relationships: {
          "campaign-messages": {
            data: [{ type: "campaign-message", id: "message_created" }],
          },
        },
      },
    }), {
      status: 201,
      headers: { "Content-Type": "application/vnd.api+json" },
    });
  }

  if (method === "POST" && url.pathname === "/api/campaign-message-assign-template") {
    return new Response(JSON.stringify({
      data: { type: "campaign-message", id: "message_created" },
    }), {
      status: 200,
      headers: { "Content-Type": "application/vnd.api+json" },
    });
  }

  throw new Error(`Unexpected mocked Klaviyo request: ${method} ${url.pathname}`);
};

const unconfiguredDraft = await handleMareOperationsMcpRequest(
  authorizedRequest(rpc("tools/call", {
    name: "mare_klaviyo_create_campaign_draft",
    arguments: draftArguments,
  })),
  baseEnv,
);
const unconfiguredDraftBody = await unconfiguredDraft.json();
assert.equal(unconfiguredDraftBody.result.isError, true);
assert.match(unconfiguredDraftBody.result.content[0].text, /klaviyo_operations_not_configured/);
assert.equal(fetchCalls.length, 0, "no upstream call is allowed without the separate Klaviyo operations key");

const missingApprovalDraft = await handleMareOperationsMcpRequest(
  authorizedRequest(rpc("tools/call", {
    name: "mare_klaviyo_create_campaign_draft",
    arguments: { ...draftArguments, approval_confirmation: "NO" },
  })),
  configuredEnv,
);
const missingApprovalBody = await missingApprovalDraft.json();
assert.equal(missingApprovalBody.result.isError, true);
assert.match(missingApprovalBody.result.content[0].text, /approval_confirmation_required/);
assert.equal(fetchCalls.length, 0, "no write is allowed without exact explicit confirmation");

const createdDraft = await handleMareOperationsMcpRequest(
  authorizedRequest(rpc("tools/call", {
    name: "mare_klaviyo_create_campaign_draft",
    arguments: draftArguments,
  })),
  configuredEnv,
);
const createdDraftBody = await createdDraft.json();
const createdDraftResult = createdDraftBody.result.structuredContent;
assert.equal(createdDraftBody.result.isError, false);
assert.equal(createdDraftResult.status, "draft_created");
assert.equal(createdDraftResult.campaign_id, "campaign_created");
assert.equal(createdDraftResult.campaign_message_id, "message_created");
assert.equal(createdDraftResult.campaign_status, "Draft");
assert.equal(createdDraftResult.template_assigned, true);
assert.equal(createdDraftResult.safety.draft_only, true);
assert.equal(createdDraftResult.safety.send_or_schedule_performed, false);
assert.equal(createdDraftResult.safety.irreversible_action_performed, false);
assert.equal(fetchCalls.length, 3, "create should use one read, one campaign draft write, and one template assignment");
assert.deepEqual(fetchCalls.map((call) => `${call.method} ${call.url.pathname}`), [
  "GET /api/campaigns",
  "POST /api/campaigns",
  "POST /api/campaign-message-assign-template",
]);
assert.ok(fetchCalls.every((call) => !call.url.pathname.includes("send")), "no send endpoint may be called");

const createBody = fetchCalls[1].body;
assert.deepEqual(createBody.data.attributes.audiences.included, ["AUD123"]);
assert.equal(createBody.data.attributes.send_strategy.method, "static");
assert.equal(createBody.data.attributes.send_strategy.datetime, "2099-12-31T23:59:00+01:00");
assert.equal(createBody.data.attributes.send_options.use_smart_sending, true);
assert.equal(createBody.data.attributes.tracking_options.add_tracking_params, true);
const emailContent = createBody.data.attributes["campaign-messages"].data[0].attributes.definition.content;
assert.equal(emailContent.subject, "Test subject");
assert.equal(emailContent.preview_text, "Test preview");
assert.equal(emailContent.from_email, "operations@example.test");
assert.equal(emailContent.from_label, "MARE Test");
assert.equal(emailContent.reply_to_email, "reply@example.test");

replayMode = true;
fetchCalls = [];
const replayedDraft = await handleMareOperationsMcpRequest(
  authorizedRequest(rpc("tools/call", {
    name: "mare_klaviyo_create_campaign_draft",
    arguments: draftArguments,
  })),
  configuredEnv,
);
const replayedDraftBody = await replayedDraft.json();
const replayedDraftResult = replayedDraftBody.result.structuredContent;
assert.equal(replayedDraftBody.result.isError, false);
assert.equal(replayedDraftResult.status, "already_exists");
assert.equal(replayedDraftResult.idempotent_replay, true);
assert.equal(replayedDraftResult.external_write_performed, false);
assert.equal(replayedDraftResult.campaign_id, "campaign_existing");
assert.equal(fetchCalls.length, 1, "idempotent replay must perform discovery only and no write");
assert.equal(fetchCalls[0].method, "GET");

const nonDryRun = await handleMareOperationsMcpRequest(
  authorizedRequest(rpc("tools/call", {
    name: "mare_operations_preview",
    arguments: { ...previewArguments, dry_run: false },
  })),
  baseEnv,
);
const nonDryRunBody = await nonDryRun.json();
assert.equal(nonDryRunBody.result.isError, true);
assert.match(nonDryRunBody.result.content[0].text, /dry_run_must_be_true/);

const sensitive = await handleMareOperationsMcpRequest(
  authorizedRequest(rpc("tools/call", {
    name: "mare_operations_preview",
    arguments: {
      ...previewArguments,
      objective: "Use customer@example.com in a draft",
    },
  })),
  baseEnv,
);
const sensitiveBody = await sensitive.json();
assert.equal(sensitiveBody.result.isError, true);
assert.match(sensitiveBody.result.content[0].text, /sensitive_content_not_allowed/);

const oversized = await handleMareOperationsMcpRequest(
  anonymousRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", padding: "x".repeat(70_000) })),
  baseEnv,
);
assert.equal(oversized?.status, 413);

console.log(JSON.stringify({
  ok: true,
  contract: "mare_operations_os_klaviyo_campaign_draft",
  transport: "streamable_http",
  public_discovery_methods: ["initialize", "ping", "tools/list"],
  tools: 3,
  controlled_write_tools: 1,
  tool_calls_require_authentication: true,
  separate_klaviyo_operations_key: true,
  explicit_confirmation_required: true,
  idempotency_verified: true,
  send_and_schedule_capabilities: false,
  irreversible_actions_enabled: false,
}));
