import baseAssert from "node:assert/strict";
import { build } from "esbuild";

/** Offline only. Every provider transport is synthetic; no listing is written. */
let checks = 0;
const assert = new Proxy(baseAssert, {
  apply(target, receiver, args) { checks++; return Reflect.apply(target, receiver, args); },
  get(target, property) {
    const value = Reflect.get(target, property);
    return typeof value === "function" ? (...args) => { checks++; return value(...args); } : value;
  }
});
const compiled = await build({
  entryPoints: ["src/mare-business-amazon-offer-preview.ts"], bundle: true,
  format: "esm", platform: "neutral", write: false, logLevel: "silent"
});
const { previewAmazonOfferOnlyZeroQuantity: preview, validateAmazonOfferPreviewRequest: validate } =
  await import("data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const input = Object.freeze({ marketplace: "IT", sku: "SYNTHETIC_001", ean: "2000000001234", asin: "B0TEST0001" });
const markets = { IT: "APJ6JRA9NG5V4", DE: "A1PA6795UKMFR9", FR: "A13V1IB3VIYZZH", ES: "A1RKKUPIHCS9HS" };
const secretMarker = "PRIVATE_TEST_CANARY";
const rawPrivateMessage = "https://private.invalid/" + secretMarker + "?token=synthetic&email=person@example.invalid";
const env = {
  AMAZON_SP_API_CLIENT_ID: "synthetic-client",
  AMAZON_SP_API_CLIENT_SECRET: "synthetic-secret",
  AMAZON_SP_API_REFRESH_TOKEN: "synthetic-refresh",
  AMAZON_SP_API_SELLER_ID: "A123456789",
  AMAZON_OFFER_PREVIEW_ENABLED: "true",
  SHOPIFY_SHOP_DOMAIN: "synthetic-store.myshopify.com",
  SHOPIFY_ADMIN_ACCESS_TOKEN: "synthetic-shopify-token",
  SHOPIFY_API_VERSION: "2026-01"
};
const fixedTime = Date.parse("2026-10-18T12:00:00.000Z");
const reviewRequired = [
  "seller_identity_and_listing_known_positive_control",
  "seller_asin_independent_absence_and_channable_writer_proof",
  "catalog_color_size_model_and_child_asin",
  "offer_attributes_gpsr_product_type_schema",
  "live_order_stock_budget",
  "channable_writer_ownership"
];
const proof = (selected = input, patch = {}) => ({
  ok: true, status: "REVIEW_REQUIRED", ...selected,
  exact_ean_asin: true,
  seller_listing_absence_result: "NOT_FOUND_VERIFIED_BY_LISTINGS_API",
  seller_asin_search_result: "NO_SELLER_ASIN_IN_BOUNDED_SEARCH",
  seller_asin_search_is_not_final_absence_proof: true,
  listing_request_id: "synthetic-request-123", restriction_count: 0,
  schema_product_type: "PRODUCT", schema_requirements: "LISTING_OFFER_ONLY",
  schema_version: "synthetic-version", schema_checksum: "c3ludGhldGljLXRlc3QxMg==",
  shopify_currency: "EUR", shopify_price_minor: 2599, shopify_stock_observed: 3,
  product_variant_id: "gid://shopify/ProductVariant/111",
  read_only: true, has_created_offer: false, live_listing_write_enabled: false,
  review_required: [...reviewRequired], ...patch
});
const providerResult = (patch = {}, selected = input) => ({
  sku: selected.sku, status: "VALID", submissionId: "SYNTHETIC_SUBMISSION", issues: [], ...patch
});
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const flags = (result, performed) => {
  assert.equal(result.preview_only, true);
  assert.equal(result.offer_created, false);
  assert.equal(result.listing_write_enabled, false);
  assert.equal(result.can_publish, false);
  assert.equal(result.provider_mutations, 0);
  assert.equal(result.provider_validation_performed, performed);
  assert.equal(result.full_schema_validated, false);
  assert.equal(result.gpsr_compliance_proven, false);
  assert.equal(result.channable_handoff_performed, false);
};
const noPrivate = result => {
  const serialized = JSON.stringify(result);
  for (const value of [secretMarker, "private.invalid", "person@example.invalid",
    "synthetic-secret", "synthetic-refresh", "synthetic-shopify-token", "synthetic-access-token"])
    assert.equal(serialized.includes(value), false);
};
const rejects = async (operation, code) => {
  await assert.rejects(operation, error => {
    assert.equal(error.message, "amazon_offer_preview_" + code);
    assert.equal(error.cause, undefined);
    assert.equal(error.message.includes(secretMarker), false);
    return true;
  });
};
function verifyPut(url, init, selected = input, price = 25.99) {
  const u = new URL(String(url));
  assert.equal(u.origin, "https://sellingpartnerapi-eu.amazon.com");
  assert.equal(u.pathname, "/listings/2021-08-01/items/A123456789/" + encodeURIComponent(selected.sku));
  assert.deepEqual([...u.searchParams.keys()].sort(), ["marketplaceIds", "mode"]);
  assert.equal(u.searchParams.get("mode"), "VALIDATION_PREVIEW");
  assert.equal(u.searchParams.get("marketplaceIds"), markets[selected.marketplace]);
  assert.equal(init.method, "PUT");
  assert.equal(init.redirect, "manual");
  assert(init.signal instanceof AbortSignal);
  assert.equal(init.headers["x-amz-access-token"], "synthetic-access-token");
  assert.deepEqual(Object.keys(init.headers).sort(), ["Accept", "Content-Type", "x-amz-access-token"]);
  assert.deepEqual(JSON.parse(init.body), {
    productType: "PRODUCT", requirements: "LISTING_OFFER_ONLY",
    attributes: {
      merchant_suggested_asin: [{ value: selected.asin, marketplace_id: markets[selected.marketplace] }],
      condition_type: [{ value: "new_new", marketplace_id: markets[selected.marketplace] }],
      fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 0, marketplace_id: markets[selected.marketplace] }],
      purchasable_offer: [{ currency: "EUR", our_price: [{ schedule: [{ value_with_tax: price }] }],
        marketplace_id: markets[selected.marketplace] }]
    }
  });
}
function harness(options = {}) {
  const events = [];
  const selected = options.input ?? input;
  const deps = {
    clock: () => fixedTime,
    preflightReader: async value => {
      events.push("preflight");
      assert.deepEqual(value, selected);
      assert.equal(Object.isFrozen(value), true);
      return proof(value, options.proof);
    },
    getAccessToken: async receivedEnv => { events.push("token"); assert.equal(receivedEnv, options.env ?? env); return "synthetic-access-token"; },
    fetch: async (url, init) => {
      events.push("preview");
      verifyPut(url, init, selected, (options.proof?.shopify_price_minor ?? 2599) / 100);
      return options.response ? options.response() : json(providerResult({}, selected));
    },
    ...options.deps
  };
  return { deps, events, run: () => preview(selected, options.env ?? env, deps) };
}

const rfrZeroItem=Object.freeze({...input,sku:"RFR_SYNTHETIC_001"});
const rfrZeroCase=harness({input:rfrZeroItem,
 proof:{shopify_stock_observed:0,amazon_brand_expected:"Refrigiwear"}});
const rfrZeroResponse=await rfrZeroCase.run();
assert.equal(rfrZeroResponse.amazon_preview_status,"VALID");
assert.deepEqual(rfrZeroCase.events,["preflight","token","preview"]);
const otherZeroCase=harness({proof:{shopify_stock_observed:0,
 amazon_brand_expected:"Refrigiwear"}});
assert.equal((await otherZeroCase.run()).reason,"preflight_or_schema_evidence_unverified");
const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
const originals = new Map(["log", "warn", "error", "debug", "info"].map(name => [name, console[name]]));
let forbiddenPersistenceCalls = 0, unexpectedNetworkCalls = 0, logCalls = 0;
const storage = new Proxy({}, {
  get() { forbiddenPersistenceCalls++; throw new Error(rawPrivateMessage); }
});
try {
  globalThis.fetch = async () => { unexpectedNetworkCalls++; throw new Error("unexpected_offline_network"); };
  for (const name of originals.keys()) console[name] = () => { logCalls++; };
  env.BUSINESS_OS_KV = storage;
  env.MARE_STATE = storage;
  env.MARKETPLACE_ORDER_JOURNAL = storage;
  env.LOGGER = storage;

  // Strict four-field validation runs before any provider/preflight access.
  const validated = validate(input);
  assert.deepEqual(validated, input);
  assert.notEqual(validated, input);
  assert.equal(Object.isFrozen(validated), true);
  assert.deepEqual(validate(Object.assign(Object.create(null), input)), input);
  const hiddenExtra = Object.defineProperty({ ...input }, "quantity", { value: 0 });
  const symbolExtra = { ...input, [Symbol("mode")]: "LIVE" };
  const hiddenRequired = Object.defineProperty({ ...input }, "sku", { enumerable: false, value: input.sku });
  let getterCalls = 0;
  const getterInput = Object.defineProperty({ ...input }, "sku", { enumerable: true, get() { getterCalls++; throw new Error(rawPrivateMessage); } });
  const malformed = [
    null, undefined, 1, "test", [], {}, { ...input, mode: "LIVE" }, { ...input, quantity: 0 },
    { ...input, preflight: proof() }, { ...input, price: 2599 }, hiddenExtra, symbolExtra, hiddenRequired, getterInput,
    Object.assign(Object.create({ arbitrary: true }), input),
    { ...input, marketplace: "US" }, { ...input, marketplace: "it" }, { ...input, marketplace: "IT " },
    { ...input, sku: " " + input.sku }, { ...input, sku: input.sku + " " }, { ...input, sku: "a\nb" },
    { ...input, sku: "../test" }, { ...input, sku: "a/b" }, { ...input, sku: "a?mode=LIVE" },
    { ...input, sku: "A".repeat(121) }, { ...input, sku: 123 }, { ...input, ean: 2000000001234 },
    { ...input, ean: "2000000001235" }, { ...input, ean: "1234567890123" },
    { ...input, asin: "b0test0001" }, { ...input, asin: "B0TEST0001 " }, { ...input, asin: null },
    new Proxy({}, { ownKeys() { throw new Error(rawPrivateMessage); } })
  ];
  for (const name of Object.keys(input)) { const candidate = { ...input }; delete candidate[name]; malformed.push(candidate); }
  for (const candidate of malformed) {
    assert.throws(() => validate(candidate), error => error.message === "amazon_offer_preview_invalid_input");
    const h = harness({ input: candidate });
    // Explicitly supply malformed null/undefined rather than harness defaults.
    await rejects(() => preview(candidate, env, h.deps), "invalid_input");
    assert.deepEqual(h.events, []);
  }
  assert.equal(getterCalls, 0);
  for (const flag of [undefined, false, true, "", "false", "TRUE", " true", 1]) {
    const h = harness({ env: { ...env, AMAZON_OFFER_PREVIEW_ENABLED: flag } });
    const result = await h.run();
    assert.equal(result.reason, "amazon_validation_preview_disabled");
    flags(result, false);
    assert.deepEqual(h.events, []);
  }
  for (const seller of [undefined, "", "a123456789", "A123456789 ", "A1234567/other", 123]) {
    const h = harness({ env: { ...env, AMAZON_SP_API_SELLER_ID: seller } });
    const result = await h.run();
    assert.equal(result.reason, "amazon_seller_id_missing");
    assert.deepEqual(h.events, []);
  }

  // Each required preflight fact independently gates the validation request.
  const badProofs = [
    { ok: false }, { status: "APPROVED" }, { marketplace: "DE" }, { sku: "OTHER" }, { ean: "2000000001241" },
    { asin: "B0TEST0002" }, { exact_ean_asin: false }, { seller_listing_absence_result: "UNKNOWN" },
    { seller_asin_search_result: "SELLER_ASIN_LISTING_FOUND" }, { seller_asin_search_is_not_final_absence_proof: false },
    { listing_request_id: null }, { listing_request_id: rawPrivateMessage },
    { restriction_count: 1 }, { restriction_count: "0" }, { schema_product_type: "HANDBAG" },
    { schema_requirements: "LISTING" }, { schema_version: "" }, { schema_version: rawPrivateMessage },
    { schema_checksum: "NO" }, { schema_checksum: null }, { shopify_currency: "USD" },
    ...[0, -1, 1.5, NaN, Infinity, true, "2599", 100_000_001].map(shopify_price_minor => ({ shopify_price_minor })),
    ...[0, -1, 1.5, NaN, Infinity, true, "3", Number.MAX_SAFE_INTEGER + 1].map(shopify_stock_observed => ({ shopify_stock_observed })),
    { product_variant_id: "gid://shopify/Product/111" }, { product_variant_id: "gid://shopify/ProductVariant/0" },
    { read_only: false }, { has_created_offer: true }, { live_listing_write_enabled: true },
    { review_required: [] }, { review_required: [...reviewRequired, "claimed_approval"] },
    { review_required: [...reviewRequired.slice(1), reviewRequired[1]] }
  ];
  for (const patch of badProofs) {
    const h = harness({ proof: patch });
    const result = await h.run();
    assert.equal(result.status, "BLOCKED_PREVIEW");
    assert.equal(result.reason, "preflight_or_schema_evidence_unverified");
    flags(result, false);
    noPrivate(result);
    assert.deepEqual(h.events, ["preflight"]);
  }
  for (const value of [null, [], "claimed success"]) {
    const h = harness({ deps: { preflightReader: async () => value } });
    assert.equal((await h.run()).status, "BLOCKED_PREVIEW");
    assert.deepEqual(h.events, []);
  }
  const blockedProof = {
    ok: false, marketplace: input.marketplace, sku: input.sku, asin: input.asin,
    status: "BLOCKED_EXISTING_OFFER", blocker: "seller_has_asin_under_other_sku",
    read_only: true, has_created_offer: false, live_listing_write_enabled: false,
    message: rawPrivateMessage
  };
  const diagnosed = await harness({ deps: { preflightReader: async () => blockedProof } }).run();
  assert.equal(diagnosed.preflight_status, "BLOCKED_EXISTING_OFFER");
  assert.equal(diagnosed.preflight_blocker, "seller_has_asin_under_other_sku");
  noPrivate(diagnosed);
  for (const patch of [{ blocker: rawPrivateMessage }, { status: rawPrivateMessage }, { sku: "OTHER" },
    { read_only: false }, { status: "BLOCKED_PRODUCT_TYPE", blocker: "seller_has_asin_under_other_sku" }]) {
    const result = await harness({ deps: { preflightReader: async () => ({ ...blockedProof, ...patch }) } }).run();
    assert.equal(result.preflight_status, undefined);
    assert.equal(result.preflight_blocker, undefined);
    noPrivate(result);
  }
  for (const code of ["amazon_offer_preflight_transport_timeout", "amazon_offer_preflight_http_429", "amazon_credentials_missing", rawPrivateMessage]) {
    const result = await harness({ deps: { preflightReader: async () => { throw new Error(code); } } }).run();
    assert.equal(result.reason, "preflight_read_failed");
    assert.equal(result.preflight_error_code, code === rawPrivateMessage ? "preflight_read_failed" : code);
    noPrivate(result);
  }

  for (const marketplace of Object.keys(markets)) {
    const selected = { ...input, marketplace, sku: "Synthetic.MiX 001-_" };
    const h = harness({ input: selected });
    const result = await h.run();
    assert.deepEqual(h.events, ["preflight", "token", "preview"]);
    assert.equal(result.sku, selected.sku);
    assert.equal(result.amazon_preview_status, "VALID");
    assert.equal(result.status, "PREVIEW_REVIEW_REQUIRED");
    assert.equal(result.observed_at, "2026-10-18T12:00:00.000Z");
    assert.equal(result.validation_mode, "VALIDATION_PREVIEW");
    assert.equal(result.offer_quantity_submitted, 0);
    assert.equal(result.issues_returned, true);
    flags(result, true);
    noPrivate(result);
  }
  for (const price of [1, 100_000_000]) {
    const result = await harness({ proof: { shopify_price_minor: price } }).run();
    assert.equal(result.ok, true);
  }
  // The cloned selectors cannot change while server-side preflight is pending.
  const mutableInput = { ...input };
  const cloned = harness({ input: mutableInput, deps: { preflightReader: async selected => {
    mutableInput.sku = "CHANGED_AFTER_REQUEST";
    assert.equal(selected.sku, input.sku);
    return proof(selected);
  }, fetch: async (url, init) => { verifyPut(url, init); return json(providerResult()); } } });
  assert.equal((await cloned.run()).sku, input.sku);

  for (const status of ["VALID", "INVALID"]) {
    const response = providerResult({ status, issues: [
      { code: "100708", severity: "WARNING", message: rawPrivateMessage,
        attributeNames: ["purchasable_offer"], categories: [rawPrivateMessage] },
      { code: "INVALID_PRICE", severity: "INFO", attributeName: rawPrivateMessage },
      { code: "ATTRIBUTE_MISSING", severity: "ERROR", attributeNames: ["condition_type", "condition_type"] }
    ], identifiers: [{ value: rawPrivateMessage }], customer: rawPrivateMessage, url: rawPrivateMessage });
    const result = await harness({ response: () => json(response) }).run();
    assert.equal(result.amazon_preview_status, status);
    assert.equal(result.issue_count, 3);
    assert.deepEqual(result.preview_issues, [
      { code: "100708", severity: "WARNING", attribute_names: ["purchasable_offer"] },
      { code: "INVALID_PRICE", severity: "INFO", attribute_names: [] },
      { code: "ATTRIBUTE_MISSING", severity: "ERROR", attribute_names: ["condition_type"] }
    ]);
    flags(result, true);
    noPrivate(result);
  }
  const missingIssues = providerResult();
  delete missingIssues.issues;
  const omitted = await harness({ response: () => json(missingIssues) }).run();
  assert.equal(omitted.issues_returned, false);
  assert.equal(omitted.issue_count, 0);
  assert.deepEqual(omitted.preview_issues, []);

  for (const token of [null, true, "", " ", "contains space", "token\nheader", "a".repeat(16_385)]) {
    const h = harness({ deps: { getAccessToken: async () => token } });
    await rejects(h.run, "authentication_failed");
    assert.deepEqual(h.events, ["preflight"]);
  }
  await rejects(harness({ deps: { getAccessToken: async () => { throw new Error(rawPrivateMessage); } } }).run, "authentication_failed");
  await rejects(harness({ deps: { fetch: async () => { throw new Error(rawPrivateMessage); } } }).run, "network_error");
  for (const time of [NaN, Infinity, -1, "123", 1.5, 8_640_000_000_000_001]) {
    const h = harness({ deps: { clock: () => time } });
    await rejects(h.run, "invalid_clock");
    assert.deepEqual(h.events, []);
  }

  // HTTP errors/redirects are never followed or read, including arbitrary bodies.
  for (const status of [201, 202, 301, 302, 307, 308, 400, 401, 403, 404, 413, 415, 418, 429, 500, 502, 503, 504]) {
    let reads = 0, cancels = 0;
    const stream = new ReadableStream({
      pull() { reads++; throw new Error(rawPrivateMessage); }, cancel() { cancels++; }
    }, { highWaterMark: 0 });
    const h = harness({ response: () => new Response(stream, {
      status, headers: { "content-type": "application/json", Location: rawPrivateMessage }
    }) });
    const expected = [400, 401, 403, 404, 413, 415, 429, 500, 502, 503, 504].includes(status)
      ? "http_" + status : "unexpected_http_status";
    await rejects(h.run, expected);
    assert.equal(reads, 0);
    assert.equal(cancels, 1);
    assert.equal(h.events.filter(event => event === "preview").length, 1);
  }
  await rejects(harness({ response: () => new Response(null, { status: 204 }) }).run, "unexpected_http_status");
  for (const type of ["text/html", "application/jsonp", ""]) {
    await rejects(harness({ response: () => new Response(rawPrivateMessage, { headers: { "content-type": type } }) }).run,
      "unexpected_content_type");
  }
  assert.equal((await harness({ response: () => json(providerResult(), 200,
    { "content-type": "Application/JSON; charset=utf-8" }) }).run()).ok, true);

  for (const patch of [{ sku: "OTHER" }, { status: "ACCEPTED" }, { status: "VALID " },
    { status: null }, { submissionId: "" }, { submissionId: null }, { submissionId: rawPrivateMessage },
    { submissionId: "A".repeat(161) }]) {
    await rejects(harness({ response: () => json(providerResult(patch)) }).run, "unexpected_response");
  }
  for (const value of [null, [], {}, "VALID"]) {
    await rejects(harness({ response: () => json(value) }).run, "unexpected_response");
  }
  const badIssues = [
    null, {}, [null], [{ code: 100708, severity: "WARNING" }],
    [{ code: "", severity: "ERROR" }], [{ code: rawPrivateMessage, severity: "ERROR" }],
    [{ code: "code\n", severity: "ERROR" }], [{ code: "C".repeat(91), severity: "ERROR" }],
    [{ code: "100708", severity: "warning" }], [{ code: "100708", severity: "FATAL" }],
    [{ code: "100708", severity: rawPrivateMessage }], [{ code: "100708", severity: "ERROR", attributeNames: null }],
    [{ code: "100708", severity: "ERROR", attributeNames: "purchasable_offer" }],
    [{ code: "100708", severity: "ERROR", attributeNames: [rawPrivateMessage] }],
    [{ code: "100708", severity: "ERROR", attributeNames: [123] }],
    [{ code: "100708", severity: "ERROR", attributeNames: ["purchasable.offer"] }],
    [{ code: "100708", severity: "ERROR", attributeNames: ["a".repeat(121)] }],
    [{ code: "100708", severity: "ERROR", attributeNames: Array(21).fill("purchasable_offer") }],
    Array.from({ length: 101 }, () => ({ code: "100708", severity: "WARNING" }))
  ];
  for (const issues of badIssues)
    await rejects(harness({ response: () => json(providerResult({ issues })) }).run, "unexpected_issues");
  const hundred = Array.from({ length: 100 }, () => ({ code: "100708", severity: "WARNING" }));
  assert.equal((await harness({ response: () => json(providerResult({ issues: hundred })) }).run()).issue_count, 100);
  await rejects(harness({ response: () => new Response("{invalid", { headers: { "content-type": "application/json" } }) }).run, "invalid_json");
  await rejects(harness({ response: () => new Response(null, { headers: { "content-type": "application/json" } }) }).run, "invalid_json");
  await rejects(harness({ response: () => new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } }) }).run,
    "response_read_failed");
  await rejects(harness({ response: () => new Response(new ReadableStream({
    pull(controller) { controller.error(new Error(rawPrivateMessage)); }
  }), { headers: { "content-type": "application/json" } }) }).run, "response_read_failed");

  // UTF-8 byte bounds apply without trusting Content-Length or character count.
  await rejects(harness({ response: () => json(providerResult({ ignored: "\u03a9".repeat(500_000) })) }).run, "response_too_large");
  await rejects(harness({ response: () => json(providerResult({ ignored: "x".repeat(1_000_001) }), 200,
    { "content-length": "1" }) }).run, "response_too_large");
  let oversizedReads = 0, oversizedCancels = 0;
  await rejects(harness({ response: () => new Response(new ReadableStream({
    pull() { oversizedReads++; }, cancel() { oversizedCancels++; }
  }, { highWaterMark: 0 }), { headers: { "content-type": "application/json", "content-length": "1000001" } }) }).run,
    "response_too_large");
  assert.equal(oversizedReads, 0);
  assert.equal(oversizedCancels, 1);
  const encoded = new TextEncoder().encode(JSON.stringify(providerResult({ ignored: "\u03a9" })));
  const utf8Start = encoded.indexOf(0xce);
  assert(utf8Start > 0);
  const chunks = [encoded.slice(0, utf8Start + 1), encoded.slice(utf8Start + 1)];
  assert.equal((await harness({ response: () => new Response(new ReadableStream({
    pull(controller) { if (chunks.length) controller.enqueue(chunks.shift()); else controller.close(); }
  }), { headers: { "content-type": "application/json" } }) }).run()).ok, true);

  // Deterministically expire headers and stalled body without sleeping.
  for (const stalledBody of [false, true]) {
    const deadline = new AbortController();
    let cancels = 0;
    AbortSignal.timeout = ms => { assert.equal(ms, 20_000); return deadline.signal; };
    const deps = stalledBody ? { fetch: async () => new Response(new ReadableStream({
      pull() { queueMicrotask(() => deadline.abort()); }, cancel() { cancels++; }
    }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } }) } : {
      fetch: () => { queueMicrotask(() => deadline.abort()); return new Promise(() => {}); }
    };
    try { await rejects(harness({ deps }).run, "transport_timeout"); }
    finally { AbortSignal.timeout = originalTimeout; }
    assert.equal(cancels, stalledBody ? 1 : 0);
  }

  // Preserve legacy third-argument preflight and use the existing LWA resolver.
  const legacyCalls = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    legacyCalls.push({ host: u.host, method: init.method });
    if (u.origin === "https://api.amazon.com" && u.pathname === "/auth/o2/token") {
      assert.equal(init.method, "POST");
      assert.equal(init.body.get("grant_type"), "refresh_token");
      assert.equal(init.body.get("refresh_token"), env.AMAZON_SP_API_REFRESH_TOKEN);
      return json({ access_token: "synthetic-access-token" });
    }
    verifyPut(url, init);
    return json(providerResult());
  };
  assert.equal((await preview(input, env, async selected => proof(selected))).ok, true);
  assert.deepEqual(legacyCalls, [
    { host: "api.amazon.com", method: "POST" },
    { host: "sellingpartnerapi-eu.amazon.com", method: "PUT" }
  ]);
  const missingCredentials = { ...env, AMAZON_SP_API_REFRESH_TOKEN: undefined };
  const beforeMissing = legacyCalls.length;
  await rejects(() => preview(input, missingCredentials, async selected => proof(selected)), "authentication_failed");
  assert.equal(legacyCalls.length, beforeMissing);

  // Full default path: real preflight, Shopify reader, matching/details, Listings
  // GET/search, restrictions and definitions; only network responses are mocked.
  let fullCalls = [], stock = 3;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    fullCalls.push({ pathname: u.pathname, method });
    if (u.origin === "https://api.amazon.com" && u.pathname === "/auth/o2/token") {
      assert.equal(method, "POST");
      return json({ access_token: "synthetic-access-token" });
    }
    if (u.origin === "https://synthetic-store.myshopify.com" && u.pathname === "/admin/api/2026-01/graphql.json") {
      assert.equal(method, "POST");
      const query = JSON.parse(init.body);
      assert(query.query.includes("MareBusinessCatalogComplete"));
      assert(query.variables.query.includes("status:active,draft,archived,unlisted"));
      assert(query.variables.query.startsWith('sku:"') || query.variables.query.startsWith('barcode:"'));
      return json({ data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
        id: "gid://shopify/Product/111", vendor: "Synthetic Brand", status: "ACTIVE",
        productType: "Accessory", title: "Synthetic Accessory",
        collections: { pageInfo: { hasNextPage: false }, nodes: [] },
        media: { pageInfo: { hasNextPage: false }, nodes: [] },
        variants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
          id: "gid://shopify/ProductVariant/111", sku: input.sku, barcode: input.ean,
          price: "35.00", inventoryQuantity: stock, availableForSale: true,
          selectedOptions: [{ name: "Color", value: "Black" }],
          inventoryItem: { id: "gid://shopify/InventoryItem/111", tracked: true,
            inventoryLevels: { pageInfo: { hasNextPage: false }, nodes: [{
              id: "gid://shopify/InventoryLevel/111",
              location: { id: "gid://shopify/Location/1", name: "Synthetic warehouse" },
              quantities: [{ name: "available", quantity: stock }]
            }] } }
        }] }
      }] } } });
    }
    assert.equal(u.origin, "https://sellingpartnerapi-eu.amazon.com");
    assert.equal(init.headers["x-amz-access-token"], "synthetic-access-token");
    if (method === "PUT") {
      verifyPut(url, init, input, 35);
      return json(providerResult({ issues: [{ code: "100708", severity: "WARNING",
        attributeNames: ["purchasable_offer"], message: rawPrivateMessage }] }));
    }
    assert.equal(method, "GET", "Preflight must not send any provider mutation");
    assert.equal(u.searchParams.get("marketplaceIds"), markets.IT);
    if (u.pathname === "/catalog/2022-04-01/items") {
      assert.equal(u.searchParams.get("identifiers"), input.ean);
      assert.equal(u.searchParams.get("identifiersType"), "EAN");
      return json({ numberOfResults: 1, items: [{ asin: input.asin, identifiers: [{
        marketplaceId: markets.IT, identifiers: [{ identifierType: "EAN", identifier: input.ean }]
      }] }] });
    }
    if (u.pathname === "/catalog/2022-04-01/items/" + input.asin)
      return json({ asin: input.asin, summaries: [{ marketplaceId: markets.IT, brand: "Synthetic Brand",
        itemClassification: "BASE_PRODUCT" }], attributes: { color: [{ value: "Black" }] },
        productTypes: [{ marketplaceId: markets.IT, productType: "HANDBAG" }], images: [] });
    if (u.pathname === "/listings/2021-08-01/items/A123456789/" + input.sku)
      return json({ errors: [{ code: "NOT_FOUND", message: rawPrivateMessage }] }, 404,
        { "x-amzn-requestid": "synthetic-request-123" });
    if (u.pathname === "/listings/2021-08-01/items/A123456789") {
      assert.equal(u.searchParams.get("identifiersType"), "ASIN");
      assert.equal(u.searchParams.get("identifiers"), input.asin);
      return json({ numberOfResults: 0, items: [] });
    }
    if (u.pathname === "/listings/2021-08-01/restrictions") return json({ restrictions: [] });
    if (u.pathname === "/definitions/2020-09-01/productTypes/PRODUCT") {
      assert.equal(u.searchParams.get("requirements"), "LISTING_OFFER_ONLY");
      assert.equal(u.searchParams.get("requirementsEnforced"), "ENFORCED");
      return json({ productType: "PRODUCT", marketplaceIds: [markets.IT],
        requirements: "LISTING_OFFER_ONLY", requirementsEnforced: "ENFORCED",
        schema: { checksum: "c3ludGhldGljLXRlc3QxMg==",
          link: { resource: "https://synthetic.amazonaws.com/schema.json", verb: "GET" } },
        productTypeVersion: { version: "SYNTHETIC-VERSION", latest: true, releaseCandidate: false } });
    }
    throw new Error("unexpected_offline_route");
  };
  const full = await preview(input, env);
  assert.equal(full.status, "PREVIEW_REVIEW_REQUIRED");
  assert.equal(full.amazon_preview_status, "VALID");
  assert.equal(full.preview_issues[0].code, "100708");
  flags(full, true);
  noPrivate(full);
  assert.equal(fullCalls.filter(call => call.method === "PUT").length, 1);
  assert.equal(fullCalls.at(-1).method, "PUT");
  assert.equal(fullCalls.filter(call => call.method === "GET").length, 6);
  assert.equal(fullCalls.filter(call => call.pathname.endsWith("/graphql.json")).length, 2);
  // Re-reading an ineligible Shopify stock blocks even an otherwise valid input.
  stock = 0;
  fullCalls = [];
  const ineligible = await preview(input, env);
  assert.equal(ineligible.status, "BLOCKED_PREVIEW");
  assert.equal(ineligible.preflight_status, "BLOCKED_SHOPIFY_ELIGIBILITY");
  assert.equal(ineligible.preflight_blocker, "status_stock_price_inventory_or_ean_invalid");
  assert.equal(fullCalls.some(call => call.method === "PUT"), false);
  flags(ineligible, false);

  assert.equal(forbiddenPersistenceCalls, 0);
  assert.equal(unexpectedNetworkCalls, 0);
  assert.equal(logCalls, 0);
} finally {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
  for (const [name, original] of originals) console[name] = original;
}
console.log("PASS Amazon OFFER_ONLY VALIDATION_PREVIEW: " + checks +
  " checks; real default preflight with offline transports, fixed zero quantity, strict input, bounded diagnostics/body/deadline, no publication.");
