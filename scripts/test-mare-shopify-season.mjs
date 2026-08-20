import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "mare-shopify-season-"));
execFileSync("npx", [
  "tsc",
  "--project", "tsconfig.json",
  "--outDir", out,
  "--noEmit", "false",
], { stdio: "inherit" });

const { assignMissingShopifyProductSeasons } = await import(`file://${join(out, "mare-business-shopify-season.js")}`);

const env = {
  SHOPIFY_SHOP_DOMAIN: "example.myshopify.com",
  SHOPIFY_ADMIN_ACCESS_TOKEN: "test-admin-token",
  SHOPIFY_API_VERSION: "2025-10",
};

const PRODUCT_ID = "gid://shopify/Product/123";
const METAOBJECT_ID = "gid://shopify/Metaobject/99";
const calls = [];
let phase = "success";

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = async (url, init) => {
  const payload = JSON.parse(init.body);
  calls.push({ url: String(url), query: payload.query, variables: payload.variables });

  if (payload.query.includes("query MareResolveSeasonMetaobjects")) {
    if (phase === "unresolved") return response({ data: { s0: null } });
    assert.deepEqual(payload.variables.h0, { type: "product_feature_season", handle: "continuous" });
    return response({ data: { s0: { id: METAOBJECT_ID, handle: "continuous", type: "product_feature_season" } } });
  }

  if (payload.query.includes("mutation MareAssignMissingProductSeason")) {
    assert.equal(payload.variables.metafields.length, 1);
    assert.deepEqual(payload.variables.metafields[0], {
      ownerId: PRODUCT_ID,
      namespace: "features",
      key: "season",
      type: "metaobject_reference",
      value: METAOBJECT_ID,
      compareDigest: null,
    });
    return response({ data: { metafieldsSet: { metafields: [{ id: "gid://shopify/Metafield/7", namespace: "features", key: "season", type: "metaobject_reference", value: METAOBJECT_ID, compareDigest: "digest-new" }], userErrors: [] } } });
  }

  if (payload.query.includes("query MareSeasonState")) {
    if (phase === "existing") {
      return response({ data: { p0: { __typename: "Product", id: PRODUCT_ID, metafield: { id: "gid://shopify/Metafield/6", namespace: "features", key: "season", type: "metaobject_reference", value: "gid://shopify/Metaobject/88", compareDigest: "digest-existing", reference: { id: "gid://shopify/Metaobject/88", handle: "spring-summer", type: "product_feature_season" } } } } });
    }
    const mutationAlreadyCalled = calls.some((call) => call.query.includes("mutation MareAssignMissingProductSeason"));
    return response({ data: { p0: { __typename: "Product", id: PRODUCT_ID, metafield: mutationAlreadyCalled ? { id: "gid://shopify/Metafield/7", namespace: "features", key: "season", type: "metaobject_reference", value: METAOBJECT_ID, compareDigest: "digest-new", reference: { id: METAOBJECT_ID, handle: "continuous", type: "product_feature_season" } } : null } } });
  }

  return response({ errors: [{ message: "unexpected query" }] }, 400);
};

const result = await assignMissingShopifyProductSeasons({
  assignments: [{ product_id: PRODUCT_ID, season_reference: "product_feature_season.continuous" }],
}, env);

assert.equal(result.ok, true);
assert.equal(result.assigned_count, 1);
assert.equal(result.atomic_write, true);
assert.equal(result.concurrency_control, "compare_digest_null_create_if_absent");
assert.equal(result.field_allowlist.owner_type, "Product");
assert.equal(result.field_allowlist.namespace, "features");
assert.equal(result.field_allowlist.key, "season");
assert.equal(result.field_allowlist.metafield_type, "metaobject_reference");
assert.equal(result.field_allowlist.metaobject_type, "product_feature_season");
assert.equal(result.overwrite_existing_allowed, false);
assert.equal(result.arbitrary_metafield_creation_allowed, false);
assert.equal(result.delete_allowed, false);
assert.equal(result.before[0].season_reference, null);
assert.equal(result.after[0].season_reference, "product_feature_season.continuous");
assert.equal(calls.length, 4, "resolve metaobject, pre-read, atomic mutation and readback expected");

const beforeInvalid = calls.length;
await assert.rejects(
  () => assignMissingShopifyProductSeasons({ assignments: [{ product_id: PRODUCT_ID, season_reference: "custom.anything" }] }, env),
  /invalid_shopify_season_reference/,
);
assert.equal(calls.length, beforeInvalid, "invalid season reference must fail before network access");

await assert.rejects(
  () => assignMissingShopifyProductSeasons({ assignments: [
    { product_id: PRODUCT_ID, season_reference: "product_feature_season.continuous" },
    { product_id: PRODUCT_ID, season_reference: "product_feature_season.continuous" },
  ] }, env),
  /duplicate_shopify_season_product/,
);

phase = "unresolved";
const beforeUnresolved = calls.length;
await assert.rejects(
  () => assignMissingShopifyProductSeasons({ assignments: [{ product_id: PRODUCT_ID, season_reference: "product_feature_season.continuous" }] }, env),
  /shopify_season_metaobject_not_found/,
);
assert.equal(calls.length, beforeUnresolved + 1, "unresolved metaobject must stop before product read or mutation");

phase = "existing";
const beforeExisting = calls.length;
await assert.rejects(
  () => assignMissingShopifyProductSeasons({ assignments: [{ product_id: PRODUCT_ID, season_reference: "product_feature_season.continuous" }] }, env),
  /shopify_season_must_be_missing/,
);
assert.equal(calls.length, beforeExisting + 2, "existing season must stop after metaobject resolve and pre-read, before mutation");

const safeSource = readFileSync("src/mare-business-mcp-safe.ts", "utf8");
const policySource = readFileSync("src/mare-autonomy-policy.ts", "utf8");
for (const fragment of [
  'SHOPIFY_SEASON_CAPABILITY_ID = "shopify.product.season.assign_missing"',
  'assignMissingShopifyProductSeasons',
  'prepareShopifySeasonWrite',
  'executeShopifySeasonPlan',
  'shopify_missing_season_first_class: true',
  'compare_digest_null_create_if_absent: true',
]) assert.ok(safeSource.includes(fragment), `Missing Business OS season integration: ${fragment}`);
for (const fragment of [
  '"shopify.product.season.assign_missing"',
  'MARE_AUTONOMY_POLICY_VERSION = "p4"',
  'metaobject_type: "product_feature_season"',
  'overwrite_allowed: false',
  'arbitrary_metafield_creation_allowed: false',
]) assert.ok(policySource.includes(fragment), `Missing season policy guardrail: ${fragment}`);

console.log(JSON.stringify({
  ok: true,
  contract: "mare_shopify_missing_product_season_autonomy",
  capability: "shopify.product.season.assign_missing",
  maximum_atomic_items: 25,
  exact_field: "features.season",
  metafield_type: "metaobject_reference",
  metaobject_type: "product_feature_season",
  create_if_absent_cas: true,
  overwrite_existing_allowed: false,
  arbitrary_metafield_creation_allowed: false,
  delete_allowed: false,
  read_before_write: true,
  read_after_write: true,
}));
