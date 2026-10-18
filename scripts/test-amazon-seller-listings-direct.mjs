import baseAssert from "node:assert/strict";
import { build } from "esbuild";

/** Offline contract tests. Every transport is synthetic, including LWA. */
let checks = 0;
const assert = new Proxy(baseAssert, {
  apply(target, receiver, args) { checks++; return Reflect.apply(target, receiver, args); },
  get(target, property) {
    const value = Reflect.get(target, property);
    return typeof value === "function" ? (...args) => { checks++; return value(...args); } : value;
  }
});
const bundled = await build({
  entryPoints: ["src/mare-business-amazon-listings-direct.ts"],
  bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent"
});
const { readAmazonSellerListingsDirect: read } = await import(
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64")
);
const env = {
  AMAZON_SP_API_CLIENT_ID: "synthetic-id",
  AMAZON_SP_API_CLIENT_SECRET: "synthetic-secret",
  AMAZON_SP_API_REFRESH_TOKEN: "synthetic-refresh",
  AMAZON_SP_API_SELLER_ID: "A123456789"
};
const markets = { IT: "APJ6JRA9NG5V4", DE: "A1PA6795UKMFR9", FR: "A13V1IB3VIYZZH", ES: "A1RKKUPIHCS9HS" };
const input = { marketplace: "IT", skus: ["SYNTH_A"] };
const fixedTime = Date.parse("2026-10-18T12:00:00.000Z");
const privateMarker = "PRIVATE_TEST_CANARY";
const privateMessage = "https://private.invalid/" + privateMarker + "?token=synthetic&email=person@example.invalid";
const originalFetch = globalThis.fetch, originalTimeout = AbortSignal.timeout;
const originalLogs = new Map(["log", "warn", "error", "info", "debug"].map(name => [name, console[name]]));
const mock = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "x-amzn-requestid": "req-synthetic-0001", ...headers }
});
const offer = (patch = {}, market = "IT") => ({
  marketplaceId: markets[market], offerType: "B2C", audience: { value: "ALL", displayName: privateMessage },
  price: { amount: "35.00", currencyCode: "EUR" }, message: privateMessage, ...patch
});
const body = (patch = {}, market = "IT", sku = "SYNTH_A") => ({
  sku,
  summaries: [{ marketplaceId: markets[market], asin: "B0TEST0001", productType: "HANDBAG",
    status: ["BUYABLE"], itemName: privateMessage }],
  fulfillmentAvailability: [{ fulfillmentChannelCode: "DEFAULT", quantity: 3 }],
  offers: [offer({}, market)],
  // Last-submitted attributes deliberately conflict with the current datasets.
  attributes: { fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 999 }],
    purchasable_offer: [{ our_price: [{ schedule: [{ value_with_tax: 999.99 }] }] }] },
  issues: [{ marketplaceId: markets[market], code: "90000", severity: "ERROR",
    categories: ["MISSING_ATTRIBUTE"], attributeNames: ["fulfillment_availability"], message: privateMessage },
  { marketplaceId: market === "IT" ? markets.DE : markets.IT, code: "OTHER_MARKET", severity: "WARNING",
    message: privateMessage }],
  private_data: privateMessage, ...patch
});
function verifyRequest(url, init, market = "IT", sku = "SYNTH_A") {
  const u = new URL(String(url));
  assert.equal(u.origin, "https://sellingpartnerapi-eu.amazon.com");
  assert.equal(u.pathname, "/listings/2021-08-01/items/A123456789/" + encodeURIComponent(sku));
  assert.deepEqual([...u.searchParams.keys()].sort(), ["includedData", "marketplaceIds"]);
  assert.equal(u.searchParams.get("marketplaceIds"), markets[market]);
  assert.equal(u.searchParams.get("includedData"), "summaries,offers,issues,fulfillmentAvailability");
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "manual");
  assert.equal(init.body, undefined);
  assert.equal(init.headers["x-amz-access-token"], "synthetic-access");
  assert.deepEqual(Object.keys(init.headers).sort(), ["Accept", "x-amz-access-token"]);
  assert(init.signal instanceof AbortSignal);
}
function safe(result) {
  assert.equal(result.read_only, true);
  assert.equal(result.provider_mutations, 0);
  assert.equal(result.has_created_or_updated_offer, false);
  assert.equal(result.can_change_stock, false);
  assert.equal(result.can_publish, false);
  assert.equal(result.must_verify_channable_writer_ownership, true);
  const serialized = JSON.stringify(result);
  for (const value of [privateMarker, "private.invalid", "person@example.invalid",
    "synthetic-secret", "synthetic-refresh", "synthetic-access"])
    assert.equal(serialized.includes(value), false);
}
function complete(entry, quantity = 3, amount = "35.00") {
  assert.equal(entry.state, "PRESENT");
  assert.equal(entry.identity_state, "VERIFIED");
  assert.equal(entry.fulfillment_state, "VERIFIED");
  assert.equal(entry.current_fbm_quantity, quantity);
  assert.equal(entry.price_state, "VERIFIED");
  assert.deepEqual(entry.current_b2c_price, { amount, currency_code: "EUR" });
  assert.equal(entry.observation_complete, true);
}
function unknownIdentity(entry) {
  assert.equal(entry.identity_state, "UNKNOWN");
  assert.equal(entry.fulfillment_state, "UNKNOWN");
  assert.equal(entry.current_fbm_quantity, null);
  assert.equal(entry.price_state, "UNKNOWN");
  assert.equal(entry.current_b2c_price, null);
  assert.deepEqual(entry.current_offers, []);
  assert.equal(entry.observation_complete, false);
}
function harness(options = {}) {
  const request = options.input ?? input, events = [];
  let index = 0;
  const deps = {
    clock: () => fixedTime,
    getAccessToken: async received => { events.push("token"); assert.equal(received, options.env ?? env); return "synthetic-access"; },
    fetch: async (url, init) => {
      const sku = request.skus[index++];
      events.push(sku);
      verifyRequest(url, init, request.marketplace, sku);
      return options.response ? options.response(sku, index) : mock(body(options.body, request.marketplace, sku));
    },
    ...options.deps
  };
  return { events, deps, run: () => read(request, options.env ?? env, deps) };
}
const one = async options => {
  const result = await harness(options).run();
  safe(result);
  assert.equal(result.observed_at, "2026-10-18T12:00:00.000Z");
  assert.equal(result.results[0].observed_at, result.observed_at);
  return result;
};
const rejected = async (operation, code) => {
  await assert.rejects(operation, error => {
    assert.equal(error.message, "amazon_seller_listings_direct_" + code);
    assert.equal(error.cause, undefined);
    assert.equal(error.message.includes(privateMarker), false);
    return true;
  });
};
let storageCalls = 0, logCalls = 0, fallbackNetworkCalls = 0;
const storage = new Proxy({}, { get() { storageCalls++; throw new Error(privateMessage); } });
env.BUSINESS_OS_KV = storage;
env.MARE_STATE = storage;
env.MARKETPLACE_ORDER_JOURNAL = storage;
env.LOGGER = storage;
try {
  for (const name of originalLogs.keys()) console[name] = () => { logCalls++; };
  // Original public signature and legacy mixed-batch presence classifications.
  let calls = [], tokenCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.origin === "https://api.amazon.com" && u.pathname === "/auth/o2/token") {
      tokenCalls++;
      assert.equal(init.method, "POST");
      assert.equal(init.body.get("grant_type"), "refresh_token");
      return mock({ access_token: "synthetic-access" });
    }
    const sku = decodeURIComponent(u.pathname.split("/").at(-1));
    verifyRequest(url, init, "IT", sku);
    calls.push(sku);
    if (sku === "SYNTH_A") return mock(body());
    if (sku === "SYNTH_B") return mock({ errors: [{ code: "NOT_FOUND", message: privateMessage }] }, 404);
    if (sku === "SYNTH_C") return mock({ errors: [{ code: "ACCESS_DENIED", message: privateMessage }] }, 404);
    if (sku === "SYNTH_D") return mock({ errors: [{ code: "THROTTLED", message: privateMessage }] }, 429);
    if (sku === "SYNTH_E") return mock(body({ sku: "WRONG_SKU" }));
    if (sku === "SYNTH_F") return mock(body({ summaries: [{ marketplaceId: markets.FR, asin: "B0TEST0002" }] }, "IT", sku));
    if (sku === "SYNTH_G") return new Response("<html>" + privateMessage + "</html>",
      { status: 404, headers: { "content-type": "text/html", "x-amzn-requestid": "request-2" } });
    if (sku === "SYNTH_H") throw new TypeError(privateMessage);
    throw new Error("unexpected_synthetic_route");
  };
  const scan = await read({ marketplace: "IT", skus: ["SYNTH_A", "SYNTH_B", "SYNTH_C", "SYNTH_D", "SYNTH_E", "SYNTH_F", "SYNTH_G", "SYNTH_H"] }, env);
  assert.equal(scan.source, "amazon_sp_api_get_listings_item");
  assert.equal(scan.report_download_dependency, false);
  assert.equal(scan.present, 2);
  assert.equal(scan.verified_absent, 1);
  assert.equal(scan.unknown, 5);
  assert.equal(scan.complete_evidence, false);
  assert.equal(scan.observation_complete, false);
  complete(scan.results[0]);
  assert.equal(scan.results[0].asin, "B0TEST0001");
  assert.deepEqual(scan.results[0].statuses, ["BUYABLE"]);
  assert.equal(scan.results[0].reported_offer_count, 1);
  assert.equal(scan.results[0].listing_issues_count, 1);
  assert.deepEqual(scan.results[0].issue_signals, [{
    code: "90000", severity: "ERROR", categories: ["MISSING_ATTRIBUTE"], attribute_names: ["fulfillment_availability"]
  }]);
  assert.equal(scan.results[0].issue_signals_truncated, false);
  assert.equal(scan.results[1].state, "VERIFIED_ABSENT");
  assert.equal(scan.results[2].state, "UNKNOWN");
  assert.equal(scan.results[3].reason, "amazon_http_429");
  assert.equal(scan.results[4].reason, "listing_response_sku_or_json_mismatch");
  assert.equal(scan.results[5].state, "PRESENT_ATTRIBUTES_UNKNOWN");
  assert.equal(scan.results[6].reason, "ambiguous_404_not_absence_proof");
  assert.equal(scan.results[7].reason, "amazon_transport_type_error");
  for (const entry of scan.results.slice(1)) unknownIdentity(entry);
  assert.equal(calls.length, 8);
  assert.equal(tokenCalls, 1);
  safe(scan);
  globalThis.fetch = async () => { fallbackNetworkCalls++; throw new Error("unexpected_offline_network"); };

  // Request selectors must be exact, immutable copies with no hidden payload.
  let getterCalls = 0;
  const getterRequest = Object.defineProperty({ ...input }, "marketplace", { enumerable: true,
    get() { getterCalls++; throw new Error(privateMessage); } });
  const getterArray = Object.defineProperty(["SYNTH_A"], "0", { enumerable: true,
    get() { getterCalls++; throw new Error(privateMessage); } });
  const extraArray = ["SYNTH_A"]; extraArray.price = 1;
  const bad = [
    null, undefined, {}, [], "IT", { ...input, marketplace: "US" }, { ...input, marketplace: "it" },
    { ...input, skus: [] }, { ...input, skus: ["A", "A"] }, { ...input, skus: Array(9).fill("A") },
    { ...input, skus: ["A\nB"] }, { ...input, skus: [" A"] }, { ...input, skus: ["A "] },
    { ...input, skus: ["../A"] }, { ...input, skus: ["A?marketplaceIds=OTHER"] },
    { ...input, skus: ["A".repeat(121)] }, { ...input, skus: [1] },
    { ...input, skus: new Array(1) }, { ...input, skus: getterArray }, { ...input, skus: extraArray },
    { ...input, mode: "LIVE" }, { ...input, quantity: 0 }, { ...input, [Symbol("hidden")]: true },
    Object.defineProperty({ ...input }, "snapshot", { value: body() }), getterRequest,
    Object.assign(Object.create({ inherited: true }), input),
    new Proxy({}, { ownKeys() { throw new Error(privateMessage); } })
  ];
  for (const value of bad) {
    const h = harness();
    await rejected(() => read(value, env, h.deps), "invalid_request");
    assert.deepEqual(h.events, []);
  }
  assert.equal(getterCalls, 0);
  for (const seller of ["", undefined, "A123456789 ", "a123456789", "A123456/89", 123]) {
    const h = harness({ env: { ...env, AMAZON_SP_API_SELLER_ID: seller } });
    const result = await h.run();
    assert.equal(result.status, "BLOCKED_SELLER_CONFIG");
    assert.equal(result.observation_complete, false);
    assert.deepEqual(h.events, []);
    safe(result);
  }
  const mutable = { marketplace: "IT", skus: ["SYNTH_A"] };
  const immutableResult = await read(mutable, env, {
    clock: () => fixedTime,
    getAccessToken: async () => { mutable.marketplace = "DE"; mutable.skus[0] = "CHANGED"; return "synthetic-access"; },
    fetch: async (url, init) => { verifyRequest(url, init); return mock(body()); }
  });
  assert.equal(immutableResult.marketplace, "IT");
  complete(immutableResult.results[0]);

  for (const marketplace of Object.keys(markets)) {
    const result = await one({ input: { marketplace, skus: ["Synthetic.MiX 001-_"] } });
    complete(result.results[0]);
    assert.equal(result.observation_complete, true);
    assert.equal(result.complete_evidence, true);
    assert.deepEqual(result.results[0].current_offers, [{
      marketplace_id: markets[marketplace], offer_type: "B2C", audience: "ALL", amount: "35.00", currency_code: "EUR"
    }]);
  }
  complete((await one({ body: { fulfillmentAvailability: [{ fulfillmentChannelCode: "DEFAULT", quantity: 0 }] } })).results[0], 0);
  const missingQuantities = [
    undefined, null, [], {}, [{ fulfillmentChannelCode: "AMAZON_EU", quantity: 20 }],
    [{ fulfillmentChannelCode: "DEFAULT" }], [{ fulfillmentChannelCode: "DEFAULT", quantity: null }],
    [{ fulfillmentChannelCode: "DEFAULT", quantity: 1 }, { fulfillmentChannelCode: "DEFAULT", quantity: 1 }],
    [{ fulfillmentChannelCode: "DEFAULT", quantity: 1 }, { fulfillmentChannelCode: "DEFAULT", quantity: 2 }],
    [{ quantity: 3 }], [null],
    ...[true, "0", -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(quantity => [{ fulfillmentChannelCode: "DEFAULT", quantity }]),
    Array(33).fill({ fulfillmentChannelCode: "AMAZON_EU" })
  ];
  for (const fulfillmentAvailability of missingQuantities) {
    const result = await one({ body: { fulfillmentAvailability } });
    assert.equal(result.results[0].identity_state, "VERIFIED");
    assert.equal(result.results[0].fulfillment_state, "UNKNOWN");
    assert.equal(result.results[0].current_fbm_quantity, null);
    assert.equal(result.results[0].price_state, "VERIFIED");
    assert.equal(result.results[0].observation_complete, false);
    assert.equal(result.observation_complete, false);
    assert.equal(result.complete_evidence, true);
  }
  complete((await one({ body: { fulfillmentAvailability: [
    { fulfillmentChannelCode: "AMAZON_EU", quantity: 100 },
    { fulfillmentChannelCode: "DEFAULT", quantity: 3 }
  ] } })).results[0]);

  // Nothing from quantity/offers can be attributed before the identity checks.
  for (const patch of [
    { sku: "OTHER" }, { summaries: [] }, { summaries: null },
    { summaries: [{ marketplaceId: markets.DE, asin: "B0TEST0001" }] },
    { summaries: [{ marketplaceId: markets.IT, asin: "b0test0001" }] },
    { summaries: [{ marketplaceId: markets.IT, asin: privateMessage }] },
    { summaries: [{ marketplaceId: markets.IT, asin: null }] },
    { summaries: [{ marketplaceId: markets.IT, asin: "B0TEST0001" }, { marketplaceId: markets.IT, asin: "B0TEST0001" }] }
  ]) {
    const result = await one({ body: patch });
    unknownIdentity(result.results[0]);
    assert.equal(result.observation_complete, false);
  }
  const missingSummary = await one({ body: { summaries: [] } });
  assert.equal(missingSummary.results[0].state, "PRESENT_ATTRIBUTES_UNKNOWN");
  assert.equal(missingSummary.complete_evidence, true, "Legacy presence flag must not be redefined");
  assert.equal(missingSummary.observation_complete, false);
  complete((await one({ body: { summaries: [
    { marketplaceId: markets.DE, asin: "B0TEST0002" },
    { marketplaceId: markets.IT, asin: "B0TEST0001" }
  ] } })).results[0]);

  // Amounts remain exact strings, including trailing zeros and long fractions.
  for (const amount of ["0.00", "35.0000", "12345678901234567890.123456789012345678901234567890", "1.25e+2"]) {
    const result = await one({ body: { offers: [offer({ price: { amount, currencyCode: "EUR" } })] } });
    complete(result.results[0], 3, amount);
  }
  const mixed = await one({ body: { offers: [
    offer({ offerType: "B2B", audience: { value: "B2B" }, price: { amount: "10.00", currencyCode: "EUR" } }),
    offer({ audience: { value: "PRIME" }, price: { amount: "20.00", currencyCode: "EUR" } }),
    offer(), offer({ price: { amount: "99.00", currencyCode: "EUR" } }, "DE")
  ] } });
  complete(mixed.results[0]);
  assert.equal(mixed.results[0].current_offers.length, 3);
  assert.equal(mixed.results[0].reported_offer_count, 3);
  for (const offers of [
    undefined, null, [], {}, [offer({}, "DE")],
    [offer({ offerType: "B2B", audience: { value: "ALL" } })],
    [offer({ audience: { value: "PRIME" } })], [offer({ audience: undefined })],
    [offer(), offer()], [offer(), offer({ price: { amount: "36.00", currencyCode: "EUR" } })]
  ]) {
    const result = await one({ body: { offers } });
    assert.equal(result.results[0].price_state, "UNKNOWN");
    assert.equal(result.results[0].current_b2c_price, null);
    assert.equal(result.results[0].fulfillment_state, "VERIFIED");
    assert.equal(result.results[0].observation_complete, false);
  }
  const noAudience = (await one({ body: { offers: [offer({ audience: undefined })] } })).results[0];
  assert.equal(noAudience.current_offers[0].audience, null);
  assert.equal(noAudience.price_reason, "b2c_all_offer_missing");
  const duplicate = (await one({ body: { offers: [offer(), offer()] } })).results[0];
  assert.equal(duplicate.price_reason, "b2c_all_offer_ambiguous");
  const currency = (await one({ body: { offers: [offer({ price: { amount: "35.00", currencyCode: "USD" } })] } })).results[0];
  assert.equal(currency.price_reason, "b2c_all_currency_mismatch");
  assert.equal(currency.current_offers[0].currency_code, "USD");
  assert.equal(currency.current_b2c_price, null);
  const invalidOffers = [
    [null], [offer({ marketplaceId: null })], [offer({ marketplaceId: privateMessage })],
    [offer({ offerType: "B2X" })], [offer({ offerType: null })],
    ...[null, "ALL", {}, [], { value: null }, { value: privateMessage }].map(audience => [offer({ audience })]),
    ...[35, true, null, "", "-0.01", "NaN", "Infinity", " 35.00", "01.00", "1.", "1,00", "0x1",
      "1e", "1e+", "+.12", "1".repeat(81)].map(amount => [offer({ price: { amount, currencyCode: "EUR" } })]),
    ...["eur", "", null, privateMessage].map(currencyCode => [offer({ price: { amount: "35.00", currencyCode } })]),
    Array(33).fill(offer())
  ];
  for (const offers of invalidOffers) {
    const result = await one({ body: { offers } });
    assert.equal(result.results[0].price_state, "UNKNOWN");
    assert.equal(result.results[0].current_b2c_price, null);
    assert.deepEqual(result.results[0].current_offers, []);
  }
  const sanitized = await one({ body: {
    summaries: [{ marketplaceId: markets.IT, asin: "B0TEST0001", productType: privateMessage,
      status: ["BUYABLE", privateMessage] }],
    issues: [{ code: privateMessage, severity: privateMessage, categories: [privateMessage],
      attributeNames: [privateMessage], message: privateMessage }]
  } });
  assert.equal(sanitized.results[0].product_type, null);
  assert.deepEqual(sanitized.results[0].statuses, ["BUYABLE"]);
  assert.deepEqual(sanitized.results[0].issue_signals[0], {
    code: "UNVERIFIED", severity: "UNVERIFIED", categories: ["UNVERIFIED"], attribute_names: ["UNVERIFIED"]
  });

  // Typed bounded 404 remains supported; ambiguous 404 never means absence.
  for (const response of [
    () => mock({ errors: [{ code: "NOT_FOUND" }] }, 404, { "x-amzn-requestid": "" }),
    () => mock({ errors: [{ code: "NOT_FOUND" }] }, 404, { "x-amzn-requestid": privateMessage }),
    () => mock({ errors: [{ code: {} }] }, 404),
    () => mock({ errors: [{ code: { toString: privateMessage } }] }, 404),
    () => mock({ errors: [{ code: "NOT_FOUND" }, { code: "NOT_FOUND" }] }, 404)
  ]) {
    const result = await one({ response });
    assert.equal(result.results[0].state, "UNKNOWN");
    assert.equal(result.results[0].reason, "ambiguous_404_not_absence_proof");
    unknownIdentity(result.results[0]);
  }
  const absent = await one({ response: () => mock({ errors: [{ code: "NotFound", message: privateMessage }] }, 404) });
  assert.equal(absent.results[0].state, "VERIFIED_ABSENT");
  assert.equal(absent.complete_evidence, true);
  assert.equal(absent.observation_complete, false);
  unknownIdentity(absent.results[0]);

  // HTTP error and redirect bodies are unread and never followed.
  for (const status of [201, 202, 301, 302, 307, 308, 400, 401, 403, 413, 415, 418, 429, 500, 502, 503, 504]) {
    let reads = 0, cancels = 0;
    const result = await one({ response: () => new Response(new ReadableStream({
      pull() { reads++; throw new Error(privateMessage); }, cancel() { cancels++; }
    }, { highWaterMark: 0 }), { status, headers: { "content-type": "application/json", Location: privateMessage } }) });
    unknownIdentity(result.results[0]);
    assert.equal(result.results[0].reason, [400, 401, 403, 413, 415, 429, 500, 502, 503, 504].includes(status)
      ? "amazon_http_" + status : "amazon_http_unexpected_status");
    assert.equal(reads, 0);
    assert.equal(cancels, 1);
  }
  for (const contentType of ["text/html", "application/jsonp", ""]) {
    const result = await one({ response: () => new Response(privateMessage, { headers: { "content-type": contentType } }) });
    unknownIdentity(result.results[0]);
  }
  complete((await one({ response: () => mock(body(), 200, { "content-type": "Application/JSON; charset=utf-8" }) })).results[0]);
  for (const value of [null, [], true, "data"]) {
    unknownIdentity((await one({ response: () => mock(value) })).results[0]);
  }
  for (const [response, reason] of [
    [() => new Response("{invalid", { headers: { "content-type": "application/json" } }), "amazon_response_invalid_json"],
    [() => new Response(null, { headers: { "content-type": "application/json" } }), "amazon_response_invalid_json"],
    [() => new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } }), "amazon_response_read_failed"],
    [() => new Response(new ReadableStream({ pull(controller) { controller.error(new Error(privateMessage)); } }),
      { headers: { "content-type": "application/json" } }), "amazon_response_read_failed"]
  ]) {
    const result = await one({ response });
    assert.equal(result.results[0].reason, reason);
    unknownIdentity(result.results[0]);
  }
  for (const error of [new TypeError(privateMessage), new Error(privateMessage), privateMessage]) {
    const result = await one({ deps: { fetch: async () => { throw error; } } });
    unknownIdentity(result.results[0]);
    assert.equal(result.results[0].reason, error instanceof TypeError ? "amazon_transport_type_error" : "amazon_transport_other");
  }

  // Actual bytes, not characters or a trusted Content-Length header.
  for (const response of [
    () => mock(body({ ignored: "\u03a9".repeat(500_000) })),
    () => mock(body({ ignored: "x".repeat(1_000_001) }), 200, { "content-length": "1" }),
    () => mock({ errors: [{ code: "NOT_FOUND", message: "x".repeat(1_000_001) }] }, 404)
  ]) {
    const result = await one({ response });
    assert.equal(result.results[0].reason, "amazon_response_too_large");
    unknownIdentity(result.results[0]);
  }
  let earlyReads = 0, earlyCancels = 0;
  const early = await one({ response: () => new Response(new ReadableStream({
    pull() { earlyReads++; }, cancel() { earlyCancels++; }
  }, { highWaterMark: 0 }), { headers: { "content-type": "application/json", "content-length": "1000001" } }) });
  assert.equal(early.results[0].reason, "amazon_response_too_large");
  assert.equal(earlyReads, 0);
  assert.equal(earlyCancels, 1);
  const base = body({ padding: "" });
  base.padding = "x".repeat(1_000_000 - Buffer.byteLength(JSON.stringify(base)));
  assert.equal(Buffer.byteLength(JSON.stringify(base)), 1_000_000);
  complete((await one({ response: () => mock(base) })).results[0]);
  const encoded = new TextEncoder().encode(JSON.stringify(body({ ignored: "\u03a9" })));
  const utf8Start = encoded.indexOf(0xce), chunks = [encoded.slice(0, utf8Start + 1), encoded.slice(utf8Start + 1)];
  assert(utf8Start > 0);
  complete((await one({ response: () => new Response(new ReadableStream({
    pull(controller) { if (chunks.length) controller.enqueue(chunks.shift()); else controller.close(); }
  }), { headers: { "content-type": "application/json" } }) })).results[0]);

  // One deadline covers headers and every chunk, with no sleep or real timer.
  for (const stalledBody of [false, true]) {
    const deadline = new AbortController();
    let timerCalls = 0, cancels = 0;
    AbortSignal.timeout = ms => { timerCalls++; assert.equal(ms, 20_000); return deadline.signal; };
    const deps = stalledBody ? { fetch: async () => new Response(new ReadableStream({
      pull() { queueMicrotask(() => deadline.abort()); }, cancel() { cancels++; }
    }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } }) } : {
      fetch: () => { queueMicrotask(() => deadline.abort()); return new Promise(() => {}); }
    };
    try {
      const result = await one({ deps });
      assert.equal(result.results[0].reason, "amazon_transport_timeout");
      unknownIdentity(result.results[0]);
    } finally { AbortSignal.timeout = originalTimeout; }
    assert.equal(timerCalls, 1);
    assert.equal(cancels, stalledBody ? 1 : 0);
  }
  const partial = await one({ input: { marketplace: "IT", skus: ["SYNTH_A", "SYNTH_B"] },
    response: (sku, index) => index === 1 ? mock({ errors: [] }, 429) : mock(body({}, "IT", sku)) });
  unknownIdentity(partial.results[0]);
  complete(partial.results[1]);
  assert.equal(partial.observation_complete, false);

  for (const token of ["", " ", null, true, "token\nheader", "a".repeat(16_385)]) {
    const h = harness({ deps: { getAccessToken: async () => token } });
    await rejected(h.run, "authentication_failed");
    assert.deepEqual(h.events, []);
  }
  await rejected(harness({ deps: { getAccessToken: async () => { throw new Error(privateMessage); } } }).run, "authentication_failed");
  for (const time of [NaN, Infinity, -1, 1.5, "123", 8_640_000_000_000_001]) {
    const h = harness({ deps: { clock: () => time } });
    await rejected(h.run, "invalid_clock");
    assert.deepEqual(h.events, []);
  }
  assert.equal(storageCalls, 0);
  assert.equal(logCalls, 0);
  assert.equal(fallbackNetworkCalls, 0);
} finally {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
  for (const [name, value] of originalLogs) console[name] = value;
}
console.log("PASS Amazon seller Listings current stock/price: " + checks +
  " checks; legacy presence, four markets, current DEFAULT quantity, exact decimal B2C ALL price, identity gating, bounded GET, no writes/leaks.");
