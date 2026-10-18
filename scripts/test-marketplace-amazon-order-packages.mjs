import assert from "node:assert/strict";
import { build } from "esbuild";

// Offline fixtures only. No live orders, tracking numbers or credentials.
const built = await build({
  entryPoints: ["src/marketplace-amazon-order-packages.ts"],
  bundle: true, platform: "neutral", format: "esm", write: false, logLevel: "silent"
});
const { readAmazonOrderPackagesPrivate: read } = await import("data:text/javascript;base64," +
  Buffer.from(built.outputFiles[0].text).toString("base64"));
let checks = 0;
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const check = (value, message) => { assert(value, message); checks++; };
const PRIVATE = "PRIVATE_PROVIDER_ERROR_CANARY";
const CUSTOMER = "SYNTHETIC_CUSTOMER_FIELDS_MUST_BE_DISCARDED";
const TRACKING = "SYNTHETIC-TRACK-001";
const TOKEN = "synthetic-access-token";
const ID = "123-1111111-2222222";
const MARKETS = { IT: "APJ6JRA9NG5V4", DE: "A1PA6795UKMFR9", FR: "A13V1IB3VIYZZH", ES: "A1RKKUPIHCS9HS" };
const env = Object.freeze({
  AMAZON_SP_API_CLIENT_ID: "synthetic-client", AMAZON_SP_API_CLIENT_SECRET: "synthetic-secret",
  AMAZON_SP_API_REFRESH_TOKEN: "synthetic-refresh", AMAZON_SP_API_SELLER_ID: "A123456789"
});
const input = Object.freeze({ amazon_order_id: ID, marketplace: "DE" });
const fixed = Date.parse("2026-10-18T12:00:00.000Z");
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" }
});
const fixture = () => ({ order: {
  orderId: ID, createdTime: "2026-10-17T08:00:00Z", lastUpdatedTime: "2026-10-18T09:00:00Z",
  salesChannel: { channelName: "AMAZON", marketplaceId: MARKETS.DE },
  fulfillment: { fulfilledBy: "MERCHANT", fulfillmentStatus: "SHIPPED" },
  buyer: { buyerName: CUSTOMER, buyerEmail: CUSTOMER }, recipient: { deliveryAddress: { name: CUSTOMER } },
  orderAliases: [{ aliasId: CUSTOMER }], arbitrary_extra: CUSTOMER,
  orderItems: [{
    orderItemId: "SYNTHETIC-LINE-01", quantityOrdered: 2,
    product: { sellerSku: "00Case-A  ", title: CUSTOMER, customization: { customizedUrl: CUSTOMER } },
    fulfillment: { quantityFulfilled: 2, quantityUnfulfilled: 0, packing: { giftOption: { giftMessage: CUSTOMER } } }
  }],
  packages: [{
    packageReferenceId: "SYNTHETIC-PACKAGE-A", carrier: "Synthetic Carrier", trackingNumber: TRACKING,
    shipTime: "2026-10-18T08:30:00Z", createdTime: "2026-10-18T08:00:00Z",
    packageStatus: { status: "SHIPPED", detailedStatus: CUSTOMER }, shippingService: CUSTOMER,
    shipFromAddress: { name: CUSTOMER, addressLine1: CUSTOMER },
    packageItems: [{ orderItemId: "SYNTHETIC-LINE-01", quantity: 2, transparencyCodes: [CUSTOMER] }]
  }]
} });
const originalFetch = globalThis.fetch;
let forbiddenCalls = 0;
const rejects = async (fn, code) => {
  await assert.rejects(fn, error => {
    equal(error.message, "amazon_order_packages_" + code);
    check(!error.message.includes(PRIVATE) && !error.message.includes(CUSTOMER) &&
      !error.message.includes(TOKEN) && !error.message.includes(TRACKING));
    return true;
  });
  checks++;
};
function harness(body = fixture(), overrides = {}) {
  let authCalls = 0, fetchCalls = 0;
  const dependencies = {
    clock: () => fixed,
    getAccessToken: async receivedEnv => { equal(receivedEnv, env); authCalls++; return TOKEN; },
    fetch: async (url, init) => {
      fetchCalls++;
      const parsed = new URL(String(url));
      equal(parsed.origin, "https://sellingpartnerapi-eu.amazon.com");
      equal(parsed.pathname, "/orders/2026-01-01/orders/" + ID);
      equal([...parsed.searchParams], [["includedData", "FULFILLMENT,PACKAGES"]]);
      equal(init.method, "GET"); equal(init.redirect, "manual"); equal(init.body, undefined);
      equal(init.headers, { "x-amz-access-token": TOKEN, Accept: "application/json" });
      check(init.signal instanceof AbortSignal && !init.signal.aborted);
      return json(body);
    }, ...overrides
  };
  return { dependencies, authCalls: () => authCalls, fetchCalls: () => fetchCalls };
}
async function readFixture(body, request = input) {
  const h = harness(body);
  const output = await read(request, env, h.dependencies);
  equal(h.authCalls(), 1); equal(h.fetchCalls(), 1);
  return output;
}
async function badFixture(change, code) {
  const body = fixture(); change(body.order, body);
  const h = harness(body);
  await rejects(() => read(input, env, h.dependencies), code);
}
function locked(output) {
  equal(output.ok, true); equal(output.read_only, true); equal(output.provider_mutations, 0);
  equal(output.private_tracking_transient_only, true);
  for (const flag of ["buyer_recipient_datasets_requested", "customer_fields_returned",
    "can_confirm_shipment", "can_change_inventory", "can_advance_checkpoint"]) equal(output[flag], false);
  check(!JSON.stringify(output).includes(CUSTOMER), "Discard all non-allowlisted provider fields");
  check(!JSON.stringify(output).includes(TOKEN), "Credentials never enter the projection");
}

try {
  globalThis.fetch = async () => { forbiddenCalls++; throw new Error("Live requests forbidden"); };
  const output = await readFixture(fixture());
  locked(output);
  equal(output.source, "amazon_spapi_order_packages_2026_01_01");
  equal(output.identity_scope, "SELLER_ACCOUNT_PLUS_ORDER_ID");
  equal(output.account_id, env.AMAZON_SP_API_SELLER_ID); equal(output.order_id, ID);
  equal(output.order_key, `amazon:${env.AMAZON_SP_API_SELLER_ID}:${ID}`);
  equal(output.marketplace, "DE"); equal(output.marketplace_id, MARKETS.DE);
  equal(output.observed_at, "2026-10-18T12:00:00.000Z");
  equal(output.fulfillment_owner, "MERCHANT"); equal(output.fulfillment_status, "SHIPPED");
  equal(output.items, [{ line_id: "SYNTHETIC-LINE-01", seller_sku: "00Case-A  ",
    quantity_ordered: 2, quantity_fulfilled: 2, quantity_unfulfilled: 0 }]);
  equal(output.packages, [{ package_reference_id: "SYNTHETIC-PACKAGE-A", carrier: "Synthetic Carrier",
    tracking_number: TRACKING, ship_time: "2026-10-18T08:30:00Z", package_status: "SHIPPED",
    items: [{ line_id: "SYNTHETIC-LINE-01", quantity: 2 }] }]);

  for (const [marketplace, marketplaceId] of Object.entries(MARKETS)) {
    const body = fixture(); body.order.salesChannel.marketplaceId = marketplaceId;
    const result = await readFixture(body, { amazon_order_id: ID, marketplace });
    equal(result.marketplace_id, marketplaceId);
  }
  for (const missing of [undefined, null, []]) {
    const body = fixture(); body.order.packages = missing;
    const result = await readFixture(body);
    equal(result.packages, missing === undefined ? null : missing); locked(result);
  }
  const minimal = fixture();
  minimal.order.fulfillment = undefined;
  minimal.order.orderItems[0].fulfillment = undefined;
  minimal.order.orderItems[0].product = {};
  minimal.order.packages = [{ packageReferenceId: "OPAQUE-NONNUMERIC-REFERENCE" }];
  const optional = await readFixture(minimal);
  equal(optional.fulfillment_owner, null); equal(optional.fulfillment_status, null);
  equal(optional.items[0].seller_sku, null); equal(optional.items[0].quantity_fulfilled, null);
  equal(optional.items[0].quantity_unfulfilled, null);
  equal(optional.packages, [{ package_reference_id: "OPAQUE-NONNUMERIC-REFERENCE", carrier: null,
    tracking_number: null, ship_time: null, package_status: null, items: null }]);
  const emptyItems = fixture(); emptyItems.order.packages[0].packageItems = [];
  equal((await readFixture(emptyItems)).packages[0].items, []);
  for (const value of [null, undefined, "", "   "]) {
    const body = fixture(); body.order.packages[0].trackingNumber = value;
    equal((await readFixture(body)).packages[0].tracking_number, null);
  }
  const opaque = fixture(); opaque.order.packages[0].trackingNumber = "  00Abc-Case  ";
  equal((await readFixture(opaque)).packages[0].tracking_number, "  00Abc-Case  ");
  for (const status of ["PENDING", "IN_TRANSIT", "SHIPPED", "DELIVERED", "CANCELLED", "UNDELIVERABLE"]) {
    const body = fixture(); body.order.packages[0].packageStatus.status = status;
    equal((await readFixture(body)).packages[0].package_status, status);
  }
  const split = fixture(); split.order.packages[0].packageItems[0].quantity = 1;
  split.order.packages.push({ ...structuredClone(split.order.packages[0]), packageReferenceId: "SYNTHETIC-PACKAGE-B",
    trackingNumber: "SYNTHETIC-TRACK-002" });
  equal((await readFixture(split)).packages.length, 2, "One order line can span distinct packages");
  const zero = fixture(); zero.order.orderItems[0].quantityOrdered = 0;
  zero.order.orderItems[0].fulfillment = { quantityFulfilled: 0, quantityUnfulfilled: 0 };
  zero.order.packages[0].packageItems[0].quantity = 0;
  const zeroOutput = await readFixture(zero);
  equal(zeroOutput.items[0].quantity_ordered, 0); equal(zeroOutput.packages[0].items[0].quantity, 0);
  locked(zeroOutput);

  // Selectors and configuration fail before token, provider, KV or DO access.
  const guards = harness();
  for (const bad of [null, [], "text", {}, { amazon_order_id: ID }, { ...input, marketplace: "de" },
    { ...input, marketplace: "__proto__" }, { ...input, marketplace: "US" },
    { ...input, amazon_order_id: "../" + ID }, { ...input, amazon_order_id: 123 },
    { ...input, amazon_order_id: ID + "\n" }, { ...input, snapshot: fixture() },
    { ...input, tracking_number: TRACKING }, { ...input, seller_id: "A999999999" },
    { ...input, includedData: "BUYER" }, { ...input, confirm: true },
    { ...input, [Symbol("hidden")]: true }])
    await rejects(() => read(bad, env, guards.dependencies), "invalid_request");
  for (const seller of [undefined, null, "", "invalid seller", "a123456789", PRIVATE])
    await rejects(() => read(input, { ...env, AMAZON_SP_API_SELLER_ID: seller }, guards.dependencies), "seller_not_configured");
  for (const time of [NaN, Infinity, -1, 0.25, Number.MAX_SAFE_INTEGER, "2026-10-18"])
    await rejects(() => read(input, env, { ...guards.dependencies, clock: () => time }), "invalid_clock");
  equal(guards.authCalls(), 0); equal(guards.fetchCalls(), 0);

  await badFixture(o => { o.orderId = "123-1111111-2222223"; }, "order_identity_conflict");
  await badFixture(o => { o.salesChannel.marketplaceId = MARKETS.FR; }, "order_identity_conflict");
  await badFixture(o => { o.salesChannel.channelName = "NON_AMAZON"; }, "order_identity_conflict");
  await badFixture(o => { o.fulfillment.fulfilledBy = "AMAZON"; }, "not_merchant_fulfilled");
  await badFixture(o => { o.fulfillment.fulfillmentStatus = PRIVATE; }, "invalid_fulfillment_status");
  await badFixture(o => { o.createdTime = PRIVATE; }, "invalid_time");
  await badFixture(o => { o.lastUpdatedTime = "2026-10-16T08:00:00Z"; }, "invalid_time");
  await badFixture(o => { o.packages[0].shipTime = PRIVATE; }, "invalid_time");
  await badFixture(o => { o.orderItems.push(structuredClone(o.orderItems[0])); }, "duplicate_line_id");
  await badFixture(o => { o.packages.push(structuredClone(o.packages[0])); }, "duplicate_package_reference");
  await badFixture(o => { o.packages[0].packageItems.push(structuredClone(o.packages[0].packageItems[0])); }, "duplicate_package_line_id");
  await badFixture(o => { o.packages[0].packageItems[0].orderItemId = "OTHER-ORDER-LINE"; }, "package_line_identity_conflict");
  await badFixture(o => { o.orderItems[0].orderItemId = "\n" + PRIVATE; }, "invalid_line_id");
  await badFixture(o => { o.packages[0].packageReferenceId = ""; }, "invalid_package_reference");
  await badFixture(o => { o.packages[0].packageStatus = {}; }, "invalid_package_status");
  await badFixture(o => { o.packages[0].packageStatus.status = PRIVATE; }, "invalid_package_status");
  await badFixture(o => { o.packages[0].trackingNumber = "\n" + PRIVATE; }, "invalid_tracking_number");
  await badFixture(o => { o.packages[0].trackingNumber = "x".repeat(257); }, "invalid_tracking_number");
  await badFixture(o => { o.packages[0].carrier = {}; }, "invalid_carrier");
  await badFixture(o => { o.orderItems[0].product.sellerSku = 42; }, "invalid_sku");
  for (const value of ["1", true, {}, [], -1, 0.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    await badFixture(o => { o.orderItems[0].quantityOrdered = value; }, "invalid_quantity");
    await badFixture(o => { o.packages[0].packageItems[0].quantity = value; }, "invalid_quantity");
    if (value !== null) await badFixture(o => { o.orderItems[0].fulfillment.quantityFulfilled = value; }, "invalid_quantity");
  }
  for (const [field, code] of [["packages", "invalid_packages"], ["orderItems", "invalid_order_items"]])
    await badFixture(o => { o[field] = {}; }, code);
  await badFixture(o => { o.packages[0].packageItems = {}; }, "invalid_package_items");
  await badFixture(o => { o.packages = Array.from({ length: 51 }, () => o.packages[0]); }, "invalid_packages");
  await badFixture(o => { o.orderItems = Array.from({ length: 201 }, () => o.orderItems[0]); }, "invalid_order_items");
  await badFixture(o => { o.packages[0].packageItems = Array.from({ length: 201 }, () => o.packages[0].packageItems[0]); }, "invalid_package_items");
  await badFixture(o => { o.orderItems[0].quantityOrdered = Number.MAX_SAFE_INTEGER;
    o.orderItems.push({ ...o.orderItems[0], orderItemId: "SYNTHETIC-LINE-02", quantityOrdered: 1 }); }, "quantity_overflow");
  await badFixture(o => { o.packages[0].packageItems[0].quantity = Number.MAX_SAFE_INTEGER;
    o.packages.push({ ...structuredClone(o.packages[0]), packageReferenceId: "SYNTHETIC-PACKAGE-B" }); }, "quantity_overflow");

  // Transport failures never include raw tokens, URLs, identifiers or bodies.
  const h = harness();
  await rejects(() => read(input, env, { ...h.dependencies, getAccessToken: async () => { throw new Error(PRIVATE); } }), "auth_failed");
  for (const token of [undefined, null, 1, "", "bad\n" + PRIVATE])
    await rejects(() => read(input, env, { ...h.dependencies, getAccessToken: async () => token }), "auth_failed");
  await rejects(() => read(input, env, { ...h.dependencies, fetch: async () => { throw new Error(PRIVATE); } }), "transport_failed");
  await rejects(() => read(input, env, { ...h.dependencies, fetch: async () => { throw new DOMException(PRIVATE, "AbortError"); } }), "transport_timeout");
  for (const status of [302, 400, 403, 404, 429, 500, 503]) {
    let pulls = 0, cancels = 0;
    const stream = new ReadableStream({ pull() { pulls++; throw new Error(PRIVATE); }, cancel() { cancels++; } }, { highWaterMark: 0 });
    await rejects(() => read(input, env, { ...h.dependencies,
      fetch: async () => new Response(stream, { status, headers: { Location: "https://untrusted.invalid/" + PRIVATE } }) }), "http_" + status);
    equal(pulls, 0, "Do not consume provider error or redirect bodies"); equal(cancels, 1);
  }
  for (const text of [PRIVATE, "", "{", '{"order":null}', JSON.stringify({ payload: fixture().order })]) {
    const code = text === '{"order":null}' || text.startsWith('{"payload"') ? "invalid_response" : "invalid_json";
    await rejects(() => read(input, env, { ...h.dependencies, fetch: async () => new Response(text) }), code);
  }
  const nonfinite = JSON.stringify(fixture()).replace('"quantityOrdered":2', '"quantityOrdered":1e400');
  await rejects(() => read(input, env, { ...h.dependencies, fetch: async () => new Response(nonfinite) }), "invalid_quantity");
  let cancelled = 0, reads = 0;
  const oversized = new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(2_000_001)); },
    cancel() { cancelled++; }
  }, { highWaterMark: 0 });
  await rejects(() => read(input, env, { ...h.dependencies, fetch: async () => new Response(oversized) }), "response_too_large");
  equal(reads, 2); equal(cancelled, 1, "Stop streaming after the byte limit");
  await rejects(() => read(input, env, { ...h.dependencies,
    fetch: async () => new Response("{}", { headers: { "Content-Length": "4000001" } }) }), "response_too_large");
  const broken = new ReadableStream({ pull(controller) { controller.error(new Error(PRIVATE)); } }, { highWaterMark: 0 });
  await rejects(() => read(input, env, { ...h.dependencies, fetch: async () => new Response(broken) }), "response_read_failed");
  await rejects(() => read(input, env, { ...h.dependencies,
    fetch: async () => new Response(new Uint8Array([0xc3, 0x28])) }), "response_read_failed");
  // A hanging response body is interrupted too; do not wait twenty seconds in tests.
  const originalTimeout = AbortSignal.timeout;
  const deadline = new AbortController();
  let stalledCancelled = 0;
  try {
    AbortSignal.timeout = milliseconds => { equal(milliseconds, 20_000); return deadline.signal; };
    const stalled = new ReadableStream({
      pull() { queueMicrotask(() => deadline.abort()); },
      cancel() { stalledCancelled++; }
    }, { highWaterMark: 0 });
    await rejects(() => read(input, env, { ...h.dependencies,
      fetch: async () => new Response(stalled) }), "transport_timeout");
    equal(stalledCancelled, 1, "Cancel a stalled reader when its shared deadline expires");
  } finally { AbortSignal.timeout = originalTimeout; }
  let clockCalls = 0;
  await rejects(() => read(input, env, { ...h.dependencies, clock: () => fixed - clockCalls++ }), "invalid_clock");

  // Actual default resolver path: the only POST is the existing LWA exchange.
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url)); requests.push([u.origin + u.pathname, init.method]);
    if (u.href === "https://api.amazon.com/auth/o2/token") {
      equal(init.method, "POST"); equal(init.body.get("grant_type"), "refresh_token");
      equal(init.body.get("refresh_token"), env.AMAZON_SP_API_REFRESH_TOKEN);
      equal(init.body.has("scope"), false);
      return json({ access_token: TOKEN });
    }
    equal(u.origin, "https://sellingpartnerapi-eu.amazon.com"); equal(init.method, "GET");
    equal(init.redirect, "manual"); return json(fixture());
  };
  locked(await read(input, env, { clock: () => fixed }));
  equal(requests, [["https://api.amazon.com/auth/o2/token", "POST"],
    ["https://sellingpartnerapi-eu.amazon.com/orders/2026-01-01/orders/" + ID, "GET"]]);
  equal(forbiddenCalls, 0);
  console.log(`PASS ${checks} Amazon package reader checks: selectors, private projection, missing data, quantities, identity, streamed bounds and sanitized failures`);
} finally { globalThis.fetch = originalFetch; }
