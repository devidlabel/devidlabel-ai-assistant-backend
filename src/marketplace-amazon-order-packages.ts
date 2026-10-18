import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";

/** Internal, transient readback only. Never expose this projection through an
 * MCP result, log, journal, receipt, cache or hash: it contains raw tracking.
 * Official schema: amzn/selling-partner-api-models, orders_2026-01-01.json.
 * getOrder has no marketplace query parameter and no package pagination.
 */
export type AmazonOrderPackagesMarketplace = keyof typeof AMAZON_EU_MARKETPLACES;
export type AmazonOrderPackagesInput = {
  amazon_order_id: string;
  marketplace: AmazonOrderPackagesMarketplace;
};
export type AmazonOrderPackagesEnv = AmazonCredentials & { AMAZON_SP_API_SELLER_ID?: string };
export type AmazonPackageStatus =
  | "PENDING" | "IN_TRANSIT" | "SHIPPED" | "DELIVERED" | "CANCELLED" | "UNDELIVERABLE";
export type AmazonOrderFulfillmentStatus =
  | "PENDING_AVAILABILITY" | "PENDING" | "UNSHIPPED" | "PARTIALLY_SHIPPED"
  | "SHIPPED" | "CANCELLED" | "UNFULFILLABLE";
export type AmazonOrderPackagesPrivateItem = {
  line_id: string;
  seller_sku: string | null;
  quantity_ordered: number;
  quantity_fulfilled: number | null;
  quantity_unfulfilled: number | null;
};
export type AmazonOrderPackagePrivate = {
  package_reference_id: string;
  carrier: string | null;
  tracking_number: string | null;
  ship_time: string | null;
  package_status: AmazonPackageStatus | null;
  items: Array<{ line_id: string; quantity: number }> | null;
};
export type AmazonOrderPackagesPrivateObservation = {
  ok: true;
  source: "amazon_spapi_order_packages_2026_01_01";
  identity_scope: "SELLER_ACCOUNT_PLUS_ORDER_ID";
  account_id: string;
  order_id: string;
  order_key: string;
  marketplace: AmazonOrderPackagesMarketplace;
  marketplace_id: string;
  created_at: string;
  last_updated_at: string;
  observed_at: string;
  fulfillment_owner: "MERCHANT" | null;
  fulfillment_status: AmazonOrderFulfillmentStatus | null;
  items: AmazonOrderPackagesPrivateItem[];
  /** null means unavailable; [] means a present, empty array. Neither proves
   * that it is safe or necessary to confirm any shipment. */
  packages: AmazonOrderPackagePrivate[] | null;
  read_only: true;
  provider_mutations: 0;
  buyer_recipient_datasets_requested: false;
  customer_fields_returned: false;
  private_tracking_transient_only: true;
  can_confirm_shipment: false;
  can_change_inventory: false;
  can_advance_checkpoint: false;
};
export type AmazonOrderPackagesDependencies = {
  getAccessToken?: typeof getAmazonAccessToken;
  fetch?: typeof fetch;
  clock?: () => number;
};

type Row = Record<string, unknown>;
const ORDER_RE = /^\d{3}-\d{7}-\d{7}$/;
const SELLER_RE = /^[A-Z0-9]{8,30}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_RESPONSE_BYTES = 4_000_000;
const MAX_ITEMS = 200;
const MAX_PACKAGES = 50;
const TIMEOUT_MS = 20_000;
const PACKAGE_STATUSES = new Set<string>([
  "PENDING", "IN_TRANSIT", "SHIPPED", "DELIVERED", "CANCELLED", "UNDELIVERABLE"
]);
const ORDER_STATUSES = new Set<string>([
  "PENDING_AVAILABILITY", "PENDING", "UNSHIPPED", "PARTIALLY_SHIPPED",
  "SHIPPED", "CANCELLED", "UNFULFILLABLE"
]);

class ReadFailure extends Error {
  constructor(readonly code: string) { super("amazon_order_packages_" + code); }
}
function fail(code: string): never { throw new ReadFailure(code); }
function object(value: unknown): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid_response");
  return value as Row;
}
function optionalObject(value: unknown): Row | null {
  return value === null || value === undefined ? null : object(value);
}
function opaque(value: unknown, max: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || CONTROL_RE.test(value)) fail(code);
  return value;
}
function optionalText(value: unknown, max: number, code: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > max || CONTROL_RE.test(value)) fail(code);
  return value.trim() ? value : null; // Do not normalize a nonempty tracking number.
}
function optionalSku(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 200 || CONTROL_RE.test(value)) fail("invalid_sku");
  return value; // SKU bytes are opaque, including whitespace and case.
}
function quantity(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("invalid_quantity");
  return value;
}
function optionalQuantity(value: unknown): number | null {
  return value === null || value === undefined ? null : quantity(value);
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !ISO_RE.test(value) || !Number.isFinite(Date.parse(value))) fail("invalid_time");
  return value;
}
function optionalTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : timestamp(value);
}
function now(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) fail("invalid_clock");
  return value;
}
function addQuantity(sum: number, value: number): number {
  const combined = sum + value;
  if (!Number.isSafeInteger(combined)) fail("quantity_overflow");
  return combined;
}

/** Bound actual streamed bytes, including responses without Content-Length.
 * Error bodies are never read. Cancellation/decoder failures are sanitized. */
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    fail("response_too_large");
  }
  if (!response.body) fail("invalid_json");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0, text = "";
  try {
    while (true) {
      if (signal.aborted) fail("transport_timeout");
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new ReadFailure("transport_timeout"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await Promise.race([reader.read(), aborted]); }
      finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) fail("response_read_failed");
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) fail("response_too_large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof ReadFailure) throw error;
    if (signal.aborted) fail("transport_timeout");
    fail("response_read_failed");
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(text); } catch { fail("invalid_json"); }
}

function project(
  raw: unknown, input: AmazonOrderPackagesInput, sellerId: string, observedAt: string
): AmazonOrderPackagesPrivateObservation {
  const order = object(object(raw).order), sales = object(order.salesChannel);
  if (order.orderId !== input.amazon_order_id || sales.channelName !== "AMAZON" ||
      sales.marketplaceId !== AMAZON_EU_MARKETPLACES[input.marketplace]) fail("order_identity_conflict");
  const created = timestamp(order.createdTime), updated = timestamp(order.lastUpdatedTime);
  if (Date.parse(updated) < Date.parse(created)) fail("invalid_time");
  const fulfillment = optionalObject(order.fulfillment);
  const owner = fulfillment?.fulfilledBy ?? null;
  if (owner !== null && owner !== "MERCHANT") fail("not_merchant_fulfilled");
  const status = fulfillment?.fulfillmentStatus ?? null;
  if (status !== null && (typeof status !== "string" || !ORDER_STATUSES.has(status))) fail("invalid_fulfillment_status");
  if (!Array.isArray(order.orderItems) || order.orderItems.length > MAX_ITEMS) fail("invalid_order_items");
  const uniqueLines = new Set<string>();
  let totalOrdered = 0;
  const items = order.orderItems.map(rawItem => {
    const item = object(rawItem), product = object(item.product);
    const lineId = opaque(item.orderItemId, 128, "invalid_line_id");
    if (uniqueLines.has(lineId)) fail("duplicate_line_id");
    uniqueLines.add(lineId);
    const ordered = quantity(item.quantityOrdered), itemFulfillment = optionalObject(item.fulfillment);
    totalOrdered = addQuantity(totalOrdered, ordered);
    return {
      line_id: lineId, seller_sku: optionalSku(product.sellerSku), quantity_ordered: ordered,
      quantity_fulfilled: optionalQuantity(itemFulfillment?.quantityFulfilled),
      quantity_unfulfilled: optionalQuantity(itemFulfillment?.quantityUnfulfilled)
    };
  });
  let packages: AmazonOrderPackagePrivate[] | null = null;
  if (order.packages !== undefined && order.packages !== null) {
    if (!Array.isArray(order.packages) || order.packages.length > MAX_PACKAGES) fail("invalid_packages");
    const uniquePackages = new Set<string>();
    let totalPackageUnits = 0;
    packages = order.packages.map(rawPackage => {
      const pack = object(rawPackage);
      const reference = opaque(pack.packageReferenceId, 128, "invalid_package_reference");
      if (uniquePackages.has(reference)) fail("duplicate_package_reference");
      uniquePackages.add(reference);
      const packageStatus = optionalObject(pack.packageStatus);
      const primaryStatus = packageStatus?.status ?? null;
      if (packageStatus !== null && (typeof primaryStatus !== "string" || !PACKAGE_STATUSES.has(primaryStatus)))
        fail("invalid_package_status");
      let packageItems: Array<{ line_id: string; quantity: number }> | null = null;
      if (pack.packageItems !== undefined && pack.packageItems !== null) {
        if (!Array.isArray(pack.packageItems) || pack.packageItems.length > MAX_ITEMS) fail("invalid_package_items");
        const uniquePackageLines = new Set<string>();
        packageItems = pack.packageItems.map(rawLine => {
          const line = object(rawLine), lineId = opaque(line.orderItemId, 128, "invalid_package_line_id");
          if (!uniqueLines.has(lineId)) fail("package_line_identity_conflict");
          if (uniquePackageLines.has(lineId)) fail("duplicate_package_line_id");
          uniquePackageLines.add(lineId);
          const value = quantity(line.quantity);
          totalPackageUnits = addQuantity(totalPackageUnits, value);
          return { line_id: lineId, quantity: value };
        });
      }
      return {
        package_reference_id: reference,
        carrier: optionalText(pack.carrier, 90, "invalid_carrier"),
        tracking_number: optionalText(pack.trackingNumber, 256, "invalid_tracking_number"),
        ship_time: optionalTimestamp(pack.shipTime),
        package_status: primaryStatus as AmazonPackageStatus | null,
        items: packageItems
      };
    });
  }
  return {
    ok: true, source: "amazon_spapi_order_packages_2026_01_01",
    identity_scope: "SELLER_ACCOUNT_PLUS_ORDER_ID", account_id: sellerId,
    order_id: input.amazon_order_id, order_key: "amazon:" + sellerId + ":" + input.amazon_order_id,
    marketplace: input.marketplace, marketplace_id: AMAZON_EU_MARKETPLACES[input.marketplace],
    created_at: created, last_updated_at: updated, observed_at: observedAt,
    fulfillment_owner: owner, fulfillment_status: status as AmazonOrderFulfillmentStatus | null,
    items, packages, read_only: true, provider_mutations: 0,
    buyer_recipient_datasets_requested: false, customer_fields_returned: false,
    private_tracking_transient_only: true, can_confirm_shipment: false,
    can_change_inventory: false, can_advance_checkpoint: false
  };
}

/** Internal reader; the calling reconciliation service must discard private
 * tracking after comparing it and return aggregate evidence only. A 200 or
 * SHIPPED state is not proof of matching package contents, tracking or carrier.
 * Unknown/omitted datasets and zero quantities remain evidence for review.
 */
export async function readAmazonOrderPackagesPrivate(
  input: unknown, env: AmazonOrderPackagesEnv, dependencies: AmazonOrderPackagesDependencies = {}
): Promise<AmazonOrderPackagesPrivateObservation> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) fail("invalid_request");
    const row = input as Row, keys = Reflect.ownKeys(row);
    if (keys.length !== 2 || keys.some(key => key !== "amazon_order_id" && key !== "marketplace") ||
        typeof row.amazon_order_id !== "string" || !ORDER_RE.test(row.amazon_order_id) ||
        typeof row.marketplace !== "string" || !Object.hasOwn(AMAZON_EU_MARKETPLACES, row.marketplace))
      fail("invalid_request");
    const request: AmazonOrderPackagesInput = {
      amazon_order_id: row.amazon_order_id, marketplace: row.marketplace as AmazonOrderPackagesMarketplace
    };
    const seller = env.AMAZON_SP_API_SELLER_ID;
    if (typeof seller !== "string" || !SELLER_RE.test(seller)) fail("seller_not_configured");
    const clock = dependencies.clock ?? Date.now;
    const started = now(clock);
    let token: string;
    try { token = await (dependencies.getAccessToken ?? getAmazonAccessToken)(env); }
    catch { fail("auth_failed"); }
    if (typeof token !== "string" || !token || token.length > 16384 || CONTROL_RE.test(token)) fail("auth_failed");
    const url = new URL("https://sellingpartnerapi-eu.amazon.com/orders/2026-01-01/orders/" + request.amazon_order_id);
    url.searchParams.set("includedData", "FULFILLMENT,PACKAGES");
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let response: Response;
    try {
      response = await (dependencies.fetch ?? fetch)(url.toString(), {
        method: "GET", headers: { "x-amz-access-token": token, Accept: "application/json" },
        redirect: "manual", signal
      });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")))
        fail("transport_timeout");
      fail("transport_failed");
    }
    if (!(response instanceof Response)) fail("invalid_response");
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      fail("http_" + response.status);
    }
    const raw = await boundedJson(response, signal);
    const observed = now(clock);
    if (observed < started) fail("invalid_clock");
    return project(raw, request, seller, new Date(observed).toISOString());
  } catch (error) {
    if (error instanceof ReadFailure) throw new Error(error.message);
    throw new Error("amazon_order_packages_read_failed");
  }
}
