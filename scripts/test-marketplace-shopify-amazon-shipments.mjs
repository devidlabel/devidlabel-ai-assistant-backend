import assert from "node:assert/strict";
import { build } from "esbuild";

// Synthetic observations only. Private canaries must never reach the aggregate
// result; provider calls are injected and the real network is forbidden.
const bundle = await build({
  stdin: { contents: 'export * from "./src/marketplace-shopify-amazon-shipments.ts"; export {readShopifyChannableFulfillmentMetadata,readShopifyChannableFulfillmentMetadataPrivate,SHOPIFY_CHANNABLE_FULFILLMENT_QUERY} from "./src/marketplace-shopify-channable-fulfillments.ts";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true, platform: "neutral", format: "esm", write: false, logLevel: "silent",
  plugins: [{ name: "no-provider-reader", setup(build) {
    build.onResolve({ filter: /\/index\.js$/ }, () => ({ path: "forbidden", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export function shopifyGraphQL(){throw Error("PROVIDER_READ_FORBIDDEN");}', loader: "js" }));
  } }]
});
const {
  compareShopifyAmazonShipmentObservations: compare,
  readShopifyAmazonShipmentReconciliation: read,
  readShopifyChannableFulfillmentMetadata: readMetadata,
  readShopifyChannableFulfillmentMetadataPrivate: readPrivate,
  SHOPIFY_CHANNABLE_FULFILLMENT_QUERY
} = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("NETWORK_FORBIDDEN"); };
let checks = 0;
const eq = (actual, expected) => { assert.equal(actual, expected); checks++; };
const same = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const bad = (fn, pattern) => { assert.throws(fn, pattern); checks++; };
const rejects = async (fn, pattern) => { await assert.rejects(fn, pattern); checks++; };
const clone = value => structuredClone(value);
const amazonId = "101-2345678-1234567", orderGid = "gid://shopify/Order/1001";
const seller = "A1SYNTHETIC98", sku = "00_SKU_PRIVATE_CANARY ";
const number = "00_TRACKING_PRIVATE_CANARY ", carrier = "CARRIER_PRIVATE_CANARY ";
const at = "2026-10-18T12:00:00.000Z", now = Date.parse(at);
const input = { marketplace: "IT", shopify_order_gid: orderGid, amazon_order_id: amazonId };
const scope = { amazon_order_id: amazonId, shopify_order_gid: orderGid, marketplace: "IT", account_id: seller };
const env = { AMAZON_SP_API_SELLER_ID: seller, SHOPIFY_SHOP_DOMAIN: "synthetic.myshopify.com" };
const line = (id = 71, skuValue = sku, quantity = 1) => ({
  id: "gid://shopify/FulfillmentLineItem/" + id, quantity,
  lineItem: { id: "gid://shopify/LineItem/" + id, sku: skuValue }
});
const shipment = (id = 1, rows = [line()], tracks = [{ company: carrier, number }], status = "SUCCESS") => ({
  id: "gid://shopify/Fulfillment/" + id, status, displayStatus: "FULFILLED", trackingInfo: tracks,
  fulfillmentLineItems: { nodes: rows, pageInfo: { hasNextPage: false, endCursor: null } }
});
const providerOrder = shipments => ({ order: {
  id: orderGid, sourceName: "amazon", app: { name: "Channable" },
  customAttributes: [{ key: "Amazon Order ID", value: amazonId }, { key: "Private Note", value: "NOTE_PRIVATE_CANARY" }],
  displayFulfillmentStatus: shipments.length ? "FULFILLED" : "UNFULFILLED", fulfillments: shipments
} });
const metadataInput = { provider: "amazon", shopify_order_gid: orderGid, external_order_id: amazonId };
const privateFor = async rows => readPrivate(metadataInput, env, async () => providerOrder(rows));
const shopifyLines = {
  ok: true, source: "shopify_channable_amazon_order_lines", shopify_order_gid: orderGid, amazon_order_id: amazonId,
  importer_app: "Channable", source_name: "amazon", line_count: 1, pagination_complete: true, read_only: true,
  all_line_skus_mapped: true, order_import_already_present: true, full_line_comparison_pending: true,
  can_create_order: false, can_adjust_inventory: false, can_confirm_shipment: false,
  lines: [{ line_item_gid: "gid://shopify/LineItem/71", sku, ordered_quantity: 1, current_quantity: 1,
    variant_gid: "gid://shopify/ProductVariant/81" }]
};
const item = (id = "LINE_PRIVATE_CANARY", skuValue = sku, quantity = 1) => ({
  line_id: id, seller_sku: skuValue, quantity_ordered: quantity, quantity_fulfilled: quantity, quantity_unfulfilled: 0
});
const pack = (id = "PACKAGE_PRIVATE_CANARY", tracking = number, rows = [{ line_id: "LINE_PRIVATE_CANARY", quantity: 1 }]) => ({
  package_reference_id: id, carrier, tracking_number: tracking, ship_time: "2026-10-18T11:00:00Z",
  package_status: "SHIPPED", items: rows
});
const amazon = {
  ok: true, source: "amazon_spapi_order_packages_2026_01_01", identity_scope: "SELLER_ACCOUNT_PLUS_ORDER_ID",
  account_id: seller, order_id: amazonId, order_key: "amazon:" + seller + ":" + amazonId,
  marketplace: "IT", marketplace_id: "APJ6JRA9NG5V4", created_at: "2026-10-18T10:00:00Z",
  last_updated_at: "2026-10-18T11:30:00Z", observed_at: at, fulfillment_owner: "MERCHANT", fulfillment_status: "SHIPPED",
  items: [item()], packages: [pack()], read_only: true, provider_mutations: 0,
  buyer_recipient_datasets_requested: false, customer_fields_returned: false, private_tracking_transient_only: true,
  can_confirm_shipment: false, can_change_inventory: false, can_advance_checkpoint: false
};
const privateObservation = await privateFor([shipment()]);
const cmp = (a = amazon, s = shopifyLines, p = privateObservation, expected = scope) => compare(a, s, p, expected);

// The shared reader performs one provider call. Its public metadata output is
// unchanged; only the server-only branch retains exact tracking bytes.
let providerCalls = 0;
const provider = async (_env, query, vars) => {
  providerCalls++;
  eq(query, SHOPIFY_CHANNABLE_FULFILLMENT_QUERY); eq(vars.id, orderGid);
  assert(!/\burl\b|\bcustomer\b|\baddress\b/.test(query)); checks++;
  return providerOrder([shipment()]);
};
const shared = await readPrivate(metadataInput, env, provider);
eq(providerCalls, 1); eq(shared.private_tracking_entries[0].tracking_entries[0].number, number);
eq(shared.private_tracking_entries[0].tracking_entries[0].company, carrier);
const publicMetadata = await readMetadata(metadataInput, env, provider);
eq(providerCalls, 2); same(shared.metadata, publicMetadata);
assert(!JSON.stringify(publicMetadata).includes(number)); checks++;
assert(!JSON.stringify(publicMetadata).includes("NOTE_PRIVATE_CANARY")); checks++;

const flags = {
  read_only: true, provider_mutations: 0, importer_ownership: "NOT_TRANSFERRED_FROM_CHANNABLE",
  tracking_numbers_returned: false, tracking_urls_requested: false, tracking_number_fingerprints_returned: false,
  customer_fields_returned: false, can_confirm_marketplace_shipment: false, can_change_shopify_fulfillment: false,
  can_release_stock_reservation: false, can_change_inventory: false, can_advance_checkpoint: false,
  carrier_mapping_proven: false, carrier_handover_proven: false, delivery_proven: false,
  amazon_tracking_confirmation_proven: false, amazon_line_to_shopify_variant_mapping_proven: false,
  cross_provider_atomic_snapshot_proven: false, source_stability_reverified: false
};
function safe(result) {
  for (const [key, value] of Object.entries(flags)) eq(result[key], value);
  for (const secret of [amazonId, orderGid, seller, sku, number, carrier, "gid://shopify/", "PRIVATE_CANARY", "synthetic.myshopify.com"])
    { assert(!JSON.stringify(result).includes(secret)); checks++; }
  assert(Object.values(result).every(value => value === null || ["string", "number", "boolean"].includes(typeof value))); checks++;
}
const matched = cmp();
eq(matched.source, "shopify_amazon_shipment_reconciliation"); eq(matched.status, "REGISTERED_SHIPMENT_DATA_MATCHED");
eq(matched.tracking_and_quantities_match, true); eq(matched.matched_package_count, 1);
eq(matched.amazon_package_count, 1); eq(matched.shopify_successful_fulfillment_count, 1);
eq(matched.carrier_labels_match, true); eq(matched.carrier_label_match_count, 1); safe(matched);
for (const state of ["SHIPPED", "IN_TRANSIT", "DELIVERED"]) {
  const a = clone(amazon); a.packages[0].package_status = state;
  eq(cmp(a).status, "REGISTERED_SHIPMENT_DATA_MATCHED"); eq(cmp(a).delivery_proven, false);
}

// Exact labels are a separate observation. Their difference must not erase
// an exact tracking/quantity match or suggest a verified carrier-code mapping.
for (const differentCarrier of [carrier.toLowerCase(), carrier.trim(), "DIFFERENT_CARRIER"]) {
  const a = clone(amazon); a.packages[0].carrier = differentCarrier;
  const result = cmp(a);
  eq(result.status, "CARRIER_LABEL_REVIEW_REQUIRED"); eq(result.tracking_and_quantities_match, true);
  eq(result.matched_package_count, 1); eq(result.carrier_labels_match, false); eq(result.carrier_mapping_proven, false);
}
for (const missingCarrier of [null, "", "   "]) {
  const a = clone(amazon); a.packages[0].carrier = missingCarrier;
  const result = cmp(a);
  eq(result.status, "CARRIER_LABEL_REVIEW_REQUIRED"); eq(result.tracking_and_quantities_match, true);
  eq(result.carrier_labels_match, null); eq(result.carrier_label_missing_count, 1);
}
for (const alteredTracking of [number.trim(), number.toLowerCase(), "0" + number, number.replace("00_", "0_")]) {
  const a = clone(amazon); a.packages[0].tracking_number = alteredTracking;
  eq(cmp(a).status, "TRACKING_RECONCILIATION_REQUIRED"); eq(cmp(a).tracking_and_quantities_match, false);
}
for (const missingNumber of [null, "", "  "]) {
  const a = clone(amazon); a.packages[0].tracking_number = missingNumber;
  eq(cmp(a).status, "TRACKING_MISSING"); eq(cmp(a).tracking_and_quantities_match, false);
  const p = await privateFor([shipment(1, [line()], [{ company: carrier, number: missingNumber }])]);
  eq(cmp(amazon, shopifyLines, p).status, "TRACKING_MISSING");
}
eq(cmp(amazon, shopifyLines, await privateFor([shipment(1, [line()], [])])).status, "TRACKING_MISSING");

// Two distinct single-track fulfillments can match two packages, including
// a single Amazon order line split across both. A multi-track fulfillment has
// no per-number quantity allocation and must remain a review.
const twoAmazon = clone(amazon); twoAmazon.items = [item("LINE_PRIVATE_CANARY", sku, 2)];
twoAmazon.packages = [pack("PACKAGE_A", "TRACK_A"), pack("PACKAGE_B", "TRACK_B")];
const twoLines = clone(shopifyLines); twoLines.lines[0].ordered_quantity = 2; twoLines.lines[0].current_quantity = 2;
const splitPrivate = await privateFor([
  shipment(1, [line()], [{ company: carrier, number: "TRACK_A" }]),
  shipment(2, [line()], [{ company: carrier, number: "TRACK_B" }])
]);
const splitMatch = cmp(twoAmazon, twoLines, splitPrivate);
eq(splitMatch.status, "REGISTERED_SHIPMENT_DATA_MATCHED"); eq(splitMatch.matched_package_count, 2); safe(splitMatch);
const multiPrivate = await privateFor([shipment(1, [line(71, sku, 2)],
  [{ company: carrier, number: "TRACK_A" }, { company: carrier, number: "TRACK_B" }])]);
const multi = cmp(twoAmazon, twoLines, multiPrivate);
eq(multi.status, "MULTIPACKAGE_ASSIGNMENT_REVIEW_REQUIRED"); eq(multi.tracking_and_quantities_match, false);
eq(multi.multi_tracking_fulfillment_count, 1); eq(multi.matched_package_count, 0);
const duplicateAmazon = clone(twoAmazon); duplicateAmazon.packages[1].tracking_number = "TRACK_A";
const duplicatePrivate = await privateFor([
  shipment(1, [line()], [{ company: carrier, number: "TRACK_A" }]),
  shipment(2, [line()], [{ company: carrier, number: "TRACK_A" }])
]);
const duplicate = cmp(duplicateAmazon, twoLines, duplicatePrivate);
eq(duplicate.status, "DUPLICATE_TRACKING_REVIEW_REQUIRED"); eq(duplicate.duplicate_tracking_count, 2);
eq(duplicate.matched_package_count, 0); eq(duplicate.tracking_and_quantities_match, false);
const duplicateOnlyAmazon = cmp(duplicateAmazon, twoLines, splitPrivate);
eq(duplicateOnlyAmazon.status, "DUPLICATE_TRACKING_REVIEW_REQUIRED"); eq(duplicateOnlyAmazon.duplicate_tracking_count, 1);

// Package-level contents are checked, not just a set of tracking values and
// whole-order totals. Swapping two packages' lines must not pass.
const skuB = "SECOND_SKU_PRIVATE_CANARY", twoSkusAmazon = clone(amazon);
twoSkusAmazon.items.push(item("SECOND_LINE_PRIVATE_CANARY", skuB));
twoSkusAmazon.packages = [pack("PACKAGE_A", "TRACK_A"), pack("PACKAGE_B", "TRACK_B", [{ line_id: "SECOND_LINE_PRIVATE_CANARY", quantity: 1 }])];
const twoSkusLines = clone(shopifyLines); twoSkusLines.line_count = 2;
twoSkusLines.lines.push({ ...twoSkusLines.lines[0], line_item_gid: "gid://shopify/LineItem/72", sku: skuB, variant_gid: "gid://shopify/ProductVariant/82" });
const twoSkusPrivate = await privateFor([
  shipment(1, [line()], [{ company: carrier, number: "TRACK_A" }]),
  shipment(2, [line(72, skuB)], [{ company: carrier, number: "TRACK_B" }])
]);
eq(cmp(twoSkusAmazon, twoSkusLines, twoSkusPrivate).status, "REGISTERED_SHIPMENT_DATA_MATCHED");
const swapped = clone(twoSkusAmazon);
[swapped.packages[0].items, swapped.packages[1].items] = [swapped.packages[1].items, swapped.packages[0].items];
eq(cmp(swapped, twoSkusLines, twoSkusPrivate).status, "PACKAGE_QUANTITY_RECONCILIATION_REQUIRED");
eq(cmp(swapped, twoSkusLines, twoSkusPrivate).package_quantity_mismatch_count, 2);

// Missing datasets and item quantities cannot become an absence proof or an
// inferred full shipment. Optional unfulfilled=unknown does not negate a known
// fulfilled quantity exactly equal to ordered and package contents.
eq(cmp({ ...amazon, packages: null }).status, "AMAZON_PACKAGES_UNAVAILABLE");
eq(cmp({ ...amazon, packages: null }).amazon_package_count, null);
eq(cmp({ ...amazon, packages: [] }).status, "NO_AMAZON_PACKAGES_OBSERVED");
eq(cmp({ ...amazon, packages: [] }).amazon_package_count, 0);
for (const contents of [null, [], [{ line_id: "LINE_PRIVATE_CANARY", quantity: 0 }]]) {
  const a = clone(amazon); a.packages[0].items = contents;
  eq(cmp(a).status, "AMAZON_PACKAGE_CONTENTS_UNVERIFIED"); eq(cmp(a).tracking_and_quantities_match, false);
}
const missingFulfilled = clone(amazon); missingFulfilled.items[0].quantity_fulfilled = null;
eq(cmp(missingFulfilled).status, "AMAZON_FULFILLMENT_QUANTITIES_UNVERIFIED");
const missingUnfulfilled = clone(amazon); missingUnfulfilled.items[0].quantity_unfulfilled = null;
eq(cmp(missingUnfulfilled).status, "REGISTERED_SHIPMENT_DATA_MATCHED");
for (const mutate of [a => { a.items[0].quantity_fulfilled = 0; }, a => { a.items[0].quantity_unfulfilled = 1; },
  a => { a.items[0].quantity_fulfilled = 2; }, a => { a.packages[0].items[0].quantity = 2; }]) {
  const a = clone(amazon); mutate(a);
  eq(cmp(a).status, "AMAZON_QUANTITY_RECONCILIATION_REQUIRED"); eq(cmp(a).tracking_and_quantities_match, false);
}
for (const mutate of [a => { a.items[0].quantity_ordered = 0; }, a => { a.items[0].seller_sku = null; }]) {
  const a = clone(amazon); mutate(a);
  eq(cmp(a).status, "ORDER_LINES_UNVERIFIED"); eq(cmp(a).tracking_and_quantities_match, false);
}
const changedSku = clone(amazon); changedSku.items[0].seller_sku = sku.trim();
eq(cmp(changedSku).status, "ORDER_QUANTITY_RECONCILIATION_REQUIRED");
const repeatedSkuAmazon = clone(twoAmazon);
repeatedSkuAmazon.items = [item("LINE_PRIVATE_CANARY", sku), item("ANOTHER_LINE_PRIVATE_CANARY", sku)];
repeatedSkuAmazon.packages[1].items = [{ line_id: "ANOTHER_LINE_PRIVATE_CANARY", quantity: 1 }];
eq(cmp(repeatedSkuAmazon, twoLines, splitPrivate).status, "SKU_LINE_IDENTITY_REVIEW_REQUIRED");
const repeatedSkuLines = clone(shopifyLines); repeatedSkuLines.line_count = 2;
repeatedSkuLines.lines.push({ ...repeatedSkuLines.lines[0], line_item_gid: "gid://shopify/LineItem/72", variant_gid: "gid://shopify/ProductVariant/82" });
const repeatedSkuPrivate = await privateFor([shipment(1, [line(), line(72)])]);
eq(cmp({ ...twoAmazon, packages: [pack("PACKAGE_A", number, [{ line_id: "LINE_PRIVATE_CANARY", quantity: 2 }])] }, repeatedSkuLines, repeatedSkuPrivate).status,
  "SKU_LINE_IDENTITY_REVIEW_REQUIRED");
const currentChanged = clone(shopifyLines); currentChanged.lines[0].current_quantity = 0;
eq(cmp(amazon, currentChanged).status, "CURRENT_QUANTITY_REVIEW_REQUIRED");

// Known provider statuses are not confirmation, carrier or delivery evidence.
for (const state of [null, "PENDING", "CANCELLED", "UNDELIVERABLE"]) {
  const a = clone(amazon); a.packages[0].package_status = state;
  eq(cmp(a).status, "AMAZON_PACKAGE_STATE_REVIEW_REQUIRED"); eq(cmp(a).tracking_and_quantities_match, false);
}
for (const state of [null, "PENDING_AVAILABILITY", "PENDING", "UNSHIPPED", "CANCELLED", "UNFULFILLABLE"]) {
  eq(cmp({ ...amazon, fulfillment_status: state }).status, "AMAZON_FULFILLMENT_STATE_REVIEW_REQUIRED");
}
eq(cmp({ ...amazon, fulfillment_owner: null }).status, "AMAZON_FULFILLMENT_STATE_REVIEW_REQUIRED");
eq(cmp({ ...amazon, fulfillment_status: "PARTIALLY_SHIPPED" }).status, "PARTIAL_SHIPMENT_REVIEW_REQUIRED");
const partialAmazon = clone(twoAmazon);
partialAmazon.items[0].quantity_fulfilled = 1; partialAmazon.items[0].quantity_unfulfilled = 1;
partialAmazon.fulfillment_status = "PARTIALLY_SHIPPED"; partialAmazon.packages = [pack()];
eq(cmp(partialAmazon, twoLines).status, "PARTIAL_SHIPMENT_REVIEW_REQUIRED");
eq(cmp(partialAmazon, twoLines).tracking_and_quantities_match, false);
for (const state of ["OPEN", "PENDING"]) {
  const p = await privateFor([shipment(), shipment(2, [line()], [{ company: carrier, number: "PENDING_TRACK" }], state)]);
  eq(cmp(amazon, shopifyLines, p).status, "PENDING_FULFILLMENT_REVIEW");
}
for (const state of ["CANCELLED", "ERROR", "FAILURE"]) {
  const p = await privateFor([shipment(1, [line()], [{ company: carrier, number }], state)]);
  eq(cmp(amazon, shopifyLines, p).status, "NO_SUCCESSFUL_SHOPIFY_FULFILLMENTS");
  const replaced = await privateFor([shipment(), shipment(2, [line()], [{ company: carrier, number: "OLD_TRACK" }], state)]);
  eq(cmp(amazon, shopifyLines, replaced).status, "REGISTERED_SHIPMENT_DATA_MATCHED");
  eq(cmp(amazon, shopifyLines, replaced).shopify_excluded_fulfillment_count, 1);
}
for (const futureShipTime of ["2026-10-18T12:00:01Z", "2026-10-18T09:59:59Z"]) {
  const a = clone(amazon); a.packages[0].ship_time = futureShipTime;
  eq(cmp(a).status, "TEMPORAL_STATE_REVIEW_REQUIRED"); eq(cmp(a).tracking_and_quantities_match, false);
}
const futureUpdated = clone(amazon); futureUpdated.last_updated_at = "2026-10-18T12:00:01Z";
eq(cmp(futureUpdated).status, "TEMPORAL_STATE_REVIEW_REQUIRED");
const noShipTime = clone(amazon); noShipTime.packages[0].ship_time = null;
eq(cmp(noShipTime).status, "REGISTERED_SHIPMENT_DATA_MATCHED");

// Source signatures, scope, identity, safe quantities and private/public linkage
// are revalidated even if an injected reader claims its observations are safe.
for (const mutate of [
  a => { a.account_id = "A1DIFFERENT99"; }, a => { a.order_id = "999-9999999-9999999"; },
  a => { a.order_key += "x"; }, a => { a.marketplace = "DE"; }, a => { a.marketplace_id = "A1PA6795UKMFR9"; },
  a => { a.fulfillment_owner = "AMAZON"; }, a => { a.fulfillment_status = "UNKNOWN_STATE"; },
  a => { a.ok = false; }, a => { a.read_only = false; }, a => { a.provider_mutations = 1; },
  a => { a.can_confirm_shipment = true; }, a => { a.can_change_inventory = true; }, a => { a.can_advance_checkpoint = true; },
  a => { a.customer_fields_returned = true; }, a => { a.buyer_recipient_datasets_requested = true; },
  a => { a.private_tracking_transient_only = false; }, a => { a.extra = "PRIVATE_CANARY"; },
  a => { a.items = []; }, a => { a.items.push(clone(a.items[0])); }, a => { a.items[0].quantity_ordered = "1"; },
  a => { a.items[0].quantity_ordered = -1; }, a => { a.items[0].quantity_fulfilled = NaN; },
  a => { a.items[0].quantity_unfulfilled = Number.MAX_SAFE_INTEGER + 1; },
  a => { a.items[0].line_id = "\nPRIVATE_CANARY"; }, a => { a.items[0].seller_sku = "\nPRIVATE_CANARY"; },
  a => { a.packages[0].carrier = "\nPRIVATE_CANARY"; }, a => { a.packages[0].tracking_number = 123; },
  a => { a.packages[0].tracking_number = "x".repeat(257); }, a => { a.packages[0].package_status = "FUTURE_UNKNOWN"; },
  a => { a.packages[0].items[0].line_id = "UNKNOWN_LINE"; }, a => { a.packages[0].items[0].quantity = -1; },
  a => { a.packages[0].items.push(clone(a.packages[0].items[0])); }, a => { a.packages.push(clone(a.packages[0])); },
  a => { a.packages[0].url = "https://private.example/PRIVATE_CANARY"; }, a => { a.created_at = "not-a-time"; },
  a => { a.packages[0].ship_time = "not-a-time"; }, a => { delete a.packages; },
  a => { a.packages = Array.from({ length: 51 }, (_, i) => pack("PACK_" + i)); },
  a => { a.items = Array.from({ length: 201 }, (_, i) => item("LINE_" + i)); }
]) {
  const altered = clone(amazon); mutate(altered);
  bad(() => cmp(altered), /^Error: shipment_reconciliation_[a-z_]+$/);
}
for (const alteredScope of [{ ...scope, marketplace: "DE" }, { ...scope, account_id: "A1DIFFERENT99" },
  { ...scope, amazon_order_id: "999-9999999-9999999" }, { ...scope, tracking: "PRIVATE_CANARY" }, null]) {
  bad(() => cmp(amazon, shopifyLines, privateObservation, alteredScope));
}
for (const mutate of [
  p => { p.private_tracking_entries = []; }, p => { p.extra = "PRIVATE_CANARY"; },
  p => { p.private_tracking_entries[0].fulfillment_gid = "gid://shopify/Fulfillment/999"; },
  p => { p.private_tracking_entries[0].tracking_entries = []; },
  p => { p.private_tracking_entries[0].tracking_entries[0].number = null; },
  p => { p.private_tracking_entries[0].tracking_entries[0].number = "\nPRIVATE_CANARY"; },
  p => { p.private_tracking_entries[0].tracking_entries[0].company = "WRONG_CARRIER"; },
  p => { p.private_tracking_entries[0].tracking_entries[0].url = "PRIVATE_CANARY"; },
  p => { p.metadata.tracking_numbers_returned = true; }, p => { p.metadata.external_order_id = "999-9999999-9999999"; },
  p => { p.metadata.shipments[0].lines[0].sku = "OTHER_SKU"; },
  p => { p.metadata.shipments[0].status = "UNKNOWN"; }, p => { p.metadata.shipments[0].lines[0].quantity = 2; }
]) {
  const altered = clone(privateObservation); mutate(altered); bad(() => cmp(amazon, shopifyLines, altered));
}

// Wrapper inputs contain only three identifiers and all rows are fetched
// server-side. Invalid caller data must fail before any reader is invoked.
let lineCalls = 0, shipmentCalls = 0, amazonCalls = 0;
const dependencies = {
  clock: () => now,
  readOrderLines: async request => { lineCalls++; same(request, { shopify_order_gid: orderGid, amazon_order_id: amazonId }); return clone(shopifyLines); },
  readFulfillmentMetadataPrivate: async request => { shipmentCalls++; same(request, metadataInput); return clone(privateObservation); },
  readAmazonPackages: async request => { amazonCalls++; same(request, { amazon_order_id: amazonId, marketplace: "IT" }); return clone(amazon); }
};
const result = await read(input, env, dependencies);
eq(lineCalls, 1); eq(shipmentCalls, 1); eq(amazonCalls, 1); safe(result);
eq(result.status, "REGISTERED_SHIPMENT_DATA_MATCHED"); eq(result.observed_at, at);
eq(result.observation_started_at, at); eq(result.observation_duration_ms, 0);
for (const request of [null, [], {}, { ...input, tracking: "PRIVATE_CANARY" }, { ...input, packages: amazon.packages },
  { ...input, tenant: "PRIVATE_CANARY" }, { ...input, orderLines: shopifyLines }, { ...input, marketplace: "UK" },
  { ...input, shopify_order_gid: "gid://shopify/Product/1001" }, { ...input, amazon_order_id: "bad" },
  { ...input, [Symbol("private")]: "PRIVATE_CANARY" }]) {
  await rejects(() => read(request, env, dependencies), /shipment_reconciliation_invalid_request/);
}
eq(lineCalls, 1); eq(shipmentCalls, 1); eq(amazonCalls, 1);
for (const invalidEnv of [{}, { ...env, AMAZON_SP_API_SELLER_ID: "bad" }, { ...env, SHOPIFY_SHOP_DOMAIN: "bad.example.com" },
  { ...env, SHOPIFY_SHOP_DOMAIN: "synthetic.myshopify.com/path" }]) {
  await rejects(() => read(input, invalidEnv, dependencies), /account_not_configured/);
}
eq(lineCalls, 1); eq(shipmentCalls, 1); eq(amazonCalls, 1);
eq((await read(input, { ...env, SHOPIFY_SHOP_DOMAIN: "https://SYNTHETIC.myshopify.com/" }, dependencies)).status,
  "REGISTERED_SHIPMENT_DATA_MATCHED");
for (const stage of ["readOrderLines", "readFulfillmentMetadataPrivate", "readAmazonPackages"]) {
  await rejects(() => read(input, env, { ...dependencies, [stage]: async () => { throw Error("shipment_reconciliation_PRIVATE_CANARY " + number); } }),
    error => !error.message.includes("PRIVATE_CANARY") && /^shipment_reconciliation_[a-z_]+$/.test(error.message));
}
// Permission/rate-limit categories remain diagnosable, while only an exact
// allowlisted fixed string can cross the reader error boundary.
for (const suffix of ["http_400", "http_401", "http_403", "http_404", "http_413", "http_415", "http_429",
  "http_500", "http_502", "http_503", "http_504", "auth_failed", "transport_timeout", "transport_failed"]) {
  await rejects(() => read(input, env, { ...dependencies, readAmazonPackages: async () => { throw Error("amazon_order_packages_" + suffix); } }),
    error => error.message === "shipment_reconciliation_amazon_packages_" + suffix);
}
for (const rawMessage of ["amazon_order_packages_http_403 PRIVATE_CANARY", "amazon_order_packages_http_403\nPRIVATE_CANARY",
  "amazon_order_packages_http_402", "amazon_order_packages_invalid_tracking_number", "PRIVATE_CANARY"]) {
  await rejects(() => read(input, env, { ...dependencies, readAmazonPackages: async () => { throw Error(rawMessage); } }),
    error => error.message === "shipment_reconciliation_amazon_packages_read_failed");
}
await rejects(() => read(input, env, { ...dependencies, readAmazonPackages: async () => { throw "PRIVATE_CANARY"; } }),
  error => error.message === "shipment_reconciliation_amazon_packages_read_failed");
await rejects(() => read(input, env, { ...dependencies, readOrderLines: async () => ({ ...shopifyLines, amazon_order_id: "999-9999999-9999999" }) }), /identity_conflict/);
await rejects(() => read(input, env, { ...dependencies, readAmazonPackages: async () => ({ ...amazon, account_id: "A1DIFFERENT99" }) }), /untrusted_amazon_source/);
for (const clock of [() => NaN, () => -1, () => { throw Error("PRIVATE_CANARY"); }])
  await rejects(() => read(input, env, { ...dependencies, clock }), /clock_invalid/);
for (const observed_at of ["2026-10-18T11:59:59Z", "2026-10-18T12:00:01Z"])
  await rejects(() => read(input, env, { ...dependencies, readAmazonPackages: async () => ({ ...amazon, observed_at }) }), /observation_time_conflict/);
let clockCall = 0;
await rejects(() => read(input, env, { ...dependencies, clock: () => clockCall++ ? now - 1 : now }), /observation_time_conflict/);

globalThis.fetch = originalFetch;
console.log("PASS Shopify/Amazon shipment reconciliation: " + checks + " checks; exact private tracking, per-package SKU/quantity correspondence, ambiguity and missing-data review, unchanged public metadata, redacted errors, zero provider mutations");
