import assert from "node:assert/strict";
import {build} from "esbuild";

// Synthetic response metadata only. This suite never contacts a store or
// changes OAuth, inventory, order, fulfillment, KV or journal state.
const built = await build({
  entryPoints: ["src/marketplace-shopify-api-readiness.ts"],
  bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent",
});
const {
  MARKETPLACE_SHOPIFY_SUPPORTED_API_VERSION: pin,
  SHOPIFY_API_READINESS_QUERY: query,
  readMarketplaceShopifyApiReadiness: read,
} = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));

const PRIVATE = "PRIVATE_TEST_VALUE_MUST_NOT_ESCAPE";
const installationId = "gid://shopify/AppInstallation/7301";
let checks = 0;
const equal = (actual, expected, message) => {assert.deepEqual(actual, expected, message); checks++;};
const check = (value, message) => {assert(value, message); checks++;};
const rejects = async (fn, code) => {
  await assert.rejects(fn, error => error.message === code && !error.message.includes(PRIVATE));
  checks++;
};
const observation = (requested = pin, served = pin) => ({
  requested_api_version: requested, served_api_version: served,
  data: {currentAppInstallation: {id: installationId}},
});
const env = Object.freeze({
  SHOPIFY_SHOP_DOMAIN: "synthetic-store.myshopify.com", SHOPIFY_API_VERSION: pin,
  SHOPIFY_ADMIN_ACCESS_TOKEN: PRIVATE,
  SHOPIFY_TOKENS_KV: {get: async () => {throw new Error("Unexpected token store read");},
    put: async () => {throw new Error("Unexpected KV write");}},
});
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let externalCalls = 0;
const fixedTime = Date.parse("2026-10-18T18:00:00.000Z");
function locked(report) {
  for (const key of ["can_import_orders", "can_update_tracking", "can_change_inventory",
    "can_publish_offers", "ready_for_marketplace_writes", "customer_data_returned", "credential_returned"])
    equal(report[key], false, `${key} must remain false`);
  equal(report.provider_mutations, 0);
  equal(report.read_only, true);
  const serialized = JSON.stringify(report);
  check(!serialized.includes(PRIVATE), "No private upstream/configuration value may escape");
  check(!serialized.includes(installationId), "Installation ID is internal only");
}
try {
  globalThis.fetch = async () => {externalCalls++; throw new Error("Live network forbidden in this suite");};
  Date.now = () => fixedTime;
  equal(pin, "2026-01", "The minimal supported pin is deliberate and version matched");
  let calls = 0;
  const result = await read(env, async (receivedEnv, receivedQuery, variables) => {
    equal(receivedEnv, env);
    equal(receivedQuery, "query MareMarketplaceShopifyApiReadiness { currentAppInstallation { id } }");
    equal(receivedQuery, query);
    equal(variables, {});
    calls++;
    return observation();
  });
  equal(calls, 1, "One observation through the same M.A.R.E. client is sufficient");
  equal(result.status, "API_VERSION_VERIFIED_EXECUTION_STILL_LOCKED");
  equal(result.observed_at, "2026-10-18T18:00:00.000Z");
  equal(result.requested_api_version, pin);
  equal(result.served_api_version, pin);
  equal(result.api_version_alignment_verified, true);
  equal(result.api_version_matches_request, true);
  equal(result.configured_version_matches_pin, true);
  equal(result.selected_pin_support_current, true);
  equal(result.blockers, []);
  locked(result);

  const withoutExplicitPin = {...env};
  delete withoutExplicitPin.SHOPIFY_API_VERSION;
  equal((await read(withoutExplicitPin, async () => observation())).requested_api_version, pin);
  const withExtraData = observation();
  withExtraData.data.currentAppInstallation.access_token = PRIVATE;
  withExtraData.data.customer = {email: PRIVATE};
  withExtraData.privateTransportHeader = PRIVATE;
  locked(await read(env, async () => withExtraData));

  for (const served of [null, ""]) {
    const row = await read(env, async () => observation(pin, served));
    equal(row.status, "API_VERSION_HEADER_MISSING");
    equal(row.version_header_status, "MISSING");
    equal(row.served_api_version, null);
    equal(row.api_version_alignment_verified, false);
    check(row.blockers.includes("shopify_api_version_header_missing"));
    locked(row);
  }
  for (const served of [PRIVATE, `2026-01\n${PRIVATE}`, " 2026-01", "2026-01 ", "2026-02",
    "latest", "unstable", "2026-01, 2026-04", 202601, false, {}, [], undefined]) {
    const row = await read(env, async () => ({...observation(), served_api_version: served}));
    equal(row.status, "API_VERSION_HEADER_INVALID");
    equal(row.version_header_status, "INVALID");
    equal(row.served_api_version, null, "Invalid raw headers are never reflected");
    equal(row.api_version_alignment_verified, false);
    locked(row);
  }
  for (const served of ["2025-10", "2026-04", "2026-10", "2027-01"]) {
    const row = await read(env, async () => observation(pin, served));
    equal(row.status, "API_VERSION_MISMATCH");
    equal(row.served_api_version, served);
    equal(row.api_version_matches_request, false);
    equal(row.api_version_alignment_verified, false);
    check(row.blockers.includes("shopify_api_version_mismatch"));
    locked(row);
  }
  const fallForward = await read({...env, SHOPIFY_API_VERSION: "2025-10"},
    async () => observation("2025-10", pin));
  equal(fallForward.status, "API_VERSION_MISMATCH");
  equal(fallForward.requested_api_version, "2025-10");
  equal(fallForward.served_api_version, pin);
  equal(fallForward.configured_version_matches_pin, false);
  equal(fallForward.api_version_alignment_verified, false);
  locked(fallForward);
  for (const otherPin of ["2025-10", "2026-04"]) {
    const row = await read({...env, SHOPIFY_API_VERSION: otherPin},
      async () => observation(otherPin, otherPin));
    equal(row.status, "API_VERSION_PIN_MISMATCH");
    equal(row.api_version_matches_request, true);
    equal(row.configured_version_matches_pin, false);
    equal(row.api_version_alignment_verified, false);
    locked(row);
  }

  const expiresAt = Date.parse(result.support_expires_at);
  Date.now = () => expiresAt - 1;
  equal((await read(env, async () => observation())).selected_pin_support_current, true);
  for (const when of [expiresAt, expiresAt + 1, Date.parse("2025-12-31T23:59:59.999Z")]) {
    Date.now = () => when;
    const row = await read(env, async () => observation());
    equal(row.status, "API_VERSION_SUPPORT_WINDOW_UNVERIFIED");
    equal(row.api_version_matches_request, true);
    equal(row.selected_pin_support_current, false);
    equal(row.api_version_alignment_verified, false);
    locked(row);
  }
  Date.now = () => fixedTime;

  for (const malformed of [null, [], {}, {requested_api_version: pin},
    {...observation(), requested_api_version: `2026-01/${PRIVATE}`},
    {...observation(), requested_api_version: "2026-04"}])
    await rejects(() => read(env, async () => malformed), "marketplace_shopify_api_metadata_invalid");
  for (const data of [undefined, null, [], {}, {currentAppInstallation: null},
    {currentAppInstallation: []}, {currentAppInstallation: {}},
    {currentAppInstallation: {id: PRIVATE}},
    {currentAppInstallation: {id: "gid://shopify/Order/7301"}},
    {currentAppInstallation: {id: `gid://shopify/AppInstallation/7301\n${PRIVATE}`}},
    {currentAppInstallation: {id: 7301}}])
    await rejects(() => read(env, async () => ({...observation(), data})),
      "marketplace_shopify_api_response_invalid");
  for (const failure of [new Error(PRIVATE), PRIVATE, {body: PRIVATE}])
    await rejects(() => read(env, async () => {throw failure;}), "marketplace_shopify_api_probe_failed");

  let invalidConfigCalls = 0;
  const shouldNotRead = async () => {invalidConfigCalls++; return observation();};
  for (const badEnv of [null, [], {}, {...env, SHOPIFY_SHOP_DOMAIN: `https://${PRIVATE}.example`},
    {...env, SHOPIFY_SHOP_DOMAIN: "synthetic.myshopify.com.example"},
    {...env, SHOPIFY_SHOP_DOMAIN: "synthetic.myshopify.com/path"},
    ...[PRIVATE, "latest", "unstable", "2026-02", "2026-01 ", "2026-01/graphql.json", 202601]
      .map(version => ({...env, SHOPIFY_API_VERSION: version}))])
    await rejects(() => read(badEnv, shouldNotRead), "marketplace_shopify_api_config_invalid");
  equal(invalidConfigCalls, 0, "Invalid configuration is rejected before the reader");
  equal(externalCalls, 0, "Every test is offline and every external operation remains blocked");
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
}
console.log(`PASS ${checks} Shopify API readiness checks: matched pin, missing/invalid headers, fall-forward, support expiry, redaction and execution lock`);
