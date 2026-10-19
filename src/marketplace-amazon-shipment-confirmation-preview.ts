import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { shopifyGraphQL } from "./index.js";
import {
  readAmazonOrderPackagesPrivate,
  type AmazonOrderPackagesEnv,
  type AmazonOrderPackagesPrivateObservation,
} from "./marketplace-amazon-order-packages.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

type Row = Record<string, unknown>;
type Market = keyof typeof AMAZON_EU_MARKETPLACES;
type Env = AmazonOrderPackagesEnv & MareBusinessShopifyEnv & {
  AMAZON_SHIPMENT_CARRIER_MAP_JSON?: string;
  [key: string]: unknown;
};

export type AmazonShipmentConfirmationPreviewInput = Readonly<{
  marketplace: Market;
  shopify_order_gid: string;
  amazon_order_id: string;
}>;

export type AmazonShipmentConfirmationPreviewDependencies = {
  readAmazonPackages?: typeof readAmazonOrderPackagesPrivate;
  readShopify?: typeof readShopifyShipmentSource;
  clock?: () => number;
};

type ShopifyShipmentSource = {
  order_gid: string;
  amazon_order_id: string;
  fulfillments: Array<{
    fulfillment_gid: string;
    status: string;
    created_at: string;
    tracking: Array<{ company: string | null; number: string | null }>;
    lines: Array<{ line_item_gid: string; sku: string | null; quantity: number }>;
  }>;
};

type CarrierMapping = {
  carrier_code: string;
  carrier_name?: string;
  shipping_method?: string;
};

const ORDER_GID_RE = /^gid:\/\/shopify\/Order\/[1-9]\d{0,30}$/;
const FULFILLMENT_GID_RE = /^gid:\/\/shopify\/Fulfillment\/[1-9]\d{0,30}$/;
const LINE_GID_RE = /^gid:\/\/shopify\/LineItem\/[1-9]\d{0,30}$/;
const AMAZON_ORDER_RE = /^\d{3}-\d{7}-\d{7}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_FULFILLMENTS = 10;
const MAX_TRACKING = 10;
const MAX_LINES = 50;
const MAX_CARRIER_MAP = 64;
const PROVIDER = "amazon";
const SOURCE_ATTRIBUTE_KEY = "Amazon Order ID";

export const SHOPIFY_AMAZON_SHIPMENT_CONFIRMATION_PREVIEW_QUERY = `
query MareAmazonShipmentConfirmationPreview($id: ID!) {
  order(id: $id) {
    id
    sourceName
    sourceIdentifier
    app { name }
    customAttributes { key value }
    fulfillments(first: 10) {
      id
      status
      createdAt
      trackingInfo(first: 10) { company number }
      fulfillmentLineItems(first: 50) {
        pageInfo { hasNextPage endCursor }
        nodes {
          quantity
          lineItem { id sku }
        }
      }
    }
  }
}
`;

function object(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL_RE.test(value)
    ? value : null;
}
function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 100_000
    ? value : null;
}
function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) return null;
  return value;
}
function now(clock: () => number): string {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime()))
    throw new Error("amazon_shipment_preview_invalid_clock");
  return new Date(value).toISOString();
}

export function validateAmazonShipmentConfirmationPreviewRequest(raw: unknown): AmazonShipmentConfirmationPreviewInput {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("amazon_shipment_preview_invalid_request");
  const row = raw as Row;
  const keys = Object.keys(row).sort();
  if (keys.join(",") !== "amazon_order_id,marketplace,shopify_order_gid" ||
      typeof row.marketplace !== "string" || !Object.hasOwn(AMAZON_EU_MARKETPLACES, row.marketplace) ||
      typeof row.shopify_order_gid !== "string" || !ORDER_GID_RE.test(row.shopify_order_gid) ||
      typeof row.amazon_order_id !== "string" || !AMAZON_ORDER_RE.test(row.amazon_order_id))
    throw new Error("amazon_shipment_preview_invalid_request");
  return Object.freeze({
    marketplace: row.marketplace as Market,
    shopify_order_gid: row.shopify_order_gid,
    amazon_order_id: row.amazon_order_id,
  });
}

async function readShopifyShipmentSource(
  input: AmazonShipmentConfirmationPreviewInput,
  env: MareBusinessShopifyEnv,
): Promise<ShopifyShipmentSource> {
  const data = await shopifyGraphQL<{ order?: unknown }>(
    env,
    SHOPIFY_AMAZON_SHIPMENT_CONFIRMATION_PREVIEW_QUERY,
    { id: input.shopify_order_gid },
  );
  const order = object(data.order);
  if (order.id !== input.shopify_order_gid || order.sourceName !== PROVIDER ||
      object(order.app).name !== "Channable")
    throw new Error("amazon_shipment_preview_shopify_order_identity_unverified");
  const sourceIdentifier = text(order.sourceIdentifier, 128);
  const attributes = Array.isArray(order.customAttributes) ? order.customAttributes.map(object) : [];
  const attributeIds = attributes
    .filter(attribute => attribute.key === SOURCE_ATTRIBUTE_KEY)
    .map(attribute => text(attribute.value, 128))
    .filter((value): value is string => value !== null);
  if ((sourceIdentifier && sourceIdentifier !== input.amazon_order_id) ||
      (attributeIds.length > 0 && (attributeIds.length !== 1 || attributeIds[0] !== input.amazon_order_id)) ||
      (!sourceIdentifier && attributeIds.length === 0))
    throw new Error("amazon_shipment_preview_shopify_order_reference_unverified");

  if (!Array.isArray(order.fulfillments) || order.fulfillments.length < 1 ||
      order.fulfillments.length > MAX_FULFILLMENTS)
    throw new Error("amazon_shipment_preview_fulfillments_unavailable");

  const seenFulfillments = new Set<string>();
  const seenLines = new Set<string>();
  const fulfillments = order.fulfillments.map(rawFulfillment => {
    const fulfillment = object(rawFulfillment);
    const fulfillmentGid = text(fulfillment.id, 100);
    const status = text(fulfillment.status, 60);
    const createdAt = timestamp(fulfillment.createdAt);
    if (!fulfillmentGid || !FULFILLMENT_GID_RE.test(fulfillmentGid) || seenFulfillments.has(fulfillmentGid) ||
        !status || !createdAt)
      throw new Error("amazon_shipment_preview_fulfillment_invalid");
    seenFulfillments.add(fulfillmentGid);

    if (!Array.isArray(fulfillment.trackingInfo) || fulfillment.trackingInfo.length > MAX_TRACKING)
      throw new Error("amazon_shipment_preview_tracking_set_invalid");
    const tracking = fulfillment.trackingInfo.map(rawTracking => {
      const track = object(rawTracking);
      const company = track.company === null ? null : text(track.company, 90);
      const number = track.number === null ? null : text(track.number, 256);
      if ((track.company !== null && !company) || (track.number !== null && !number))
        throw new Error("amazon_shipment_preview_tracking_invalid");
      return { company, number };
    });

    const connection = object(fulfillment.fulfillmentLineItems);
    const pageInfo = object(connection.pageInfo);
    if (pageInfo.hasNextPage !== false || !Array.isArray(connection.nodes) ||
        connection.nodes.length < 1 || connection.nodes.length > MAX_LINES)
      throw new Error("amazon_shipment_preview_fulfillment_lines_incomplete");
    const lines = connection.nodes.map(rawNode => {
      const node = object(rawNode), line = object(node.lineItem);
      const lineGid = text(line.id, 100), sku = line.sku === null ? null : text(line.sku, 200);
      const quantity = positive(node.quantity);
      if (!lineGid || !LINE_GID_RE.test(lineGid) || seenLines.has(lineGid) || quantity === null ||
          (line.sku !== null && !sku))
        throw new Error("amazon_shipment_preview_fulfillment_line_invalid");
      seenLines.add(lineGid);
      return { line_item_gid: lineGid, sku, quantity };
    });
    return {
      fulfillment_gid: fulfillmentGid,
      status,
      created_at: createdAt,
      tracking,
      lines,
    };
  });

  return {
    order_gid: input.shopify_order_gid,
    amazon_order_id: input.amazon_order_id,
    fulfillments,
  };
}

function parseCarrierMap(raw: unknown): Map<string, CarrierMapping> {
  if (typeof raw !== "string" || !raw.trim()) return new Map();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return new Map(); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
  const entries = Object.entries(parsed as Row);
  if (entries.length > MAX_CARRIER_MAP) return new Map();
  const result = new Map<string, CarrierMapping>();
  for (const [label, rawMapping] of entries) {
    const safeLabel = text(label, 90), mapping = object(rawMapping);
    const carrierCode = text(mapping.carrier_code, 90);
    const carrierName = mapping.carrier_name === undefined ? undefined : text(mapping.carrier_name, 90);
    const shippingMethod = mapping.shipping_method === undefined ? undefined : text(mapping.shipping_method, 120);
    if (!safeLabel || !carrierCode || (mapping.carrier_name !== undefined && !carrierName) ||
        (mapping.shipping_method !== undefined && !shippingMethod) ||
        (carrierCode === "Other" && !carrierName))
      return new Map();
    result.set(safeLabel, {
      carrier_code: carrierCode,
      ...(carrierName ? { carrier_name: carrierName } : {}),
      ...(shippingMethod ? { shipping_method: shippingMethod } : {}),
    });
  }
  return result;
}

function add(map: Map<string, number>, key: string, quantity: number): void {
  const next = (map.get(key) ?? 0) + quantity;
  if (!Number.isSafeInteger(next)) throw new Error("amazon_shipment_preview_quantity_overflow");
  map.set(key, next);
}

export async function previewAmazonShipmentConfirmation(
  rawInput: unknown,
  env: Env,
  dependencies: AmazonShipmentConfirmationPreviewDependencies = {},
): Promise<Row> {
  const input = validateAmazonShipmentConfirmationPreviewRequest(rawInput);
  const clock = dependencies.clock ?? Date.now;
  const observedAt = now(clock);
  let shopify: ShopifyShipmentSource;
  try {
    shopify = await (dependencies.readShopify ?? readShopifyShipmentSource)(input, env);
  } catch {
    return {
      ok: false, status: "BLOCKED_PREVIEW", reason: "shopify_shipment_source_unverified",
      marketplace: input.marketplace, shopify_order_gid: input.shopify_order_gid,
      amazon_order_id: input.amazon_order_id, observed_at: observedAt,
      provider_request_performed: false, provider_mutations: 0, preview_only: true,
      can_confirm_shipment: false,
    };
  }

  let amazon: AmazonOrderPackagesPrivateObservation;
  try {
    amazon = await (dependencies.readAmazonPackages ?? readAmazonOrderPackagesPrivate)(
      { amazon_order_id: input.amazon_order_id, marketplace: input.marketplace },
      env,
    );
  } catch {
    return {
      ok: false, status: "BLOCKED_PREVIEW", reason: "amazon_order_read_unverified",
      marketplace: input.marketplace, shopify_order_gid: input.shopify_order_gid,
      amazon_order_id: input.amazon_order_id, observed_at: observedAt,
      provider_request_performed: false, provider_mutations: 0, preview_only: true,
      can_confirm_shipment: false,
    };
  }

  const blockers: string[] = [];
  if (amazon.marketplace !== input.marketplace ||
      amazon.marketplace_id !== AMAZON_EU_MARKETPLACES[input.marketplace] ||
      amazon.order_id !== input.amazon_order_id || amazon.read_only !== true ||
      amazon.provider_mutations !== 0 || amazon.fulfillment_owner !== "MERCHANT")
    blockers.push("amazon_order_identity_or_owner_unverified");
  if (amazon.fulfillment_status !== "UNSHIPPED")
    blockers.push("pilot_requires_fully_unshipped_order");
  if (amazon.packages === null)
    blockers.push("amazon_packages_dataset_unavailable");
  else if (amazon.packages.length > 0)
    blockers.push("amazon_packages_already_registered");

  const amazonBySku = new Map<string, { line_id: string; quantity: number }>();
  const duplicateAmazonSkus = new Set<string>();
  for (const item of amazon.items) {
    if (!item.seller_sku || item.quantity_ordered < 1) {
      blockers.push("amazon_order_item_sku_or_quantity_unverified");
      continue;
    }
    if (amazonBySku.has(item.seller_sku)) duplicateAmazonSkus.add(item.seller_sku);
    amazonBySku.set(item.seller_sku, { line_id: item.line_id, quantity: item.quantity_ordered });
    if ((item.quantity_fulfilled !== null && item.quantity_fulfilled !== 0) ||
        (item.quantity_unfulfilled !== null && item.quantity_unfulfilled !== item.quantity_ordered))
      blockers.push("amazon_order_already_partially_fulfilled");
  }
  if (duplicateAmazonSkus.size > 0) blockers.push("duplicate_amazon_sku_requires_line_mapping");

  const carrierMap = parseCarrierMap(env.AMAZON_SHIPMENT_CARRIER_MAP_JSON);
  const fulfilledByAmazonLine = new Map<string, number>();
  const packages: Row[] = [];
  const sortedFulfillments = [...shopify.fulfillments].sort((a, b) =>
    a.created_at.localeCompare(b.created_at) || a.fulfillment_gid.localeCompare(b.fulfillment_gid));

  for (let index = 0; index < sortedFulfillments.length; index++) {
    const fulfillment = sortedFulfillments[index];
    if (fulfillment.status !== "SUCCESS") {
      blockers.push("shopify_non_success_fulfillment_present");
      continue;
    }
    if (fulfillment.tracking.length !== 1 ||
        !fulfillment.tracking[0].number || !fulfillment.tracking[0].company) {
      blockers.push("pilot_requires_one_complete_tracking_entry_per_fulfillment");
      continue;
    }
    const mapping = carrierMap.get(fulfillment.tracking[0].company);
    if (!mapping) blockers.push("carrier_code_mapping_not_verified");

    const orderItems: Array<{ orderItemId: string; quantity: number }> = [];
    let unitCount = 0;
    for (const line of fulfillment.lines) {
      if (!line.sku) {
        blockers.push("shopify_fulfillment_line_sku_missing");
        continue;
      }
      const amazonItem = amazonBySku.get(line.sku);
      if (!amazonItem || duplicateAmazonSkus.has(line.sku)) {
        blockers.push("shopify_to_amazon_order_item_mapping_unverified");
        continue;
      }
      add(fulfilledByAmazonLine, amazonItem.line_id, line.quantity);
      orderItems.push({ orderItemId: amazonItem.line_id, quantity: line.quantity });
      unitCount += line.quantity;
    }

    packages.push({
      package_reference_id: String(index + 1),
      fulfillment_created_at: fulfillment.created_at,
      carrier_label: fulfillment.tracking[0].company,
      carrier_code: mapping?.carrier_code ?? null,
      carrier_name: mapping?.carrier_name ?? null,
      shipping_method: mapping?.shipping_method ?? null,
      tracking_number_present: true,
      order_item_count: orderItems.length,
      unit_count: unitCount,
      payload_fields_ready: Boolean(mapping) && orderItems.length === fulfillment.lines.length,
    });
  }

  for (const item of amazon.items) {
    if ((fulfilledByAmazonLine.get(item.line_id) ?? 0) !== item.quantity_ordered)
      blockers.push("full_order_quantity_coverage_not_proven");
  }

  const uniqueBlockers = [...new Set(blockers)];
  const ready = uniqueBlockers.length === 0 && packages.length > 0;
  return {
    ok: true,
    status: ready ? "PREVIEW_READY_FOR_LIVE_PLAN_DESIGN" : "PREVIEW_REVIEW_REQUIRED",
    marketplace: input.marketplace,
    marketplace_id: AMAZON_EU_MARKETPLACES[input.marketplace],
    shopify_order_gid: input.shopify_order_gid,
    amazon_order_id: input.amazon_order_id,
    observed_at: observedAt,
    endpoint_template: "/orders/v0/orders/{orderId}/shipmentConfirmation",
    http_method: "POST",
    amazon_request_schema: "ConfirmShipmentRequest",
    amazon_success_status: 204,
    package_count: packages.length,
    packages,
    blocker_count: uniqueBlockers.length,
    blockers: uniqueBlockers,
    carrier_map_configured: carrierMap.size > 0,
    provider_request_performed: false,
    provider_mutations: 0,
    preview_only: true,
    tracking_numbers_returned: false,
    customer_fields_requested: false,
    customer_fields_returned: false,
    source_stability_recheck_required_before_write: true,
    explicit_live_approval_required_before_write: true,
    channable_remains_live_owner: true,
    can_confirm_shipment: false,
    live_writer_implemented: false,
    next_step: ready
      ? "ADD_FAIL_CLOSED_EXECUTE_PLAN_WITH_FRESH_SOURCE_RECHECK_AND_HTTP_204_READBACK"
      : "RESOLVE_PREVIEW_BLOCKERS_BEFORE_LIVE_WRITER_DESIGN",
  };
}
