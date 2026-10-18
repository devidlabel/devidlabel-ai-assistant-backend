import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { MarketplaceCoreLedger, validateOrderSnapshot, type MarketplaceLedgerStore, type OrderSnapshot } from "./marketplace-core-ledger.js";
import { prepareAmazonOrderObservations, type PreparedAmazonObservation } from "./marketplace-order-shadow-intake.js";
import { reconcileAmazonShopifyOrderAdoption } from "./marketplace-amazon-channable-adoption-reconcile.js";

/** Immutable observation evidence. This module has no provider or Worker-runtime
 * imports. The authenticated controller reads providers; the actor supplies its
 * internal journal capture and the existing pure line comparator as callbacks.
 * A stored positive reference is never adoption, stock, or shipping authority.
 */
type Row = Record<string, unknown>;
export type OrderEvidenceEnv = {
  COMMERCE_TENANT_ID?: string;
  AMAZON_SP_API_SELLER_ID?: string;
  SHOPIFY_SHOP_DOMAIN?: string;
};
export type OrderEvidenceEnvelope = {
  amazon: unknown;
  shopify_index: unknown;
  shopify_lines: unknown;
  amazon_order_id: string;
};
export type OrderEvidenceStatus = "CAPTURED" | "ALREADY_CAPTURED" | "STORED_VERIFIED";
export type OrderEvidenceLineComparator = (amazon: unknown, shopify: unknown) => Row;
type ShopifyLine = {
  line_item_gid: string;
  sku: string;
  ordered_quantity: number;
  current_quantity: number;
  variant_gid: string;
};
type ShopifyReference = {
  amazon_order_id: string;
  shopify_order_gid: string;
  source_name: "amazon";
  importing_app: "Channable";
  shopify_created_at: string;
  adoption_status: "FOUND_CHANNABLE";
};
type AmazonBatch = {
  source: "amazon_spapi_orders_2026_01_01";
  identity_scope: "SELLER_ACCOUNT_PLUS_ORDER_ID";
  selected_marketplaces: string[];
  last_updated_after: string;
  last_updated_before: string;
  pages_read: number;
  complete_pagination: true;
  observations: PreparedAmazonObservation[];
};
type ShopifyIndex = {
  source: "shopify_channable_amazon_order_signature";
  created_after: string;
  created_before: string;
  pages_read: number;
  shopify_orders_scanned: number;
  outside_requested_utc_window_ignored: number;
  pagination_complete: true;
  external_order_id_field: "customAttributes.Amazon Order ID";
  found_count: number;
  unverified_count: 0;
  found: ShopifyReference[];
};
export type MarketplaceOrderEvidenceManifest = {
  schema: "mare_order_observation_evidence_v1";
  tenant_id: string;
  account_id: string;
  shop_domain: string;
  amazon_batch: AmazonBatch;
  shopify_index: ShopifyIndex;
  target: {
    amazon_order_id: string;
    marketplace_id: string;
    shopify_order_gid: string;
    snapshot_hash: string;
    needs_review: false;
    shopify_lines: ShopifyLine[];
  };
  comparison: Row;
  restrictions: typeof RESTRICTIONS;
};

const LIMIT = 20;
const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const SELLER_RE = /^[A-Z0-9]{8,30}$/;
const ORDER_RE = /^\d{3}-\d{7}-\d{7}$/;
const ORDER_GID_RE = /^gid:\/\/shopify\/Order\/\d+$/;
const LINE_GID_RE = /^gid:\/\/shopify\/LineItem\/\d+$/;
const VARIANT_GID_RE = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MATCHED = "REFERENCE_AND_QUANTITIES_MATCHED_NEEDS_FULFILLMENT_REVIEW";
const RESTRICTIONS = Object.freeze({
  evidence_kind: "SHADOW_OBSERVATION_ONLY",
  import_state: "SHADOW_ONLY",
  provider_mutations: 0,
  can_create_order: false,
  can_publish_offer: false,
  can_activate_offer_stock: false,
  can_adjust_inventory: false,
  can_send_tracking: false,
  can_confirm_shipment: false,
  can_advance_checkpoint: false,
  importer_enabled: false,
  scheduling_enabled: false,
  stock_effects: false,
  reservations_unchanged: true,
  importer_ownership: "NOT_TRANSFERRED_FROM_CHANNABLE",
  does_not_prove_inventory_reservation: true,
  does_not_prove_variant_mapping: true,
  does_not_prove_shipping_or_tracking: true,
  current_provider_state_reverified: false
} as const);
const AMAZON_KEYS = [
  "ok", "read_only", "source", "account_id", "identity_scope", "selected_marketplaces",
  "fulfilled_by", "last_updated_after", "last_updated_before", "pages_read", "order_count",
  "complete_pagination", "orders", "zero_quantity_line_count", "quantity_reconciliation_required",
  "zero_quantity_does_not_authorize_cancellation_or_restock", "customer_personal_data_requested",
  "importer_enabled", "tracking_enabled", "quantity_mutations_enabled", "can_advance_checkpoint", "remaining_gates"
];
const INDEX_KEYS = [
  "ok", "source", "read_only", "created_after", "created_before", "pages_read",
  "shopify_orders_scanned", "outside_requested_utc_window_ignored",
  "search_boundaries_padded_for_shop_timezone", "found_count", "unverified_count", "found", "unverified",
  "pagination_complete", "external_order_id_field", "standard_source_identifier_may_be_null",
  "absence_proven", "safe_to_create_shopify_order", "order_importer_owner", "next_step"
];
const LINES_KEYS = [
  "ok", "source", "amazon_order_id", "shopify_order_gid", "importer_app", "source_name",
  "line_count", "lines", "pagination_complete", "read_only", "all_line_skus_mapped",
  "order_import_already_present", "full_line_comparison_pending", "can_create_order",
  "can_adjust_inventory", "can_confirm_shipment"
];
function fail(code: string): never { throw new Error("order_evidence_" + code); }
function object(value: unknown): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid_object");
  return value as Row;
}
function keys(value: Row, allowed: readonly string[], exact = false): void {
  if (Object.keys(value).some(key => !allowed.includes(key)) ||
      (exact && Object.keys(value).length !== allowed.length)) fail("unexpected_fields");
}
function scope(env: OrderEvidenceEnv): {tenant: string; seller: string; shop: string} {
  const tenant = env.COMMERCE_TENANT_ID, seller = env.AMAZON_SP_API_SELLER_ID;
  const shop = typeof env.SHOPIFY_SHOP_DOMAIN === "string"
    ? env.SHOPIFY_SHOP_DOMAIN.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "") : "";
  if (typeof tenant !== "string" || !SCOPE_RE.test(tenant) ||
      typeof seller !== "string" || !SELLER_RE.test(seller) ||
      shop.length > 253 || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) fail("scope_not_configured");
  return {tenant, seller, shop};
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function safeString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}
function time(value: unknown): string {
  if (typeof value !== "string" || !TIME_RE.test(value) || !Number.isFinite(Date.parse(value))) fail("invalid_time");
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? "";
  if (/[1-9]/.test(fraction.slice(3))) fail("time_precision_unsupported");
  return new Date(value).toISOString();
}
function window(after: unknown, before: unknown, maxDays: number): [string, string] {
  const start = time(after), end = time(before);
  if (Date.parse(start) >= Date.parse(end) || Date.parse(end) - Date.parse(start) > maxDays * 86400000)
    fail("invalid_window");
  return [start, end];
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
/** JSON object property order is never part of receipt identity. Arrays are
 * explicitly ordered before hashing, and values come only from validators. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const row = value as Row;
  return "{" + Object.keys(row).sort().map(key => JSON.stringify(key) + ":" + canonical(row[key])).join(",") + "}";
}
async function sha(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function same(actual: unknown, expected: unknown, code: string): void {
  if (canonical(actual) !== canonical(expected)) fail(code);
}

function amazonBatch(raw: unknown, env: OrderEvidenceEnv): AmazonBatch {
  const source = object(raw), {seller} = scope(env);
  keys(source, AMAZON_KEYS);
  const observations = prepareAmazonOrderObservations(source, seller);
  if (observations.length < 1 || observations.length > LIMIT) fail("batch_limit");
  if (source.tracking_enabled !== false || source.quantity_mutations_enabled !== false) fail("amazon_source_mutations_enabled");
  const [after, before] = window(source.last_updated_after, source.last_updated_before, 7);
  let zeroLines = 0;
  for (const rawOrder of source.orders as unknown[]) {
    const order = object(rawOrder);
    if (!ORDER_RE.test(String(order.order_id))) fail("amazon_identity_invalid");
    for (const rawLine of order.items as unknown[]) {
      const line = object(rawLine);
      if (line.asin !== null && (typeof line.asin !== "string" || !/^[A-Z0-9]{10}$/.test(line.asin))) fail("amazon_asin_invalid");
      if (line.quantity_ordered === 0) zeroLines++;
    }
  }
  if ((source.zero_quantity_line_count !== undefined && source.zero_quantity_line_count !== zeroLines) ||
      (source.quantity_reconciliation_required !== undefined && source.quantity_reconciliation_required !== (zeroLines > 0)) ||
      (source.zero_quantity_does_not_authorize_cancellation_or_restock !== undefined &&
        source.zero_quantity_does_not_authorize_cancellation_or_restock !== true)) fail("amazon_source_counters_invalid");
  if (source.remaining_gates !== undefined && (!Array.isArray(source.remaining_gates) || source.remaining_gates.length > 20 ||
      source.remaining_gates.some(x => typeof x !== "string" || !/^[a-z_]{1,150}$/.test(x)))) fail("amazon_source_diagnostics_invalid");
  return {
    source: "amazon_spapi_orders_2026_01_01", identity_scope: "SELLER_ACCOUNT_PLUS_ORDER_ID",
    selected_marketplaces: [...source.selected_marketplaces as string[]].sort(compare),
    last_updated_after: after, last_updated_before: before, pages_read: source.pages_read as number,
    complete_pagination: true,
    observations: observations.sort((a, b) => compare(a.snapshot.order_id, b.snapshot.order_id))
  };
}
function references(raw: unknown, after: string, before: string): ShopifyReference[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 500) fail("shopify_index_empty_or_large");
  const ids = new Set<string>(), gids = new Set<string>();
  return raw.map(value => {
    const row = object(value);
    keys(row, ["amazon_order_id", "shopify_order_gid", "source_name", "importing_app", "shopify_created_at", "adoption_status"], true);
    if (typeof row.amazon_order_id !== "string" || !ORDER_RE.test(row.amazon_order_id) ||
        typeof row.shopify_order_gid !== "string" || !ORDER_GID_RE.test(row.shopify_order_gid) ||
        row.source_name !== "amazon" || row.importing_app !== "Channable" || row.adoption_status !== "FOUND_CHANNABLE" ||
        ids.has(row.amazon_order_id) || gids.has(row.shopify_order_gid)) fail("shopify_index_identity_conflict");
    const created = time(row.shopify_created_at);
    if (Date.parse(created) < Date.parse(after) || Date.parse(created) > Date.parse(before)) fail("shopify_reference_outside_window");
    ids.add(row.amazon_order_id); gids.add(row.shopify_order_gid);
    return {amazon_order_id: row.amazon_order_id, shopify_order_gid: row.shopify_order_gid,
      source_name: "amazon" as const, importing_app: "Channable" as const,
      shopify_created_at: created, adoption_status: "FOUND_CHANNABLE" as const};
  }).sort((a, b) => compare(a.amazon_order_id, b.amazon_order_id));
}
function indexProjection(raw: unknown): ShopifyIndex {
  const source = object(raw); keys(source, INDEX_KEYS);
  if (source.ok !== true || source.source !== "shopify_channable_amazon_order_signature" || source.read_only !== true ||
      source.pagination_complete !== true || source.absence_proven !== false || source.safe_to_create_shopify_order !== false ||
      source.order_importer_owner !== "CHANNABLE" || source.external_order_id_field !== "customAttributes.Amazon Order ID" ||
      source.standard_source_identifier_may_be_null !== true || source.search_boundaries_padded_for_shop_timezone !== true ||
      source.unverified_count !== 0 || !Array.isArray(source.unverified) || source.unverified.length !== 0 ||
      !integer(source.pages_read, 1, 10) || !integer(source.shopify_orders_scanned, 1, 500) ||
      !integer(source.outside_requested_utc_window_ignored, 0, 500) ||
      source.shopify_orders_scanned + source.outside_requested_utc_window_ignored > source.pages_read * 50 ||
      (source.next_step !== undefined && source.next_step !== "MATCH_FOUND_RECORDS_ONLY_AND_RECONCILE_ALL_UNVERIFIED_AND_OUT_OF_WINDOW_ORDERS"))
    fail("shopify_index_incomplete_or_unsafe");
  const [after, before] = window(source.created_after, source.created_before, 14);
  const found = references(source.found, after, before);
  if (source.found_count !== found.length || source.shopify_orders_scanned < found.length) fail("shopify_index_counters_invalid");
  return {source: "shopify_channable_amazon_order_signature", created_after: after, created_before: before,
    pages_read: source.pages_read, shopify_orders_scanned: source.shopify_orders_scanned,
    outside_requested_utc_window_ignored: source.outside_requested_utc_window_ignored,
    pagination_complete: true, external_order_id_field: "customAttributes.Amazon Order ID",
    found_count: found.length, unverified_count: 0, found};
}
function shopifyLines(raw: unknown): ShopifyLine[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 200) fail("shopify_lines_empty_or_large");
  const ids = new Set<string>();
  return raw.map(value => {
    const line = object(value);
    keys(line, ["line_item_gid", "sku", "ordered_quantity", "current_quantity", "variant_gid"], true);
    if (typeof line.line_item_gid !== "string" || !LINE_GID_RE.test(line.line_item_gid) || ids.has(line.line_item_gid) ||
        !safeString(line.sku) || typeof line.variant_gid !== "string" || !VARIANT_GID_RE.test(line.variant_gid) ||
        !integer(line.ordered_quantity, 1) || !integer(line.current_quantity, 1) ||
        line.current_quantity !== line.ordered_quantity) fail("shopify_lines_invalid_or_changed");
    ids.add(line.line_item_gid);
    return {line_item_gid: line.line_item_gid, sku: line.sku, ordered_quantity: line.ordered_quantity,
      current_quantity: line.current_quantity, variant_gid: line.variant_gid};
  }).sort((a, b) => compare(a.line_item_gid, b.line_item_gid));
}
function lineProjection(raw: unknown, orderId: string, gid: string): ShopifyLine[] {
  const source = object(raw); keys(source, LINES_KEYS, true);
  if (source.ok !== true || source.source !== "shopify_channable_amazon_order_lines" ||
      source.amazon_order_id !== orderId || source.shopify_order_gid !== gid ||
      source.importer_app !== "Channable" || source.source_name !== "amazon" ||
      source.pagination_complete !== true || source.read_only !== true || source.all_line_skus_mapped !== true ||
      source.order_import_already_present !== true || source.full_line_comparison_pending !== true ||
      source.can_create_order !== false || source.can_adjust_inventory !== false || source.can_confirm_shipment !== false)
    fail("shopify_lines_source_mismatch");
  const lines = shopifyLines(source.lines);
  if (source.line_count !== lines.length) fail("shopify_lines_count_invalid");
  return lines;
}
function targetObservation(batch: AmazonBatch, orderId: string): PreparedAmazonObservation {
  const matches = batch.observations.filter(x => x.snapshot.order_id === orderId);
  if (matches.length !== 1) fail("target_not_unique");
  const target = matches[0], snapshot = target.snapshot;
  if (target.needsReview || snapshot.fulfillment_owner !== "MERCHANT" ||
      !["UNSHIPPED", "PARTIALLY_SHIPPED", "SHIPPED"].includes(snapshot.fulfillment_status ?? "") ||
      snapshot.items.some(line => line.seller_sku === null || line.quantity_ordered < 1)) fail("target_requires_review");
  return target;
}
/** The reader verifies quantity semantics independently from the cached label.
 * This is deliberately narrower than operational inventory reconciliation. */
function matchedComparison(snapshot: OrderSnapshot, gid: string, lines: ShopifyLine[]): Row {
  const aggregate = (items: {sku: string; quantity: number}[]): Map<string, number> => {
    const quantities = new Map<string, number>();
    for (const item of items) {
      const total = (quantities.get(item.sku) ?? 0) + item.quantity;
      if (!integer(total, 1)) fail("line_quantity_sum_invalid");
      quantities.set(item.sku, total);
    }
    return quantities;
  };
  const amazon = aggregate(snapshot.items.map(x => ({sku: x.seller_sku!, quantity: x.quantity_ordered})));
  const shopify = aggregate(lines.map(x => ({sku: x.sku, quantity: x.ordered_quantity})));
  if (amazon.size !== shopify.size || [...amazon].some(([sku, quantity]) => shopify.get(sku) !== quantity))
    fail("line_quantity_mismatch");
  return {ok: true, amazon_order_id: snapshot.order_id, shopify_order_gid: gid, status: MATCHED,
    sku_quantity_mismatch_count: 0, shopify_current_quantity_differs_from_original: false,
    amazon_unresolved_lines: 0, shopify_unresolved_lines: 0, matched_unique_sku_count: amazon.size,
    read_only: true, does_not_prove_inventory_reservation: true, does_not_prove_shipping_or_tracking: true,
    may_create_shopify_order: false, may_release_reservations: false};
}

/** Validates the saved representation too: a valid-looking SHA alone does not
 * make corrupt, over-broad, cross-account, or operational-authority data valid. */
async function canonicalManifest(raw: unknown, env: OrderEvidenceEnv): Promise<MarketplaceOrderEvidenceManifest> {
  const input = object(raw), {tenant, seller, shop} = scope(env);
  keys(input, ["schema", "tenant_id", "account_id", "shop_domain", "amazon_batch", "shopify_index", "target", "comparison", "restrictions"], true);
  if (input.schema !== "mare_order_observation_evidence_v1" || input.tenant_id !== tenant || input.account_id !== seller || input.shop_domain !== shop)
    fail("manifest_scope_or_schema_invalid");
  same(input.restrictions, RESTRICTIONS, "restrictions_invalid");
  const batch = object(input.amazon_batch);
  keys(batch, ["source", "identity_scope", "selected_marketplaces", "last_updated_after", "last_updated_before", "pages_read", "complete_pagination", "observations"], true);
  if (batch.source !== "amazon_spapi_orders_2026_01_01" || batch.identity_scope !== "SELLER_ACCOUNT_PLUS_ORDER_ID" ||
      batch.complete_pagination !== true || !integer(batch.pages_read, 1, 5) ||
      !Array.isArray(batch.selected_marketplaces) || batch.selected_marketplaces.length < 1 || batch.selected_marketplaces.length > 4 ||
      batch.selected_marketplaces.some(x => typeof x !== "string" || !Object.hasOwn(AMAZON_EU_MARKETPLACES, x)) ||
      new Set(batch.selected_marketplaces).size !== batch.selected_marketplaces.length ||
      !Array.isArray(batch.observations) || batch.observations.length < 1 || batch.observations.length > LIMIT)
    fail("manifest_amazon_batch_invalid");
  const [after, before] = window(batch.last_updated_after, batch.last_updated_before, 7);
  const markets = [...batch.selected_marketplaces as string[]].sort(compare);
  const marketIds = new Set(markets.map(m => AMAZON_EU_MARKETPLACES[m as keyof typeof AMAZON_EU_MARKETPLACES]));
  const seen = new Set<string>();
  const observations = batch.observations.map(value => {
    const observation = object(value); keys(observation, ["snapshot", "needsReview"], true);
    const snapshot = validateOrderSnapshot(observation.snapshot as OrderSnapshot);
    if (snapshot.provider !== "amazon" || snapshot.account !== seller || !ORDER_RE.test(snapshot.order_id) ||
        seen.has(snapshot.order_id) || !marketIds.has(snapshot.marketplace_id as typeof AMAZON_EU_MARKETPLACES[keyof typeof AMAZON_EU_MARKETPLACES]) ||
        Date.parse(snapshot.source_updated_at) < Date.parse(after) || Date.parse(snapshot.source_updated_at) > Date.parse(before) ||
        typeof observation.needsReview !== "boolean" ||
        (!observation.needsReview && (snapshot.fulfillment_owner !== "MERCHANT" || snapshot.fulfillment_status === "CANCELLED" ||
          snapshot.items.some(x => x.seller_sku === null || x.quantity_ordered === 0)))) fail("manifest_observation_invalid");
    seen.add(snapshot.order_id);
    return {snapshot, needsReview: observation.needsReview};
  }).sort((a, b) => compare(a.snapshot.order_id, b.snapshot.order_id));
  const normalizedBatch: AmazonBatch = {source: "amazon_spapi_orders_2026_01_01", identity_scope: "SELLER_ACCOUNT_PLUS_ORDER_ID",
    selected_marketplaces: markets, last_updated_after: after, last_updated_before: before,
    pages_read: batch.pages_read, complete_pagination: true, observations};
  const index = object(input.shopify_index);
  keys(index, ["source", "created_after", "created_before", "pages_read", "shopify_orders_scanned", "outside_requested_utc_window_ignored",
    "pagination_complete", "external_order_id_field", "found_count", "unverified_count", "found"], true);
  const normalizedIndex = indexProjection({...index, ok: true, read_only: true, unverified: [],
    search_boundaries_padded_for_shop_timezone: true, standard_source_identifier_may_be_null: true,
    absence_proven: false, safe_to_create_shopify_order: false, order_importer_owner: "CHANNABLE"});
  const target = object(input.target);
  keys(target, ["amazon_order_id", "marketplace_id", "shopify_order_gid", "snapshot_hash", "needs_review", "shopify_lines"], true);
  if (typeof target.amazon_order_id !== "string" || !ORDER_RE.test(target.amazon_order_id) || target.needs_review !== false)
    fail("manifest_target_invalid");
  const observed = targetObservation(normalizedBatch, target.amazon_order_id);
  const reference = normalizedIndex.found.find(x => x.amazon_order_id === target.amazon_order_id);
  if (!reference || target.shopify_order_gid !== reference.shopify_order_gid || target.marketplace_id !== observed.snapshot.marketplace_id)
    fail("manifest_target_reference_mismatch");
  const snapshotHash = await sha(JSON.stringify(observed.snapshot));
  if (target.snapshot_hash !== snapshotHash) fail("manifest_target_snapshot_hash_invalid");
  const lines = shopifyLines(target.shopify_lines);
  const comparison = matchedComparison(observed.snapshot, reference.shopify_order_gid, lines);
  same(input.comparison, comparison, "manifest_comparison_invalid");
  return {schema: "mare_order_observation_evidence_v1", tenant_id: tenant, account_id: seller, shop_domain: shop,
    amazon_batch: normalizedBatch, shopify_index: normalizedIndex,
    target: {amazon_order_id: target.amazon_order_id, marketplace_id: observed.snapshot.marketplace_id,
      shopify_order_gid: reference.shopify_order_gid, snapshot_hash: snapshotHash, needs_review: false, shopify_lines: lines},
    comparison, restrictions: {...RESTRICTIONS}};
}
async function receiptFor(manifest: MarketplaceOrderEvidenceManifest): Promise<Row> {
  return {ok: true, schema: "mare_order_observation_receipt_v1",
    source: "AMAZON_CHANNABLE_SHOPIFY_OBSERVATION_EVIDENCE",
    receipt_id: await sha(canonical(manifest)), tenant_id: manifest.tenant_id, account_id: manifest.account_id, shop_domain: manifest.shop_domain,
    amazon_order_id: manifest.target.amazon_order_id, marketplace_id: manifest.target.marketplace_id,
    shopify_order_gid: manifest.target.shopify_order_gid,
    amazon_orders_in_batch: manifest.amazon_batch.observations.length,
    amazon_order_line_count: manifest.amazon_batch.observations.find(x => x.snapshot.order_id === manifest.target.amazon_order_id)!.snapshot.items.length,
    shopify_order_line_count: manifest.target.shopify_lines.length,
    matched_unique_sku_count: manifest.comparison.matched_unique_sku_count,
    comparison_status: MATCHED, local_persistence_verified: true,
    ...RESTRICTIONS};
}

/** Used identically by controller and actor, before any capture is attempted. */
export async function prepareMarketplaceOrderEvidence(
  raw: unknown, env: OrderEvidenceEnv, compareLines: OrderEvidenceLineComparator
): Promise<{manifest: MarketplaceOrderEvidenceManifest; receipt: Row; observations: PreparedAmazonObservation[]}> {
  const envelope = object(raw); keys(envelope, ["amazon", "shopify_index", "shopify_lines", "amazon_order_id"], true);
  if (typeof envelope.amazon_order_id !== "string" || !ORDER_RE.test(envelope.amazon_order_id) || typeof compareLines !== "function")
    fail("invalid_request");
  const {tenant, seller, shop} = scope(env);
  const batch = amazonBatch(envelope.amazon, env), index = indexProjection(envelope.shopify_index);
  const observed = targetObservation(batch, envelope.amazon_order_id);
  const reconciliation = reconcileAmazonShopifyOrderAdoption(envelope.amazon, envelope.shopify_index);
  if (reconciliation.channable_shopify_index_unverified_count !== 0 || !Array.isArray(reconciliation.matched))
    fail("index_reconciliation_unverified");
  const matches = reconciliation.matched.map(object).filter(x => x.amazon_order_id === envelope.amazon_order_id);
  const reference = index.found.find(x => x.amazon_order_id === envelope.amazon_order_id);
  if (matches.length !== 1 || !reference || matches[0].shopify_order_gid !== reference.shopify_order_gid)
    fail("target_positive_reference_missing");
  const lines = lineProjection(envelope.shopify_lines, envelope.amazon_order_id, reference.shopify_order_gid);
  const amazonOrder = (object(envelope.amazon).orders as unknown[]).map(object).find(x => x.order_id === envelope.amazon_order_id)!;
  const comparison = matchedComparison(observed.snapshot, reference.shopify_order_gid, lines);
  same(compareLines(amazonOrder, envelope.shopify_lines), comparison, "comparator_result_invalid");
  const manifest = await canonicalManifest({schema: "mare_order_observation_evidence_v1", tenant_id: tenant, account_id: seller, shop_domain: shop,
    amazon_batch: batch, shopify_index: index,
    target: {amazon_order_id: envelope.amazon_order_id, marketplace_id: observed.snapshot.marketplace_id,
      shopify_order_gid: reference.shopify_order_gid, snapshot_hash: await sha(JSON.stringify(observed.snapshot)),
      needs_review: false, shopify_lines: lines}, comparison, restrictions: {...RESTRICTIONS}}, env);
  return {manifest, receipt: await receiptFor(manifest), observations: manifest.amazon_batch.observations};
}

export async function verifyMarketplaceOrderEvidenceProof(
  proofRaw: unknown, env: OrderEvidenceEnv,
  options: {receipt_id?: string; expected_manifest?: unknown; allowed_statuses?: readonly OrderEvidenceStatus[]} = {}
): Promise<Row> {
  const proof = object(proofRaw);
  const manifest = await canonicalManifest(proof.manifest, env);
  const expected = await receiptFor(manifest);
  keys(proof, [...Object.keys(expected), "status", "manifest"], true);
  const statuses = options.allowed_statuses ?? ["CAPTURED", "ALREADY_CAPTURED", "STORED_VERIFIED"];
  if (!statuses.includes(proof.status as OrderEvidenceStatus)) fail("proof_status_invalid");
  for (const key of Object.keys(expected)) same(proof[key], expected[key], "proof_content_invalid");
  same(proof.manifest, manifest, "proof_manifest_not_canonical");
  if (options.receipt_id !== undefined && (!HASH_RE.test(options.receipt_id) || expected.receipt_id !== options.receipt_id))
    fail("proof_receipt_id_mismatch");
  if (options.expected_manifest !== undefined) {
    const requested = await canonicalManifest(options.expected_manifest, env);
    same(manifest, requested, "proof_manifest_mismatch");
  }
  return {...expected, status: proof.status, manifest};
}

type EvidenceDependencies = {
  compareLines: OrderEvidenceLineComparator;
  captureAmazonOrderBatch: (raw: unknown, store: MarketplaceLedgerStore, env: OrderEvidenceEnv) => Promise<Row>;
};
function proofKey(tenant: string, receiptId: string): string { return "order-evidence:v1:" + tenant + ":" + receiptId; }
function captureProof(raw: unknown, manifest: MarketplaceOrderEvidenceManifest): void {
  const proof = object(raw);
  if (proof.ok !== true || !["CAPTURED", "ALREADY_CAPTURED"].includes(String(proof.status)) ||
      proof.tenant_id !== manifest.tenant_id || proof.account_id !== manifest.account_id ||
      typeof proof.receipt_id !== "string" || !HASH_RE.test(proof.receipt_id) ||
      proof.order_count !== manifest.amazon_batch.observations.length || proof.local_persistence_verified !== true ||
      proof.source !== "AMAZON_OBSERVATIONS_ONLY" || proof.import_state !== "SHADOW_ONLY" || proof.provider_mutations !== 0 ||
      proof.importer_enabled !== false || proof.stock_effects !== false || proof.reservations_unchanged !== true ||
      proof.can_advance_checkpoint !== false || proof.can_create_order !== false ||
      proof.can_publish_offer !== false || proof.can_send_tracking !== false || proof.scheduling_enabled !== false)
    fail("journal_capture_unverified");
}
/** The only mutation is local evidence storage after the actor's journal
 * callback. The exact current Core snapshot is checked within the same evidence
 * transaction, preventing a concurrent newer revision from being blessed.
 */
export async function captureMarketplaceOrderEvidence(
  raw: unknown, store: MarketplaceLedgerStore, env: OrderEvidenceEnv, dependencies: EvidenceDependencies
): Promise<Row> {
  if (!dependencies || typeof dependencies.captureAmazonOrderBatch !== "function") fail("capture_dependency_missing");
  // Freeze caller-owned inputs across awaits; actors receive ordinary JSON.
  let envelope: unknown;
  try { envelope = structuredClone(raw); } catch { fail("invalid_request"); }
  const prepared = await prepareMarketplaceOrderEvidence(envelope, env, dependencies.compareLines);
  const {manifest, receipt} = prepared, {tenant, seller} = scope(env);
  captureProof(await dependencies.captureAmazonOrderBatch(object(envelope).amazon, store, env), manifest);
  const key = proofKey(tenant, String(receipt.receipt_id));
  const snapshot = targetObservation(manifest.amazon_batch, manifest.target.amazon_order_id).snapshot;
  const replayed = await store.transaction(async tx => {
    const ledger = new MarketplaceCoreLedger(tx, tenant);
    const current = await ledger.readMarketplaceOrder({provider: "amazon", account: seller, order_id: snapshot.order_id});
    if (!current || current.import_state !== "SHADOW_ONLY" || !integer(current.revision, 1) ||
        current.updated_ms !== Date.parse(snapshot.source_updated_at) || !integer(current.observed_at, 0) ||
        current.snapshot_hash !== manifest.target.snapshot_hash) fail("core_snapshot_not_current");
    const normalized = validateOrderSnapshot({provider: current.provider, account: current.account,
      order_id: current.order_id, marketplace_id: current.marketplace_id, source_updated_at: current.source_updated_at,
      fulfillment_status: current.fulfillment_status, fulfillment_owner: current.fulfillment_owner, items: current.items});
    same(normalized, snapshot, "core_snapshot_mismatch");
    const prior = await tx.get<unknown>(key);
    if (prior !== undefined) {
      await storedProof(prior, env, String(receipt.receipt_id), manifest);
      return true;
    }
    const storedAt = Date.now();
    if (!integer(storedAt, 0)) fail("clock_invalid");
    await tx.put(key, {schema: "mare_order_evidence_storage_v1", manifest, receipt, stored_at: storedAt});
    return false;
  });
  const proof = await readMarketplaceOrderEvidence(String(receipt.receipt_id), store, env);
  return verifyMarketplaceOrderEvidenceProof({...proof, status: replayed ? "ALREADY_CAPTURED" : "CAPTURED"}, env,
    {receipt_id: String(receipt.receipt_id), expected_manifest: manifest, allowed_statuses: ["CAPTURED", "ALREADY_CAPTURED"]});
}
async function storedProof(raw: unknown, env: OrderEvidenceEnv, receiptId: string, expectedManifest?: unknown): Promise<Row> {
  const stored = object(raw);
  keys(stored, ["schema", "manifest", "receipt", "stored_at"], true);
  if (stored.schema !== "mare_order_evidence_storage_v1" || !integer(stored.stored_at, 0)) fail("stored_record_invalid");
  const receipt = object(stored.receipt);
  const verified = await verifyMarketplaceOrderEvidenceProof({...receipt, manifest: stored.manifest, status: "STORED_VERIFIED"}, env,
    {receipt_id: receiptId, expected_manifest: expectedManifest, allowed_statuses: ["STORED_VERIFIED"]});
  const expectedReceipt = Object.fromEntries(Object.entries(verified).filter(([key]) => key !== "manifest" && key !== "status"));
  keys(receipt, Object.keys(expectedReceipt), true);
  same(receipt, expectedReceipt, "stored_receipt_invalid");
  return verified;
}
/** Standalone read. No provider requests, Core changes, receipt rewrites, or
 * assertions that a historical observation is still today's provider state. */
export async function readMarketplaceOrderEvidence(
  receiptId: string, store: MarketplaceLedgerStore, env: OrderEvidenceEnv
): Promise<Row> {
  const {tenant} = scope(env);
  if (typeof receiptId !== "string" || !HASH_RE.test(receiptId)) fail("receipt_id_invalid");
  const stored = await store.get<unknown>(proofKey(tenant, receiptId));
  if (stored === undefined) fail("receipt_not_found");
  return storedProof(stored, env, receiptId);
}
