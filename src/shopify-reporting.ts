import { shopifyGraphQL } from "./index";

const SCHEMA_VERSION = 1;
const MAX_SYNC_DAYS = 31;
const ORDER_PAGE_SIZE = 100;
const LINE_ITEM_PAGE_SIZE = 100;
const COST_BATCH_SIZE = 100;

export type ShopifyReportingEnv = {
  SHOPIFY_SHOP_DOMAIN?: string;
  SHOPIFY_API_VERSION?: string;
  SHOPIFY_REPORT_ACCESS_TOKEN?: string;
  COMMERCE_TENANT_ID?: string;
};

type JsonObject = Record<string, unknown>;
type Money = { amount?: string; currencyCode?: string };
type MoneyBag = { shopMoney?: Money };
type PageInfo = { hasNextPage?: boolean; endCursor?: string | null };

type LineItem = {
  id: string;
  title?: string;
  vendor?: string | null;
  sku?: string | null;
  quantity?: number;
  currentQuantity?: number;
  discountedUnitPriceAfterAllDiscountsSet?: MoneyBag;
  product?: { id: string; title?: string; handle?: string; vendor?: string; productType?: string } | null;
  variant?: { id: string; title?: string; sku?: string | null } | null;
};

type OrderNode = {
  id: string;
  processedAt: string;
  updatedAt?: string;
  cancelledAt?: string | null;
  test?: boolean;
  sourceName?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  currencyCode?: string;
  currentSubtotalPriceSet?: MoneyBag;
  currentShippingPriceSet?: MoneyBag;
  currentTotalDiscountsSet?: MoneyBag;
  currentTotalTaxSet?: MoneyBag;
  currentTotalPriceSet?: MoneyBag;
  totalRefundedSet?: MoneyBag;
  lineItems: { nodes: LineItem[]; pageInfo: PageInfo };
};

type OrdersData = { orders: { nodes: OrderNode[]; pageInfo: PageInfo } };
type ScopeData = { currentAppInstallation: { accessScopes: Array<{ handle: string }> } };
type CostData = {
  nodes: Array<{
    id?: string;
    inventoryQuantity?: number | null;
    inventoryItem?: { id?: string; unitCost?: Money | null } | null;
  } | null>;
};
type BulkStartData = {
  bulkOperationRunQuery: {
    bulkOperation?: { id: string; status: string; createdAt?: string } | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
};
type BulkStatusData = {
  bulkOperation?: {
    id: string;
    status: string;
    errorCode?: string | null;
    objectCount?: string;
    rootObjectCount?: string;
    fileSize?: string | null;
    url?: string | null;
    partialDataUrl?: string | null;
    createdAt?: string;
    completedAt?: string | null;
  } | null;
};

type Window = {
  key: string;
  startDate: string;
  endDate: string;
  startIso: string;
  endExclusiveIso: string;
  days: number;
};

type VariantCost = {
  unitCost: number | null;
  currencyCode: string | null;
  inventoryQuantity: number | null;
};

type VendorAccumulator = {
  vendor: string;
  currentUnits: number;
  costedUnits: number;
  revenueProxy: number;
  cogs: number;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function normalizeSecret(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function timingSafeEqualText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

function isAuthorized(request: Request, env: ShopifyReportingEnv): boolean {
  const expected = normalizeSecret(env.SHOPIFY_REPORT_ACCESS_TOKEN);
  const header = request.headers.get("Authorization") || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return Boolean(expected) && timingSafeEqualText(supplied, expected);
}

function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : parsed;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function lastSunday(year: number, monthIndex: number): number {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0));
  return lastDay.getUTCDate() - lastDay.getUTCDay();
}

// The report boundaries are local midnight. On DST switch Sundays, midnight is still
// CET in March and still CEST in October; the offset changes later in the morning.
function romeMidnightOffset(date: string): string {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "+00:00";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const marchSwitch = lastSunday(year, 2);
  const octoberSwitch = lastSunday(year, 9);
  const isDst = month > 3 && month < 10
    || (month === 3 && day > marchSwitch)
    || (month === 10 && day <= octoberSwitch);
  return isDst ? "+02:00" : "+01:00";
}

function romeMidnight(date: string): string {
  return `${date}T00:00:00${romeMidnightOffset(date)}`;
}

function todayInRome(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseWindow(url: URL, maxDays = MAX_SYNC_DAYS): Window | null {
  const today = parseDate(todayInRome());
  if (!today) return null;
  const yesterday = addDays(today, -1);
  const timeframe = (url.searchParams.get("timeframe") || "yesterday").trim();
  let start: Date;
  let end: Date;
  let key = timeframe;

  if (timeframe === "yesterday") {
    start = yesterday;
    end = yesterday;
  } else if (timeframe === "last_7_days") {
    start = addDays(yesterday, -6);
    end = yesterday;
  } else if (timeframe === "last_14_days") {
    start = addDays(yesterday, -13);
    end = yesterday;
  } else if (timeframe === "month_to_yesterday") {
    start = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), 1));
    end = yesterday;
  } else if (timeframe === "custom") {
    const parsedStart = parseDate((url.searchParams.get("start") || "").trim());
    const parsedEnd = parseDate((url.searchParams.get("end") || "").trim());
    if (!parsedStart || !parsedEnd || parsedStart > parsedEnd) return null;
    start = parsedStart;
    end = parsedEnd;
    key = "custom";
  } else {
    return null;
  }

  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days < 1 || days > maxDays) return null;
  const startDate = isoDate(start);
  const endDate = isoDate(end);
  const nextDate = isoDate(addDays(end, 1));
  return {
    key,
    startDate,
    endDate,
    startIso: romeMidnight(startDate),
    endExclusiveIso: romeMidnight(nextDate),
    days,
  };
}

function amount(bag?: MoneyBag): number {
  const value = Number.parseFloat(bag?.shopMoney?.amount || "0");
  return Number.isFinite(value) ? value : 0;
}

function currency(bag?: MoneyBag): string | null {
  return bag?.shopMoney?.currencyCode || null;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function orderKey(orderId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(orderId));
  return Array.from(new Uint8Array(digest)).slice(0, 10).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function grantedScopes(env: ShopifyReportingEnv): Promise<string[]> {
  const data: ScopeData = await shopifyGraphQL<ScopeData>(env, `
    query ShopifyReportingAccessScopes {
      currentAppInstallation { accessScopes { handle } }
    }
  `);
  return data.currentAppInstallation.accessScopes.map((scope) => scope.handle).sort();
}

function orderQuery(window: Window): string {
  return `processed_at:>=${window.startIso} processed_at:<${window.endExclusiveIso}`;
}

async function fetchOrders(env: ShopifyReportingEnv, window: Window): Promise<{ orders: OrderNode[]; warnings: string[] }> {
  const orders: OrderNode[] = [];
  const warnings: string[] = [];
  let after: string | null = null;
  let pages = 0;

  do {
    const data: OrdersData = await shopifyGraphQL<OrdersData>(env, `
      query ShopifyAdvOrders($first: Int!, $after: String, $query: String!) {
        orders(first: $first, after: $after, query: $query, sortKey: PROCESSED_AT) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id processedAt updatedAt cancelledAt test sourceName
            displayFinancialStatus displayFulfillmentStatus currencyCode
            currentSubtotalPriceSet { shopMoney { amount currencyCode } }
            currentShippingPriceSet { shopMoney { amount currencyCode } }
            currentTotalDiscountsSet { shopMoney { amount currencyCode } }
            currentTotalTaxSet { shopMoney { amount currencyCode } }
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            totalRefundedSet { shopMoney { amount currencyCode } }
            lineItems(first: ${LINE_ITEM_PAGE_SIZE}) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id title vendor sku quantity currentQuantity
                discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount currencyCode } }
                product { id title handle vendor productType }
                variant { id title sku }
              }
            }
          }
        }
      }
    `, { first: ORDER_PAGE_SIZE, after, query: orderQuery(window) });

    for (const order of data.orders.nodes) {
      orders.push(order);
      if (order.lineItems.pageInfo.hasNextPage) warnings.push(`line_items_truncated:${await orderKey(order.id)}`);
    }
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor || null : null;
    pages += 1;
    if (pages >= 50 && after) throw new Error("shopify_reporting_order_page_limit_reached");
  } while (after);

  return { orders, warnings };
}

function chunks<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

async function fetchCosts(env: ShopifyReportingEnv, variantIds: string[]): Promise<{ costs: Map<string, VariantCost>; warning?: string }> {
  const costs = new Map<string, VariantCost>();
  const uniqueIds = [...new Set(variantIds.filter(Boolean))];
  if (!uniqueIds.length) return { costs };

  try {
    for (const ids of chunks(uniqueIds, COST_BATCH_SIZE)) {
      const data: CostData = await shopifyGraphQL<CostData>(env, `
        query ShopifyAdvVariantCosts($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id inventoryQuantity
              inventoryItem { id unitCost { amount currencyCode } }
            }
          }
        }
      `, { ids });
      for (const node of data.nodes) {
        if (!node?.id) continue;
        const rawCost = Number.parseFloat(node.inventoryItem?.unitCost?.amount || "");
        costs.set(node.id, {
          unitCost: Number.isFinite(rawCost) ? rawCost : null,
          currencyCode: node.inventoryItem?.unitCost?.currencyCode || null,
          inventoryQuantity: typeof node.inventoryQuantity === "number" ? node.inventoryQuantity : null,
        });
      }
    }
    return { costs };
  } catch (error) {
    console.warn("shopify_reporting_cost_lookup_unavailable", { reason: safeErrorCode(error) });
    return { costs, warning: "unit_cost_unavailable_or_permission_missing" };
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) || 0) + 1);
}

async function buildReport(env: ShopifyReportingEnv, window: Window, scopes: string[]): Promise<JsonObject> {
  const { orders, warnings } = await fetchOrders(env, window);
  const variantIds = orders.flatMap((order) => order.lineItems.nodes.map((item) => item.variant?.id || "")).filter(Boolean);
  const costResult = await fetchCosts(env, variantIds);
  if (costResult.warning) warnings.push(costResult.warning);

  const sources = new Map<string, number>();
  const financialStatuses = new Map<string, number>();
  const fulfillmentStatuses = new Map<string, number>();
  const vendors = new Map<string, VendorAccumulator>();

  let validOrders = 0;
  let cancelledOrders = 0;
  let testOrders = 0;
  let total = 0;
  let shipping = 0;
  let tax = 0;
  let discounts = 0;
  let refunded = 0;
  let merchandiseRevenue = 0;
  let cogs = 0;
  let currentUnits = 0;
  let costedUnits = 0;
  const normalizedOrders: JsonObject[] = [];

  for (const order of orders) {
    const isTest = order.test === true;
    const isCancelled = Boolean(order.cancelledAt);
    if (isTest) testOrders += 1;
    if (isCancelled) cancelledOrders += 1;
    if (!isTest && !isCancelled) validOrders += 1;

    const source = (order.sourceName || "unknown").trim() || "unknown";
    const financial = order.displayFinancialStatus || "UNKNOWN";
    const fulfillment = order.displayFulfillmentStatus || "UNKNOWN";
    bump(sources, source);
    bump(financialStatuses, financial);
    bump(fulfillmentStatuses, fulfillment);

    const orderTotal = amount(order.currentTotalPriceSet);
    const orderShipping = amount(order.currentShippingPriceSet);
    const orderTax = amount(order.currentTotalTaxSet);
    const orderDiscount = amount(order.currentTotalDiscountsSet);
    const orderRefunded = amount(order.totalRefundedSet);
    const orderMerchandise = Math.max(0, orderTotal - orderShipping - orderTax);

    if (!isTest && !isCancelled) {
      total += orderTotal;
      shipping += orderShipping;
      tax += orderTax;
      discounts += orderDiscount;
      refunded += orderRefunded;
      merchandiseRevenue += orderMerchandise;
    }

    let orderCogs = 0;
    let orderUnits = 0;
    let orderCostedUnits = 0;
    const lineItems: JsonObject[] = [];

    for (const item of order.lineItems.nodes) {
      const orderedQuantity = Math.max(0, item.quantity || 0);
      const currentQuantity = Math.max(0, item.currentQuantity || 0);
      const unitRevenue = amount(item.discountedUnitPriceAfterAllDiscountsSet);
      const revenueProxy = unitRevenue * currentQuantity;
      const variantId = item.variant?.id || null;
      const cost = variantId ? costResult.costs.get(variantId) : undefined;
      const lineCogs = cost?.unitCost != null ? cost.unitCost * currentQuantity : null;
      const vendor = (item.product?.vendor || item.vendor || "Unknown").trim() || "Unknown";

      orderUnits += currentQuantity;
      if (lineCogs != null) {
        orderCogs += lineCogs;
        orderCostedUnits += currentQuantity;
      }

      if (!isTest && !isCancelled) {
        const vendorRow = vendors.get(vendor) || { vendor, currentUnits: 0, costedUnits: 0, revenueProxy: 0, cogs: 0 };
        vendorRow.currentUnits += currentQuantity;
        vendorRow.revenueProxy += revenueProxy;
        if (lineCogs != null) {
          vendorRow.costedUnits += currentQuantity;
          vendorRow.cogs += lineCogs;
        }
        vendors.set(vendor, vendorRow);
      }

      lineItems.push({
        product_id: item.product?.id || null,
        variant_id: variantId,
        sku: item.variant?.sku || item.sku || null,
        product_title: item.product?.title || item.title || null,
        variant_title: item.variant?.title || null,
        handle: item.product?.handle || null,
        vendor,
        product_type: item.product?.productType || null,
        ordered_quantity: orderedQuantity,
        current_quantity: currentQuantity,
        discounted_unit_price_after_all_discounts: roundMoney(unitRevenue),
        current_line_revenue_proxy: roundMoney(revenueProxy),
        current_unit_cost: cost?.unitCost ?? null,
        current_inventory_quantity: cost?.inventoryQuantity ?? null,
        current_line_cogs: lineCogs == null ? null : roundMoney(lineCogs),
      });
    }

    if (!isTest && !isCancelled) {
      cogs += orderCogs;
      currentUnits += orderUnits;
      costedUnits += orderCostedUnits;
    }

    normalizedOrders.push({
      order_key: await orderKey(order.id),
      processed_at: order.processedAt,
      updated_at: order.updatedAt || null,
      source,
      financial_status: financial,
      fulfillment_status: fulfillment,
      is_test: isTest,
      is_cancelled: isCancelled,
      currency: currency(order.currentTotalPriceSet) || order.currencyCode || null,
      current_subtotal: roundMoney(amount(order.currentSubtotalPriceSet)),
      current_shipping: roundMoney(orderShipping),
      current_discounts: roundMoney(orderDiscount),
      current_tax: roundMoney(orderTax),
      current_total: roundMoney(orderTotal),
      total_refunded: roundMoney(orderRefunded),
      net_merchandise_revenue: roundMoney(orderMerchandise),
      current_cogs: roundMoney(orderCogs),
      current_units: orderUnits,
      costed_units: orderCostedUnits,
      line_items: lineItems,
    });
  }

  const costCoverage = currentUnits ? costedUnits / currentUnits : 0;
  const vendorBreakdown = [...vendors.values()].map((row) => ({
    vendor: row.vendor,
    current_units: row.currentUnits,
    costed_units: row.costedUnits,
    revenue_proxy: roundMoney(row.revenueProxy),
    cogs_current_unit_cost: roundMoney(row.cogs),
    contribution_proxy: roundMoney(row.revenueProxy - row.cogs),
    cost_coverage: row.currentUnits ? Math.round((row.costedUnits / row.currentUnits) * 10_000) / 10_000 : 0,
  })).sort((left, right) => right.revenue_proxy - left.revenue_proxy);

  return {
    ok: true,
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    source: "shopify_admin_graphql",
    tenant: normalizeSecret(env.COMMERCE_TENANT_ID) || null,
    data_policy: "commerce_reporting_no_customer_pii",
    timeframe: {
      key: window.key,
      start: window.startDate,
      end: window.endDate,
      timezone: "Europe/Rome",
      processed_at_start: window.startIso,
      processed_at_end_exclusive: window.endExclusiveIso,
    },
    access: {
      scopes,
      read_orders: scopes.includes("read_orders"),
      read_all_orders: scopes.includes("read_all_orders"),
      read_products: scopes.includes("read_products"),
      read_inventory: scopes.includes("read_inventory"),
    },
    methodology: {
      order_date_basis: "processedAt",
      net_merchandise_revenue_formula: "current_total - current_shipping - current_tax",
      line_revenue_basis: "discountedUnitPriceAfterAllDiscountsSet * currentQuantity (proxy)",
      cogs_basis: "current InventoryItem.unitCost * currentQuantity; not historical cost at sale time",
      excluded_from_kpis: "test orders and cancelled orders",
    },
    metrics: {
      orders_returned: orders.length,
      valid_orders: validOrders,
      cancelled_orders: cancelledOrders,
      test_orders: testOrders,
      current_total: roundMoney(total),
      current_shipping: roundMoney(shipping),
      current_tax: roundMoney(tax),
      current_discounts: roundMoney(discounts),
      total_refunded: roundMoney(refunded),
      net_merchandise_revenue: roundMoney(merchandiseRevenue),
      cogs_current_unit_cost: roundMoney(cogs),
      contribution_margin_proxy_before_adv_and_fulfillment: roundMoney(merchandiseRevenue - cogs),
      current_units: currentUnits,
      costed_units: costedUnits,
      cost_coverage: Math.round(costCoverage * 10_000) / 10_000,
    },
    breakdowns: {
      source: Object.fromEntries([...sources.entries()].sort(([a], [b]) => a.localeCompare(b))),
      financial_status: Object.fromEntries([...financialStatuses.entries()].sort(([a], [b]) => a.localeCompare(b))),
      fulfillment_status: Object.fromEntries([...fulfillmentStatuses.entries()].sort(([a], [b]) => a.localeCompare(b))),
      vendor: vendorBreakdown,
    },
    warnings: [...new Set(warnings)],
    orders: normalizedOrders,
  };
}

function bulkOrdersQuery(window: Window): string {
  const filter = orderQuery(window).replace(/"/g, "\\\"");
  return `{
    orders(query: "${filter}", sortKey: PROCESSED_AT) {
      edges { node {
        id processedAt updatedAt cancelledAt test sourceName
        displayFinancialStatus displayFulfillmentStatus currencyCode
        currentSubtotalPriceSet { shopMoney { amount currencyCode } }
        currentShippingPriceSet { shopMoney { amount currencyCode } }
        currentTotalDiscountsSet { shopMoney { amount currencyCode } }
        currentTotalTaxSet { shopMoney { amount currencyCode } }
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        totalRefundedSet { shopMoney { amount currencyCode } }
        lineItems { edges { node {
          id title vendor sku quantity currentQuantity
          discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount currencyCode } }
          product { id title handle vendor productType }
          variant { id title sku }
        } } }
      } }
    }
  }`;
}

function bulkCatalogQuery(): string {
  return `{
    products {
      edges { node {
        id title handle vendor productType status createdAt updatedAt totalInventory
        variants { edges { node {
          id title sku price compareAtPrice inventoryQuantity availableForSale
          inventoryItem { id sku tracked unitCost { amount currencyCode } }
        } } }
      } }
    }
  }`;
}

async function startBulk(env: ShopifyReportingEnv, dataset: "orders" | "catalog", window?: Window): Promise<Response> {
  const query = dataset === "orders" ? bulkOrdersQuery(window!) : bulkCatalogQuery();
  const data: BulkStartData = await shopifyGraphQL<BulkStartData>(env, `
    mutation ShopifyAdvBulkExport($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id status createdAt }
        userErrors { field message }
      }
    }
  `, { query });
  const result = data.bulkOperationRunQuery;
  if (!result.bulkOperation || result.userErrors.length) {
    return jsonResponse({ ok: false, error: "bulk_operation_rejected", user_errors: result.userErrors }, 409);
  }
  return jsonResponse({
    ok: true,
    schema_version: SCHEMA_VERSION,
    dataset,
    data_policy: "commerce_reporting_no_customer_pii",
    timeframe: window ? { start: window.startDate, end: window.endDate, timezone: "Europe/Rome" } : null,
    bulk_operation: result.bulkOperation,
  }, 202);
}

async function bulkStatus(env: ShopifyReportingEnv, id: string): Promise<Response> {
  const data: BulkStatusData = await shopifyGraphQL<BulkStatusData>(env, `
    query ShopifyAdvBulkStatus($id: ID!) {
      bulkOperation(id: $id) {
        id status errorCode objectCount rootObjectCount fileSize url partialDataUrl createdAt completedAt
      }
    }
  `, { id });
  if (!data.bulkOperation) return jsonResponse({ ok: false, error: "bulk_operation_not_found" }, 404);
  return jsonResponse({
    ok: true,
    schema_version: SCHEMA_VERSION,
    data_policy: "commerce_reporting_no_customer_pii",
    bulk_operation: data.bulkOperation,
  });
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/access denied|forbidden|shopify_lookup_forbidden/i.test(message)) return "access_denied";
  if (/unauthorized|401|shopify_lookup_unauthorized/i.test(message)) return "unauthorized";
  if (/429|rate.?limit/i.test(message)) return "rate_limited";
  if (/timeout|abort/i.test(message)) return "timeout";
  if (/graphql|query|validation/i.test(message)) return "graphql_error";
  if (/token|auth/i.test(message)) return "auth_unavailable";
  return "upstream_unavailable";
}

function requiresReadAllOrders(window: Window): boolean {
  const today = parseDate(todayInRome());
  const start = parseDate(window.startDate);
  return Boolean(today && start && start < addDays(today, -60));
}

async function protectedRoute(request: Request, env: ShopifyReportingEnv, url: URL): Promise<Response> {
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

  try {
    if (url.pathname === "/internal/shopify/scopes") {
      if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
      const scopes = await grantedScopes(env);
      return jsonResponse({
        ok: true,
        service: "shopify_adv_reporting",
        scopes,
        requirements: {
          recent_orders: scopes.includes("read_orders"),
          historical_orders_over_60_days: scopes.includes("read_orders") && scopes.includes("read_all_orders"),
          products: scopes.includes("read_products"),
          inventory: scopes.includes("read_inventory") || scopes.includes("read_products"),
        },
      });
    }

    if (url.pathname === "/internal/shopify/report") {
      if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
      const window = parseWindow(url);
      if (!window) return jsonResponse({ ok: false, error: "invalid_timeframe", hint: `Maximum synchronous range is ${MAX_SYNC_DAYS} days.` }, 400);
      const scopes = await grantedScopes(env);
      if (requiresReadAllOrders(window) && !scopes.includes("read_all_orders")) {
        return jsonResponse({ ok: false, error: "read_all_orders_required", requested_start: window.startDate, granted_scopes: scopes }, 403);
      }
      return jsonResponse(await buildReport(env, window, scopes));
    }

    if (url.pathname === "/internal/shopify/bulk/start") {
      if (request.method !== "POST") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
      const dataset = (url.searchParams.get("dataset") || "orders").trim();
      if (dataset === "catalog") return startBulk(env, "catalog");
      if (dataset !== "orders") return jsonResponse({ ok: false, error: "invalid_dataset" }, 400);
      const tempUrl = new URL(url.toString());
      tempUrl.searchParams.set("timeframe", "custom");
      const window = parseWindow(tempUrl, 400);
      if (!window) return jsonResponse({ ok: false, error: "invalid_timeframe", hint: "Orders bulk export requires start/end YYYY-MM-DD, max 400 days." }, 400);
      const scopes = await grantedScopes(env);
      if (requiresReadAllOrders(window) && !scopes.includes("read_all_orders")) return jsonResponse({ ok: false, error: "read_all_orders_required", granted_scopes: scopes }, 403);
      return startBulk(env, "orders", window);
    }

    if (url.pathname === "/internal/shopify/bulk/status") {
      if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
      const id = (url.searchParams.get("id") || "").trim();
      if (!/^gid:\/\/shopify\/BulkOperation\/\d+$/.test(id)) return jsonResponse({ ok: false, error: "invalid_bulk_operation_id" }, 400);
      return bulkStatus(env, id);
    }

    return jsonResponse({ ok: false, error: "not_found" }, 404);
  } catch (error) {
    console.warn("shopify_adv_reporting_error", { path: url.pathname, category: safeErrorCode(error) });
    return jsonResponse({ ok: false, error: "shopify_reporting_unavailable", detail: safeErrorCode(error) }, 503);
  }
}

export async function handleShopifyReportingRequest(request: Request, env: ShopifyReportingEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/internal/shopify/")) return null;

  if (url.pathname === "/internal/shopify/health") {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    return jsonResponse({
      ok: true,
      service: "shopify_adv_reporting",
      schema_version: SCHEMA_VERSION,
      configured: {
        shop_domain: Boolean(normalizeSecret(env.SHOPIFY_SHOP_DOMAIN)),
        report_access_token: Boolean(normalizeSecret(env.SHOPIFY_REPORT_ACCESS_TOKEN)),
        api_version: normalizeSecret(env.SHOPIFY_API_VERSION) || null,
        tenant_id: Boolean(normalizeSecret(env.COMMERCE_TENANT_ID)),
      },
      capabilities: {
        pii_free_order_reporting: true,
        current_inventory_cost_join: true,
        bulk_order_backfill: true,
        bulk_catalog_export: true,
      },
    });
  }

  return protectedRoute(request, env, url);
}
