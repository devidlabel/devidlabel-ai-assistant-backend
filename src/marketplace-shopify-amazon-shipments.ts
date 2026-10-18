import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import {
  readAmazonOrderPackagesPrivate,
  type AmazonOrderPackagesEnv,
  type AmazonOrderPackagesMarketplace,
  type AmazonOrderPackagesPrivateObservation,
  type AmazonPackageStatus
} from "./marketplace-amazon-order-packages.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";
import { readShopifyChannableAmazonOrderLines } from "./marketplace-shopify-channable-amazon-lines.js";
import {
  compareChannableFulfillmentCoverage,
  readShopifyChannableFulfillmentMetadataPrivate,
  type PrivateChannableFulfillmentObservation
} from "./marketplace-shopify-channable-fulfillments.js";

/** Server-only, transient comparison of two providers' recorded shipment data.
 * No raw observation, tracking number, identifier, SKU, carrier label, URL or
 * fingerprint leaves this module. No confirmation, journal or provider write.
 */
type Row = Record<string, unknown>;
export type ShopifyAmazonShipmentReconciliationEnv = MareBusinessShopifyEnv & AmazonOrderPackagesEnv;
export type ShopifyAmazonShipmentReconciliationDependencies = {
  readAmazonPackages?: typeof readAmazonOrderPackagesPrivate;
  readOrderLines?: typeof readShopifyChannableAmazonOrderLines;
  readFulfillmentMetadataPrivate?: typeof readShopifyChannableFulfillmentMetadataPrivate;
  clock?: () => number;
};
export type ShopifyAmazonShipmentComparisonScope = {
  amazon_order_id: string;
  shopify_order_gid: string;
  marketplace: AmazonOrderPackagesMarketplace;
  account_id: string;
};
const ORDER_RE = /^\d{3}-\d{7}-\d{7}$/;
const SHOPIFY_ORDER_RE = /^gid:\/\/shopify\/Order\/\d+$/;
const SELLER_RE = /^[A-Z0-9]{8,30}$/;
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
// Exact values from the Orders 2026-01-01 model. These are recorded states,
// not independent proof of carrier handover, delivery or a new confirmation.
const PACKAGE_STATUSES = new Set<AmazonPackageStatus>([
  "PENDING", "IN_TRANSIT", "SHIPPED", "DELIVERED", "CANCELLED", "UNDELIVERABLE"
]);
const RECORDED_SHIPPED_STATES = new Set<AmazonPackageStatus>(["SHIPPED", "IN_TRANSIT", "DELIVERED"]);
const ORDER_STATUSES = new Set([
  "PENDING_AVAILABILITY", "PENDING", "UNSHIPPED", "PARTIALLY_SHIPPED", "SHIPPED", "CANCELLED", "UNFULFILLABLE"
]);
// Only these fixed upstream categories may cross the private read boundary.
// Provider error bodies, arbitrary messages and validation values never do.
const AMAZON_READ_FAILURES = new Map([
  ...[400, 401, 403, 404, 413, 415, 429, 500, 502, 503, 504].map(status =>
    ["amazon_order_packages_http_" + status, "amazon_packages_http_" + status] as const),
  ["amazon_order_packages_auth_failed", "amazon_packages_auth_failed"],
  ["amazon_order_packages_transport_timeout", "amazon_packages_transport_timeout"],
  ["amazon_order_packages_transport_failed", "amazon_packages_transport_failed"]
]);
function fail(code: string): never { throw new Error("shipment_reconciliation_" + code); }
function object(value: unknown, code = "untrusted_source"): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as Row;
}
function exactKeys(value: Row, keys: string[], code: string): void {
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== "string" || !keys.includes(key))) fail(code);
}
function text(value: unknown, max: number, nonblank = false): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    !CONTROL_RE.test(value) && (!nonblank || value.trim().length > 0);
}
function optionalText(value: unknown, max: number): value is string | null {
  return value === null || (typeof value === "string" && value.length <= max && !CONTROL_RE.test(value));
}
function present(value: string | null): value is string { return value !== null && value.trim().length > 0; }
function quantity(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function optionalQuantity(value: unknown): value is number | null { return value === null || quantity(value); }
function timestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
}
function add(map: Map<string, number>, key: string, count: number): void {
  const value = (map.get(key) ?? 0) + count;
  if (!Number.isSafeInteger(value)) fail("quantity_overflow");
  map.set(key, value);
}
function total(map: Map<string, number>): number {
  const value = [...map.values()].reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(value)) fail("quantity_overflow");
  return value;
}
function mismatches(a: Map<string, number>, b: Map<string, number>): number {
  return [...new Set([...a.keys(), ...b.keys()])].filter(key => (a.get(key) ?? 0) !== (b.get(key) ?? 0)).length;
}
function duplicates(values: string[]): number {
  const counts = new Map<string, number>();
  for (const value of values) add(counts, value, 1);
  return [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}
function validateScope(scopeRaw: unknown): ShopifyAmazonShipmentComparisonScope {
  const scope = object(scopeRaw, "invalid_scope");
  exactKeys(scope, ["amazon_order_id", "shopify_order_gid", "marketplace", "account_id"], "invalid_scope");
  if (!text(scope.amazon_order_id, 19) || !ORDER_RE.test(scope.amazon_order_id) ||
      !text(scope.shopify_order_gid, 100) || !SHOPIFY_ORDER_RE.test(scope.shopify_order_gid) ||
      !text(scope.account_id, 30) || !SELLER_RE.test(scope.account_id) ||
      typeof scope.marketplace !== "string" || !Object.hasOwn(AMAZON_EU_MARKETPLACES, scope.marketplace)) fail("invalid_scope");
  return scope as ShopifyAmazonShipmentComparisonScope;
}
function validateAmazon(raw: unknown, scope: ShopifyAmazonShipmentComparisonScope): AmazonOrderPackagesPrivateObservation {
  const a = object(raw);
  exactKeys(a, ["ok", "source", "identity_scope", "account_id", "order_id", "order_key", "marketplace", "marketplace_id",
    "created_at", "last_updated_at", "observed_at", "fulfillment_owner", "fulfillment_status", "items", "packages",
    "read_only", "provider_mutations", "buyer_recipient_datasets_requested", "customer_fields_returned",
    "private_tracking_transient_only", "can_confirm_shipment", "can_change_inventory", "can_advance_checkpoint"], "untrusted_amazon_source");
  if (a.ok !== true || a.source !== "amazon_spapi_order_packages_2026_01_01" ||
      a.identity_scope !== "SELLER_ACCOUNT_PLUS_ORDER_ID" || a.account_id !== scope.account_id ||
      a.order_id !== scope.amazon_order_id || a.order_key !== "amazon:" + scope.account_id + ":" + scope.amazon_order_id ||
      a.marketplace !== scope.marketplace || a.marketplace_id !== AMAZON_EU_MARKETPLACES[scope.marketplace] ||
      a.read_only !== true || a.provider_mutations !== 0 || a.buyer_recipient_datasets_requested !== false ||
      a.customer_fields_returned !== false || a.private_tracking_transient_only !== true ||
      a.can_confirm_shipment !== false || a.can_change_inventory !== false || a.can_advance_checkpoint !== false ||
      !timestamp(a.created_at) || !timestamp(a.last_updated_at) || !timestamp(a.observed_at) ||
      Date.parse(a.last_updated_at) < Date.parse(a.created_at) ||
      (a.fulfillment_owner !== null && a.fulfillment_owner !== "MERCHANT") ||
      (a.fulfillment_status !== null && (typeof a.fulfillment_status !== "string" || !ORDER_STATUSES.has(a.fulfillment_status))) ||
      !Array.isArray(a.items) || a.items.length < 1 || a.items.length > 200 ||
      (a.packages !== null && (!Array.isArray(a.packages) || a.packages.length > 50))) fail("untrusted_amazon_source");
  const ids = new Set<string>();
  for (const rawItem of a.items) {
    const item = object(rawItem);
    exactKeys(item, ["line_id", "seller_sku", "quantity_ordered", "quantity_fulfilled", "quantity_unfulfilled"], "invalid_amazon_item");
    if (!text(item.line_id, 128, true) || ids.has(item.line_id) ||
        (item.seller_sku !== null && !text(item.seller_sku, 200)) || !quantity(item.quantity_ordered) ||
        !optionalQuantity(item.quantity_fulfilled) || !optionalQuantity(item.quantity_unfulfilled)) fail("invalid_amazon_item");
    ids.add(item.line_id);
  }
  const refs = new Set<string>();
  for (const rawPackage of a.packages ?? []) {
    const pack = object(rawPackage);
    exactKeys(pack, ["package_reference_id", "carrier", "tracking_number", "ship_time", "package_status", "items"], "invalid_amazon_package");
    if (!text(pack.package_reference_id, 128, true) || refs.has(pack.package_reference_id) ||
        !optionalText(pack.carrier, 90) || !optionalText(pack.tracking_number, 256) ||
        (pack.ship_time !== null && !timestamp(pack.ship_time)) ||
        (pack.package_status !== null && !PACKAGE_STATUSES.has(pack.package_status as AmazonPackageStatus)) ||
        (pack.items !== null && (!Array.isArray(pack.items) || pack.items.length > 200))) fail("invalid_amazon_package");
    refs.add(pack.package_reference_id);
    const packageIds = new Set<string>();
    for (const rawItem of pack.items ?? []) {
      const item = object(rawItem);
      exactKeys(item, ["line_id", "quantity"], "invalid_amazon_package_item");
      if (typeof item.line_id !== "string" || !ids.has(item.line_id) || packageIds.has(item.line_id) || !quantity(item.quantity))
        fail("invalid_amazon_package_item");
      packageIds.add(item.line_id);
    }
  }
  return a as unknown as AmazonOrderPackagesPrivateObservation;
}
function validatePrivateTracking(raw: unknown, metadata: Row): PrivateChannableFulfillmentObservation {
  const observation = object(raw);
  exactKeys(observation, ["metadata", "private_tracking_entries"], "invalid_private_projection");
  if (!Array.isArray(observation.private_tracking_entries) ||
      observation.private_tracking_entries.length !== (metadata.shipments as Row[]).length) fail("invalid_private_projection");
  const shipments = new Map((metadata.shipments as Row[]).map(shipment => [shipment.fulfillment_gid, shipment]));
  const seen = new Set<string>();
  for (const rawEntry of observation.private_tracking_entries) {
    const entry = object(rawEntry);
    exactKeys(entry, ["fulfillment_gid", "tracking_entries"], "invalid_private_projection");
    if (typeof entry.fulfillment_gid !== "string" || seen.has(entry.fulfillment_gid) || !shipments.has(entry.fulfillment_gid) ||
        !Array.isArray(entry.tracking_entries)) fail("invalid_private_projection");
    seen.add(entry.fulfillment_gid);
    const shipment = shipments.get(entry.fulfillment_gid)!;
    if (entry.tracking_entries.length !== shipment.tracking_entry_count) fail("invalid_private_projection");
    let count = 0;
    entry.tracking_entries.forEach((rawTrack, index) => {
      const track = object(rawTrack);
      exactKeys(track, ["company", "number"], "invalid_private_projection");
      if (!optionalText(track.company, 90) || !optionalText(track.number, 256) ||
          (track.company || "UNVERIFIED") !== (shipment.carrier_names as string[])[index]) fail("invalid_private_projection");
      if (present(track.number as string | null)) count++;
    });
    if (count !== shipment.tracking_number_present_count) fail("invalid_private_projection");
  }
  return observation as unknown as PrivateChannableFulfillmentObservation;
}

/** Pure private comparator. Exact tracking bytes and unique SKU correspondence
 * are required. Shopify gives quantities per fulfillment, not per tracking
 * entry, so a fulfillment with several tracking numbers has no inferred package
 * allocation. Opaque identifiers, SKU bytes and tracking are never normalized.
 */
export function compareShopifyAmazonShipmentObservations(
  amazonRaw: unknown, shopifyLinesRaw: unknown, privateFulfillmentsRaw: unknown,
  scopeRaw: ShopifyAmazonShipmentComparisonScope
): Row {
  const scope = validateScope(scopeRaw), amazon = validateAmazon(amazonRaw, scope);
  const lines = object(shopifyLinesRaw), privateRaw = object(privateFulfillmentsRaw);
  const metadata = object(privateRaw.metadata);
  if (lines.amazon_order_id !== scope.amazon_order_id || lines.shopify_order_gid !== scope.shopify_order_gid)
    fail("shopify_identity_conflict");
  const coverage = compareChannableFulfillmentCoverage(lines, metadata);
  const privateObservation = validatePrivateTracking(privateRaw, metadata);
  const orderItems = new Map(amazon.items.map(item => [item.line_id, item]));
  const amazonOrdered = new Map<string, number>(), shopifyOrdered = new Map<string, number>();
  const amazonSkuCounts = new Map<string, number>(), shopifySkuCounts = new Map<string, number>();
  let missingSkus = 0, zeroOrderQuantities = 0, unknownFulfilledQuantities = 0, amazonQuantityConflicts = 0;
  for (const item of amazon.items) {
    if (item.seller_sku === null) missingSkus++;
    else { add(amazonOrdered, item.seller_sku, item.quantity_ordered); add(amazonSkuCounts, item.seller_sku, 1); }
    if (item.quantity_ordered === 0) zeroOrderQuantities++;
    if (item.quantity_fulfilled === null) unknownFulfilledQuantities++;
    if ((item.quantity_fulfilled !== null && item.quantity_fulfilled > item.quantity_ordered) ||
        (item.quantity_unfulfilled !== null && item.quantity_unfulfilled > item.quantity_ordered) ||
        (item.quantity_fulfilled !== null && item.quantity_unfulfilled !== null &&
          item.quantity_fulfilled + item.quantity_unfulfilled !== item.quantity_ordered)) amazonQuantityConflicts++;
  }
  for (const rawLine of lines.lines as Row[]) {
    add(shopifyOrdered, rawLine.sku as string, rawLine.ordered_quantity as number);
    add(shopifySkuCounts, rawLine.sku as string, 1);
  }
  const ambiguousSkus = [...new Set([...amazonSkuCounts.keys(), ...shopifySkuCounts.keys()])]
    .filter(sku => (amazonSkuCounts.get(sku) ?? 0) > 1 || (shopifySkuCounts.get(sku) ?? 0) > 1).length;
  const orderQuantityMismatches = mismatches(amazonOrdered, shopifyOrdered);
  const successful = (metadata.shipments as Row[]).filter(shipment => shipment.status === "SUCCESS");
  const privateById = new Map(privateObservation.private_tracking_entries.map(entry => [entry.fulfillment_gid, entry.tracking_entries]));
  const successTracking = successful.flatMap(shipment => privateById.get(shipment.fulfillment_gid as string)!);
  const missingShopifyTracking = successful.filter(shipment => {
    const tracks = privateById.get(shipment.fulfillment_gid as string)!;
    return tracks.length === 0 || tracks.some(track => !present(track.number));
  }).length;
  const multipleTracking = successful.filter(shipment => privateById.get(shipment.fulfillment_gid as string)!.length > 1).length;
  const shopifyNumbers = successTracking.map(track => track.number).filter(present);
  const packages = amazon.packages ?? [];
  const amazonNumbers = packages.map(pack => pack.tracking_number).filter(present);
  const duplicateTracking = duplicates(shopifyNumbers) + duplicates(amazonNumbers);
  const missingAmazonTracking = packages.filter(pack => !present(pack.tracking_number)).length;
  const packageStateReviews = packages.filter(pack => pack.package_status === null || !RECORDED_SHIPPED_STATES.has(pack.package_status)).length;
  const packageContentsUnverified = packages.filter(pack => pack.items === null || pack.items.length === 0).length;
  const zeroPackageQuantities = packages.reduce((sum, pack) => sum + (pack.items ?? []).filter(item => item.quantity === 0).length, 0);
  const packageUnitsByLine = new Map<string, number>();
  for (const pack of packages) for (const item of pack.items ?? []) add(packageUnitsByLine, item.line_id, item.quantity);
  const registeredPackageUnits = total(packageUnitsByLine);
  for (const item of amazon.items) {
    const count = packageUnitsByLine.get(item.line_id) ?? 0;
    if (count > item.quantity_ordered || (item.quantity_fulfilled !== null && count !== item.quantity_fulfilled)) amazonQuantityConflicts++;
  }
  const temporalReview = Date.parse(amazon.last_updated_at) > Date.parse(amazon.observed_at) || packages.some(pack =>
    pack.ship_time !== null && (Date.parse(pack.ship_time) < Date.parse(amazon.created_at) || Date.parse(pack.ship_time) > Date.parse(amazon.observed_at)));
  const incompleteOrderShipment = amazon.fulfillment_status === "PARTIALLY_SHIPPED" ||
    coverage.coverage !== "SHOPIFY_FULFILLMENT_LINES_COMPLETE" || amazon.items.some(item => item.quantity_fulfilled !== item.quantity_ordered);

  let trackingPairs = 0, matchedPackages = 0, packageQuantityMismatches = 0;
  let carrierMatches = 0, carrierMismatches = 0, carrierMissing = 0;
  for (const shipment of successful) {
    const tracks = privateById.get(shipment.fulfillment_gid as string)!;
    if (tracks.length !== 1 || !present(tracks[0].number)) continue;
    const number = tracks[0].number;
    if (shopifyNumbers.filter(value => value === number).length !== 1) continue;
    const candidates = packages.filter(pack => pack.tracking_number === number);
    if (candidates.length !== 1) continue;
    const pack = candidates[0];
    trackingPairs++;
    const expected = new Map<string, number>(), actual = new Map<string, number>();
    for (const rawLine of shipment.lines as Row[]) add(expected, rawLine.sku as string, rawLine.quantity as number);
    for (const item of pack.items ?? []) {
      const sku = orderItems.get(item.line_id)!.seller_sku;
      if (sku !== null) add(actual, sku, item.quantity);
    }
    const contentsMatch = pack.items !== null && pack.items.length > 0 &&
      pack.items.every(item => item.quantity > 0 && orderItems.get(item.line_id)!.seller_sku !== null) && mismatches(expected, actual) === 0;
    if (!contentsMatch) packageQuantityMismatches++;
    else if (pack.package_status !== null && RECORDED_SHIPPED_STATES.has(pack.package_status)) matchedPackages++;
    if (!present(pack.carrier) || !present(tracks[0].company)) carrierMissing++;
    else if (pack.carrier === tracks[0].company) carrierMatches++;
    else carrierMismatches++;
  }
  // Carrier labels are compared independently. A difference must not erase
  // an exact tracking/quantity observation; neither label is a carrier code.
  const carrierLabelsMatch = trackingPairs === 0 || carrierMissing > 0 ? null : carrierMismatches === 0;
  let status = "REGISTERED_SHIPMENT_DATA_MATCHED";
  if (amazon.packages === null) status = "AMAZON_PACKAGES_UNAVAILABLE";
  else if (coverage.current_quantity_review_required) status = "CURRENT_QUANTITY_REVIEW_REQUIRED";
  else if (missingSkus > 0 || zeroOrderQuantities > 0) status = "ORDER_LINES_UNVERIFIED";
  else if (ambiguousSkus > 0) status = "SKU_LINE_IDENTITY_REVIEW_REQUIRED";
  else if (orderQuantityMismatches > 0) status = "ORDER_QUANTITY_RECONCILIATION_REQUIRED";
  else if (amazon.fulfillment_owner !== "MERCHANT" || !["SHIPPED", "PARTIALLY_SHIPPED"].includes(amazon.fulfillment_status ?? ""))
    status = "AMAZON_FULFILLMENT_STATE_REVIEW_REQUIRED";
  else if ((coverage.pending_fulfillments as number) > 0) status = "PENDING_FULFILLMENT_REVIEW";
  else if (successful.length === 0) status = "NO_SUCCESSFUL_SHOPIFY_FULFILLMENTS";
  else if (packages.length === 0) status = "NO_AMAZON_PACKAGES_OBSERVED";
  else if (packageStateReviews > 0) status = "AMAZON_PACKAGE_STATE_REVIEW_REQUIRED";
  else if (temporalReview) status = "TEMPORAL_STATE_REVIEW_REQUIRED";
  else if (packageContentsUnverified > 0 || zeroPackageQuantities > 0) status = "AMAZON_PACKAGE_CONTENTS_UNVERIFIED";
  else if (unknownFulfilledQuantities > 0) status = "AMAZON_FULFILLMENT_QUANTITIES_UNVERIFIED";
  else if (amazonQuantityConflicts > 0) status = "AMAZON_QUANTITY_RECONCILIATION_REQUIRED";
  else if (incompleteOrderShipment) status = "PARTIAL_SHIPMENT_REVIEW_REQUIRED";
  else if (missingShopifyTracking > 0 || missingAmazonTracking > 0) status = "TRACKING_MISSING";
  else if (multipleTracking > 0) status = "MULTIPACKAGE_ASSIGNMENT_REVIEW_REQUIRED";
  else if (duplicateTracking > 0) status = "DUPLICATE_TRACKING_REVIEW_REQUIRED";
  else if (trackingPairs !== packages.length || trackingPairs !== successful.length) status = "TRACKING_RECONCILIATION_REQUIRED";
  else if (packageQuantityMismatches > 0 || matchedPackages !== packages.length) status = "PACKAGE_QUANTITY_RECONCILIATION_REQUIRED";
  const trackingAndQuantitiesMatch = status === "REGISTERED_SHIPMENT_DATA_MATCHED";
  if (trackingAndQuantitiesMatch && carrierLabelsMatch !== true) status = "CARRIER_LABEL_REVIEW_REQUIRED";
  return {
    ok: true, source: "shopify_amazon_shipment_reconciliation", status,
    tracking_and_quantities_match: trackingAndQuantitiesMatch, matched_package_count: matchedPackages,
    amazon_package_count: amazon.packages === null ? null : packages.length,
    shopify_successful_fulfillment_count: successful.length,
    shopify_excluded_fulfillment_count: coverage.excluded_non_success_fulfillments,
    shopify_pending_fulfillment_count: coverage.pending_fulfillments,
    amazon_order_line_count: amazon.items.length, shopify_order_line_count: (lines.lines as Row[]).length,
    amazon_registered_package_units: registeredPackageUnits, shopify_successful_fulfillment_units: coverage.fulfillment_line_units,
    amazon_packages_dataset_present: amazon.packages !== null,
    amazon_package_state_review_count: packageStateReviews, amazon_package_contents_unverified_count: packageContentsUnverified,
    amazon_unknown_fulfilled_quantity_count: unknownFulfilledQuantities, amazon_quantity_conflict_count: amazonQuantityConflicts,
    order_sku_quantity_mismatch_count: orderQuantityMismatches, ambiguous_order_sku_count: ambiguousSkus,
    shopify_fulfillments_missing_tracking_count: missingShopifyTracking, amazon_packages_missing_tracking_count: missingAmazonTracking,
    multi_tracking_fulfillment_count: multipleTracking, duplicate_tracking_count: duplicateTracking,
    exact_tracking_pair_count: trackingPairs, package_quantity_mismatch_count: packageQuantityMismatches,
    carrier_labels_match: carrierLabelsMatch, carrier_label_match_count: carrierMatches,
    carrier_label_mismatch_count: carrierMismatches, carrier_label_missing_count: carrierMissing,
    current_quantity_review_required: coverage.current_quantity_review_required, temporal_state_review_required: temporalReview,
    read_only: true, provider_mutations: 0, importer_ownership: "NOT_TRANSFERRED_FROM_CHANNABLE",
    tracking_numbers_returned: false, tracking_urls_requested: false, tracking_number_fingerprints_returned: false,
    customer_fields_returned: false, can_confirm_marketplace_shipment: false, can_change_shopify_fulfillment: false,
    can_release_stock_reservation: false, can_change_inventory: false, can_advance_checkpoint: false,
    carrier_mapping_proven: false, carrier_handover_proven: false, delivery_proven: false,
    amazon_tracking_confirmation_proven: false, amazon_line_to_shopify_variant_mapping_proven: false,
    cross_provider_atomic_snapshot_proven: false, source_stability_reverified: false
  };
}

function now(clock: () => number): number {
  let value: number;
  try { value = clock(); } catch { fail("clock_invalid"); }
  if (!quantity(value) || !Number.isFinite(new Date(value).getTime())) fail("clock_invalid");
  return value;
}

/** Only this aggregate wrapper is exposed as a read capability. All identity,
 * source data and tracking are fetched server-side using configured accounts.
 * Sequential read observations are not an atomic snapshot or a stability check.
 */
export async function readShopifyAmazonShipmentReconciliation(
  input: unknown, env: ShopifyAmazonShipmentReconciliationEnv,
  dependencies: ShopifyAmazonShipmentReconciliationDependencies = {}
): Promise<Row> {
  const request = object(input, "invalid_request");
  exactKeys(request, ["marketplace", "shopify_order_gid", "amazon_order_id"], "invalid_request");
  if (!text(request.amazon_order_id, 19) || !ORDER_RE.test(request.amazon_order_id) ||
      !text(request.shopify_order_gid, 100) || !SHOPIFY_ORDER_RE.test(request.shopify_order_gid) ||
      typeof request.marketplace !== "string" || !Object.hasOwn(AMAZON_EU_MARKETPLACES, request.marketplace)) fail("invalid_request");
  const seller = env.AMAZON_SP_API_SELLER_ID;
  const shop = typeof env.SHOPIFY_SHOP_DOMAIN === "string"
    ? env.SHOPIFY_SHOP_DOMAIN.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "") : "";
  if (typeof seller !== "string" || !SELLER_RE.test(seller) || !SHOP_RE.test(shop)) fail("account_not_configured");
  const scope: ShopifyAmazonShipmentComparisonScope = {
    amazon_order_id: request.amazon_order_id, shopify_order_gid: request.shopify_order_gid,
    marketplace: request.marketplace as AmazonOrderPackagesMarketplace, account_id: seller
  };
  const clock = dependencies.clock ?? Date.now, started = now(clock);
  let lines: Row;
  try { lines = await (dependencies.readOrderLines ?? readShopifyChannableAmazonOrderLines)(
    { shopify_order_gid: scope.shopify_order_gid, amazon_order_id: scope.amazon_order_id }, env); }
  catch { fail("shopify_order_read_failed"); }
  if (lines?.shopify_order_gid !== scope.shopify_order_gid || lines?.amazon_order_id !== scope.amazon_order_id)
    fail("shopify_identity_conflict");
  let fulfillment: PrivateChannableFulfillmentObservation;
  try { fulfillment = await (dependencies.readFulfillmentMetadataPrivate ?? readShopifyChannableFulfillmentMetadataPrivate)(
    { provider: "amazon", shopify_order_gid: scope.shopify_order_gid, external_order_id: scope.amazon_order_id }, env); }
  catch { fail("shopify_fulfillment_read_failed"); }
  let amazon: AmazonOrderPackagesPrivateObservation;
  try { amazon = await (dependencies.readAmazonPackages ?? readAmazonOrderPackagesPrivate)(
    { amazon_order_id: scope.amazon_order_id, marketplace: scope.marketplace }, env); }
  catch (error) {
    fail(error instanceof Error ? AMAZON_READ_FAILURES.get(error.message) ?? "amazon_packages_read_failed" : "amazon_packages_read_failed");
  }
  const comparison = compareShopifyAmazonShipmentObservations(amazon, lines, fulfillment, scope);
  const completed = now(clock), amazonObserved = Date.parse(amazon.observed_at);
  if (completed < started || amazonObserved < started || amazonObserved > completed) fail("observation_time_conflict");
  return {
    ...comparison, observed_at: new Date(completed).toISOString(),
    observation_started_at: new Date(started).toISOString(), observation_duration_ms: completed - started
  };
}
