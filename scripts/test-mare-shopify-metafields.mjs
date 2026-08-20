import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "mare-shopify-metafields-"));
execFileSync("npx", [
  "tsc",
  "--project", "tsconfig.json",
  "--outDir", out,
  "--noEmit", "false",
], { stdio: "inherit" });

const { updateExistingShopifyMetafields } = await import(`file://${join(out, "mare-business-shopify-metafields.js")}`);

const env = {
  SHOPIFY_SHOP_DOMAIN: "example.myshopify.com",
  SHOPIFY_ADMIN_ACCESS_TOKEN: "test-admin-token",
  SHOPIFY_API_VERSION: "2025-10",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const calls = [];
let phase = "success";
globalThis.fetch = async (url, init) => {
  const payload = JSON.parse(init.body);
  calls.push({ url: String(url), query: payload.query, variables: payload.variables });

  if (phase === "missing") {
    return jsonResponse({
      data: { m0: { __typename: "Product", metafield: null } },
    });
  }

  if (phase === "cas_error") {
    if (payload.query.includes("mutation MareSetExistingMetafields")) {
      return jsonResponse({
        data: {
          metafieldsSet: {
            metafields: [],
            userErrors: [{ field: ["metafields", "0", "compareDigest"], code: "STALE_OBJECT", message: "Compare digest did not match." }],
          },
        },
      });
    }
    return jsonResponse({
      data: {
        m0: {
          __typename: "Product",
          metafield: {
            id: "gid://shopify/Metafield/11",
            namespace: "custom",
            key: "season",
            type: "single_line_text_field",
            value: "old",
            compareDigest: "digest-old",
          },
        },
      },
    });
  }

  if (payload.query.includes("mutation MareSetExistingMetafields")) {
    assert.equal(payload.variables.metafields.length, 1);
    assert.deepEqual(payload.variables.metafields[0], {
      ownerId: "gid://shopify/Product/123",
      namespace: "custom",
      key: "season",
      type: "single_line_text_field",
      value: "Autunno/Inverno 2026-2027",
      compareDigest: "digest-old",
    });
    return jsonResponse({
      data: {
        metafieldsSet: {
          metafields: [{
            id: "gid://shopify/Metafield/11",
            namespace: "custom",
            key: "season",
            type: "single_line_text_field",
            value: "Autunno/Inverno 2026-2027",
            compareDigest: "digest-new",
          }],
          userErrors: [],
        },
      },
    });
  }

  const readback = calls.some((call) => call.query.includes("mutation MareSetExistingMetafields"));
  return jsonResponse({
    data: {
      m0: {
        __typename: "Product",
        metafield: {
          id: "gid://shopify/Metafield/11",
          namespace: "custom",
          key: "season",
          type: "single_line_text_field",
          value: readback ? "Autunno/Inverno 2026-2027" : "old",
          compareDigest: readback ? "digest-new" : "digest-old",
        },
      },
    },
  });
};

const result = await updateExistingShopifyMetafields({
  metafields: [{
    owner_id: "gid://shopify/Product/123",
    namespace: "custom",
    key: "season",
    value: "Autunno/Inverno 2026-2027",
  }],
}, env);

assert.equal(result.ok, true);
assert.equal(result.updated_count, 1);
assert.equal(result.atomic_write, true);
assert.equal(result.concurrency_control, "compare_digest_cas");
assert.equal(result.creation_allowed, false);
assert.equal(result.deletion_allowed, false);
assert.equal(result.before[0].value, "old");
assert.equal(result.after[0].value, "Autunno/Inverno 2026-2027");
assert.equal(calls.length, 3, "one batched pre-read, one atomic mutation and one batched readback expected");

const callsBeforeValidation = calls.length;
await assert.rejects(
  () => updateExistingShopifyMetafields({
    metafields: [{ owner_id: "gid://shopify/Product/123", namespace: "seo", key: "title", value: "x" }],
  }, env),
  /shopify_metafield_namespace_not_allowed/,
);
assert.equal(calls.length, callsBeforeValidation, "invalid namespace must fail before Shopify network access");

await assert.rejects(
  () => updateExistingShopifyMetafields({
    metafields: [{ owner_id: "gid://shopify/Customer/123", namespace: "custom", key: "test", value: "x" }],
  }, env),
  /invalid_shopify_metafield_owner/,
);

await assert.rejects(
  () => updateExistingShopifyMetafields({
    metafields: [
      { owner_id: "gid://shopify/Product/123", namespace: "custom", key: "season", value: "x" },
      { owner_id: "gid://shopify/Product/123", namespace: "custom", key: "season", value: "y" },
    ],
  }, env),
  /duplicate_shopify_metafield_target/,
);

phase = "missing";
const beforeMissing = calls.length;
await assert.rejects(
  () => updateExistingShopifyMetafields({
    metafields: [{ owner_id: "gid://shopify/Product/123", namespace: "custom", key: "missing", value: "x" }],
  }, env),
  /shopify_metafield_must_already_exist/,
);
assert.equal(calls.length, beforeMissing + 1, "missing metafield must stop after the pre-read and never mutate");

phase = "cas_error";
await assert.rejects(
  () => updateExistingShopifyMetafields({
    metafields: [{ owner_id: "gid://shopify/Product/123", namespace: "custom", key: "season", value: "new" }],
  }, env),
  /shopify_metafields_set_rejected/,
);

const safeSource = readFileSync("src/mare-business-mcp-safe.ts", "utf8");
const autonomySource = readFileSync("src/mare-autonomy-runner.ts", "utf8");
const policySource = readFileSync("src/mare-autonomy-policy.ts", "utf8");
for (const fragment of [
  'SHOPIFY_METAFIELD_CAPABILITY_ID = "shopify.metafields.update_existing"',
  'risk: "reversible_write"',
  'approval: "explicit"',
  'prepareShopifyMetafieldWrite',
  'executeShopifyMetafieldPlan',
  'updateExistingShopifyMetafields(plan.request, env)',
  'required_confirmation: "EXECUTE MARE PLAN"',
  'shopify_existing_metafields_first_class: true',
]) assert.ok(safeSource.includes(fragment), `Missing first-class Shopify Business OS fragment: ${fragment}`);

for (const fragment of [
  'callBusinessTool(env, "mare_prepare"',
  'callBusinessTool(env, "mare_validate"',
  'callBusinessTool(env, "mare_execute"',
  'coordinated_plan_ledger: true',
  'audit_schema: "mare_autonomy_p3"',
  'from "./mare-autonomy-policy.js"',
]) assert.ok(autonomySource.includes(fragment), `Missing coordinated autonomy fragment: ${fragment}`);
assert.ok(policySource.includes('"shopify.metafields.update_existing"'), "Shared policy must own the Shopify AUTO+LOG capability");
assert.equal(autonomySource.includes('import { updateExistingShopifyMetafields }'), false, "Autonomy runner must not bypass the Business OS plan coordinator");
assert.equal(autonomySource.includes('if (job.capability_id === "shopify.metafields.update_existing")'), false, "Shopify autonomy must not have a direct execution shortcut");
assert.equal(autonomySource.includes("const AUTO_CAPABILITIES = new Set"), false, "Autonomy runner must not duplicate its capability allowlist");

console.log(JSON.stringify({
  ok: true,
  contract: "mare_shopify_existing_metafields_autonomy",
  maximum_atomic_items: 25,
  allowed_namespace: "custom",
  allowed_owner_types: ["Product", "ProductVariant"],
  compare_digest_cas: true,
  read_before_write: true,
  read_after_write: true,
  creation_allowed: false,
  deletion_allowed: false,
  business_os_first_class: true,
  immutable_plan_required: true,
  coordinator_ledger_required: true,
  shared_policy_registry: true,
  direct_runner_shortcut_allowed: false,
}));
