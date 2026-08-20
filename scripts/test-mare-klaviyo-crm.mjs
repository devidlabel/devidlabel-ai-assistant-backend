import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "mare-klaviyo-crm-"));
execFileSync("npx", [
  "tsc",
  "--project", "tsconfig.json",
  "--outDir", out,
  "--noEmit", "false",
], { stdio: "inherit" });

const crm = await import(`file://${join(out, "mare-business-klaviyo-crm.js")}`);
const mcp = await import(`file://${join(out, "mare-business-klaviyo-crm-mcp.js")}`);

const env = {
  KLAVIYO_PRIVATE_API_KEY: "pk_test_read_only",
  MARE_BUSINESS_ACCESS_TOKEN: "mare-test-token",
};

const calls = [];
let mode = "audiences";
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  calls.push({ url: url.toString(), headers: init.headers || {} });
  const headers = new Headers(init.headers || {});
  assert.equal(headers.get("Authorization"), "Klaviyo-API-Key pk_test_read_only");
  assert.equal(headers.get("Revision"), "2026-07-15");

  if (mode === "audiences") {
    if (url.pathname === "/api/lists") {
      return Response.json({
        data: [{ type: "list", id: "LIST1", attributes: { name: "K-Way Buyers", created: "2026-01-01", updated: "2026-08-20", opt_in_process: "double_opt_in" } }],
        links: { next: null },
      });
    }
    if (url.pathname === "/api/segments") {
      return Response.json({
        data: [{ type: "segment", id: "SEG1", attributes: { name: "K-Way Engaged 90d", created: "2026-01-02", updated: "2026-08-20", is_active: true } }],
        links: { next: null },
      });
    }
    if (url.pathname === "/api/lists/LIST1") return Response.json({ data: { attributes: { profile_count: 321 } } });
    if (url.pathname === "/api/segments/SEG1") return Response.json({ data: { attributes: { profile_count: 654 } } });
  }

  if (mode === "consent" && url.pathname === "/api/profiles") {
    assert.equal(url.searchParams.get("additional-fields[profile]"), "subscriptions");
    const sparse = url.searchParams.get("fields[profile]") || "";
    assert.ok(sparse.includes("can_receive_email_marketing"));
    assert.ok(sparse.includes("consent"));
    return Response.json({
      data: [
        {
          type: "profile",
          id: "SECRET_PROFILE_1",
          attributes: {
            email: "must-not-escape@example.com",
            subscriptions: { email: { marketing: { can_receive_email_marketing: true, consent: "SUBSCRIBED" } } },
          },
        },
        {
          type: "profile",
          id: "SECRET_PROFILE_2",
          attributes: {
            email: "must-not-escape-2@example.com",
            subscriptions: { email: { marketing: { can_receive_email_marketing: false, consent: "UNSUBSCRIBED" } } },
          },
        },
      ],
      links: { next: null },
    });
  }

  return Response.json({ errors: [{ detail: `unexpected_mock_request:${url.pathname}` }] }, { status: 400 });
};

const audiences = await crm.readKlaviyoAudienceOverview({ query: "k-way", inline_limit: 10, count_limit: 1 }, env);
assert.equal(audiences.ok, true);
assert.equal(audiences.read_only, true);
assert.equal(audiences.lists.items[0].profile_count, 321);
assert.equal(audiences.segments.items[0].profile_count, 654);
assert.equal(audiences.count_policy.maximum_count_limit, 5);

mode = "consent";
const consent = await crm.readKlaviyoConsentAggregate({ max_records: 1000 }, env);
assert.equal(consent.ok, true);
assert.equal(consent.read_only, true);
assert.equal(consent.population.scanned, 2);
assert.equal(consent.population.complete, true);
assert.equal(consent.email_marketing.can_receive, 1);
assert.equal(consent.email_marketing.cannot_receive, 1);
assert.equal(consent.email_marketing.consent_status.SUBSCRIBED, 1);
assert.equal(consent.email_marketing.consent_status.UNSUBSCRIBED, 1);
const serializedConsent = JSON.stringify(consent);
assert.equal(serializedConsent.includes("SECRET_PROFILE_1"), false);
assert.equal(serializedConsent.includes("must-not-escape@example.com"), false);

function rpc(name, args) {
  return new Request("https://internal.mare/mcp-business", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer mare-test-token",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
}

const describeResponse = await mcp.handleMareKlaviyoCrmMcpRequest(rpc("mare_describe", { capability_id: "klaviyo.crm.consent.aggregate" }), env);
assert.ok(describeResponse);
const describeBody = await describeResponse.json();
assert.equal(describeBody.result.structuredContent.capability.available, true);
assert.equal(describeBody.result.structuredContent.capability.privacy.individual_contact_data_returned, false);

const callsBeforeRejectedRequest = calls.length;
const rejectedResponse = await mcp.handleMareKlaviyoCrmMcpRequest(rpc("mare_read", {
  capability_id: "klaviyo.crm.consent.aggregate",
  request: { email: "not-allowed@example.com" },
}), env);
assert.ok(rejectedResponse);
const rejectedBody = await rejectedResponse.json();
assert.equal(rejectedBody.result.isError, true);
assert.match(rejectedBody.result.structuredContent.error, /klaviyo_crm_request_field_not_allowed/);
assert.equal(calls.length, callsBeforeRejectedRequest, "disallowed request fields must fail before Klaviyo network access");

const workerSource = readFileSync("src/worker-v4.ts", "utf8");
const adapterSource = readFileSync("src/mare-business-klaviyo-crm-mcp.ts", "utf8");
const crmSource = readFileSync("src/mare-business-klaviyo-crm.ts", "utf8");
assert.ok(workerSource.indexOf("handleMareKlaviyoCrmMcpRequest") < workerSource.indexOf("handleMareAutonomyMcpRequest(request"), "Klaviyo read adapter must route before generic MCP handling");
for (const fragment of [
  '"klaviyo.crm.audiences.read"',
  '"klaviyo.crm.consent.aggregate"',
  'individual_contact_data_returned: false',
  'write_capability: false',
  'additionalProperties: false',
]) assert.ok(adapterSource.includes(fragment), `Missing Klaviyo CRM adapter safeguard: ${fragment}`);
for (const fragment of [
  'KLAVIYO_REVISION = "2026-07-15"',
  'aggregate_and_group_metadata_only_no_individual_contact_data',
  'aggregate_only_no_profile_identifiers_or_contact_data_returned',
  'fields[profile]',
  'additional-fields[profile]',
]) assert.ok(crmSource.includes(fragment), `Missing Klaviyo CRM privacy/provider fragment: ${fragment}`);

console.log(JSON.stringify({
  ok: true,
  contract: "mare_klaviyo_crm_aggregate_reads",
  read_only: true,
  capabilities: ["klaviyo.crm.audiences.read", "klaviyo.crm.consent.aggregate"],
  individual_contact_data_returned: false,
  bounded_group_counts: true,
  consent_aggregate_only: true,
  disallowed_request_fields_blocked_before_network: true,
}));
