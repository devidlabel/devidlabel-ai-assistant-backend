import { shopifyGraphQL } from "./index";

const REPORT_SCHEMA_VERSION = 1;
const DEFAULT_MAX_REPORT_DAYS = 31;
const ORDER_PAGE_SIZE = 100;
const LINE_ITEM_PAGE_SIZE = 100;
const VARIANT_COST_BATCH_SIZE = 100;

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

type ShopifyLineItem = {
  id: string;
  title?: string;
  vendor?: string | null;
  sku?: string | null;
  quantity?: number;
  currentQuantity?: number;
  discountedUnitPriceAfterAllDiscountsSet?: MoneyBag;
  product?: {
    id: string;
    title?: string;
    handle?: string;
    vendor?: string;
    productType?: string;
  } | null;
  variant?: {
    id: string;
    title?: string;
    sku?: string | null;
  } | null;
};

type ShopifyOrder = {
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
  lineItems: {
    nodes: ShopifyLineItem[];
    pageInfo: PageInfo;
  };
};

type ShopifyOrdersData = {
  orders: {
    nodes: ShopifyOrder[];
    pageInfo: PageInfo;
  };
};

type VariantCost = {
  variantId: string;
  inventoryItemId: string | null;
  unitCost: number | null;
  currencyCode: string | null;
  inventoryQuantity: number | null;
};

type ShopifyVariantCostData = {
  nodes: Array<{
    id?: string;
    inventoryQuantity?: number | null;
    inventoryItem?: {
      id?: string;
      unitCost?: Money | null;
    } | null;
  } | null>;
};

type AccessScopeData = {
  currentAppInstallation: {
    accessScopes: Array<{ handle: string }>;
  };
};

type BulkOperationData = {
  bulkOperationRunQuery: {
    bulkOperation?: {
      id: string;
      status: string;
      createdAt?: string;
    } | null;
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

type ReportingWindow = {
  key: string;
  startDate: string;
  endDate: string;
  startIso: string;
  endExclusiveIso: string;
  days: number;
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
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function isAuthorized(request: Request, env: ShopifyReportingEnv): boolean {
  const expected = normalizeSecret(env.SHOPIFY_REPORT_ACCESS_TOKEN);
  if (!expected) return false;
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  return timingSafeEqualText(supplied, expected);
}

function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  return parsed;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function daysInclusive(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

function lastSunday(year: number, monthIndex: number): number {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0));
  return lastDay.getUTCDate() - lastDay.getUTCDay();
}

function romeOffsetForDate(date: string): string {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "+00:00";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const marchSwitch = lastSunday(year, 2);
  const octoberSwitch = lastSunday(year, 9);
  const isDst = month > 3 && month < 10
    || (month === 3 && day >= marchSwitch)
    || (month === 10 && day < octoberSwitch);
  return isDst ? "+02:00" : "+01:00";
}

function romeStartOfDay(date: string): string {
  return `${date}T00:00:00${romeOffsetForDate(date)}`;
}

function todayInRome(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function parseReportingWindow(url: URL, maxDays = DEFAULT_MAX_REPORT_DAYS): ReportingWindow | null {
  const today = parseDate(todayInRome());
  if (!today) return null;
  const yesterday = addDays(today, -1);
  const timeframe = (url.searchParams.get("timeframe") || "yesterday").trim();

  let key = timeframe;
  let start: Date;
  let end: Date;

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
    const rawStart = (url.searchParams.get("start") || "").trim();
    const rawEnd = (url.searchParams.get("end") || "").trim();
    const parsedStart = parseDate(rawStart);
    const parsedEnd = parseDate(rawEnd);
    if (!parsedStart || !parsedEnd || parsedStart > parsedEnd) return null;
    start = parsedStart;
    end = parsedEnd;
    key = "custom";
  } else {
    return null;
  }

  const days = daysInclusive(start, end);
  if (days < 1 || days > maxDays) return null;
  const startDate = isoDate(start);
  const endDate = isoDate(end);
  const nextDate = isoDate(addDays(end, 1));
  return {
    key,
    startDate,
    endDate,
    startIso: romeStartOfDay(startDate),
    endExclusiveIso: romeStartOfDay(nextDate),
    days,
  };
}

function moneyValue(bag?: MoneyBag): number {
  const amount = Number.parseFloat(bag?.shopMoney?.amount || "0");
  return Number.isFinite(amount) ? amount : 0;
}

function moneyCurrency(bag?: MoneyBag): string | null {
  return bag?.shopMoney?.currencyCode || null;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function shortHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).slice(0, 10).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function getGrantedScopes(env: ShopifyReportingEnv): Promise<string[]> {
  const data = await shopifyGraphQL<AccessScopeData>(env, `
    query ShopifyReportingAccessScopes {
      currentAppInstallation {
        accessScopes { handle }
      }
    }
  `);
  return data.currentAppInstallation.accessScopes.map((scope) => scope.handle).sort();
}

function orderSearchQuery(window: ReportingWindow): string {
  return `processed_at:>=${window.startIso} processed_at:<${window.endExclusiveIso}`;
}

async function fetchOrders(env: ShopifyReportingEnv, window: ReportingWindow): Promise<{ orders: ShopifyOrder[]; warnings: string[] }> {
  const orders: ShopifyOrder[] = [];
  const warnings: string[] = [];
  let after: string | null = null;
  let page = 0;

  do {
    const data = await shopifyGraphQL<ShopifyOrdersData>(env, `
      query ShopifyAdvOrders($first: Int!, $after: String, $query: String!) {
        orders(first: $first, after: $after, query: $query, sortKey: PROCESSED_AT) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            processedAt
            updatedAt
            cancelledAt
            test
            sourceName
            displayFinancialStatus
            displayFulfillmentStatus
            currencyCode
            currentSubtotalPriceSet { shopMoney { amount currencyCode } }
            currentShippingPriceSet { shopMoney { amount currencyCode } }
            currentTotalDiscountsSet { shopMoney { amount currencyCode } }
            currentTotalTaxSet { shopMoney { amount currencyCode } }
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            totalRefundedSet { shopMoney { amount currencyCode } }
            lineItems(first: ${LINE_ITEM_PAGE_SIZE}) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                title
                vendor
                sku
                quantity
                currentQuantity
                discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount currencyCode } }
                product { id title handle vendor productType }
                variant { id title sku }
              }
            }
          }
        }
      }
    `, {
      first: ORDER_PAGE_SIZE,
      after,
      query: orderSearchQuery(window),
    });

    for (const order of data.orders.nodes) {
      orders.push(order);
      if (order.lineItems.pageInfo.hasNextPage) warnings.push(`line_items_truncated:${await shortHash(order.id)}`);
    }
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor || null : null;
    page += 1;
    if (page >= 50 && after) throw new Error("shopify_reporting_order_page_limit_reached");
  } while (after);

  return { orders, warnings };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function fetchVariantCosts(env: ShopifyReportingEnv, variantIds: string[]): Promise<{ costs: Map<string, VariantCost>; warning?: string }> {
  const costs = new Map<string, VariantCost>();
  const uniqueIds = [...new Set(variantIds.filter(Boolean))];
  if (!uniqueIds.length) return { costs };

  try {
    for (const ids of chunk(uniqueIds, VARIANT_COST_BATCH_SIZE)) {
      const data = await shopifyGraphQL<ShopifyVariantCostData>(env, `
        query ShopifyAdvVariantCosts($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              inventoryQuantity
              inventoryItem {
                id
                unitCost { amount currencyCode }
              }
            }
          }
        }
      `, { ids });

      for (const node of data.nodes) {
        if (!node?.id) continue;
        const unitCostRaw = Number.parseFloat(node.inventoryItem?.unitCost?.amount || "");
        costs.set(node.id, {
          variantId: node.id,
          inventoryItemId: node.inventoryItem?.id || null,
          unitCost: Number.isFinite(unitCostRaw) ? unitCostRaw : null,
          currencyCode: node.inventoryItem?.unitCost?.currencyCode || null,
          inventoryQuantity: typeof node.inventoryQuantity === "number" ? node.inventoryQuantity : null,
        });
      }
    }
    return { costs };
  } catch (error) {
    console.warn("shopify_reporting_cost_lookup_unavailable", {
      reason: error instanceof Error ? error.message.slice(0, 120) : "unknown_error",
    });
    return { costs, warning: "unit_cost_unavailable_or_permission_missing" };
  }
}

type VendorAccumulator = {
  vendor: string;
  current_units: number;
  revenue_proxy: number;
  cogs_current_unit_cost: number;
  costed_units: number;
};

async function buildReport(env: ShopifyReportingEnv, window: ReportingWindow): Promise<JsonObject> {
  const scopes = await getGrantedScopes(env);
  const { orders, warnings } = await fetchOrders(env, window);
  const variantIds = orders.flatMap((order) => order.lineItems.nodes.map((item) => item.variant?.id || "")).filter(Boolean);
  const costResult = await fetchVariantCosts(env, variantIds);
  if (costResult.warning) warnings.push(costResult.warning);

  const sourceCounts = new Map<string, number>();
  const financialStatusCounts = new Map<string, number>();
  const fulfillmentStatusCounts = new Map<string, number>();
  const vendorSummary = new Map<string, VendorAccumulator>();

  let validOrderCount = 0;
  let cancelledOrderCount = 0;
  let testOrderCount = 0;
  let currentTotal = 0;
  let currentShipping = 0;
  let currentTax = 0;
  let currentDiscounts = 0;
  let totalRefunded = 0;
  let netMerchandiseRevenue = 0;
  let cogs = 0;
  let currentUnits = 0;
  let costedUnits = 0;

  const normalizedOrders: JsonObject[] = [];

  for (const order of orders) {
    const isTest = order.test === true;
    const isCancelled = Boolean(order.cancelledAt);
    if (isTest) testOrderCount += 1;
    if (isCancelled) cancelledOrderCount += 1;
    if (!isTest && !isCancelled) validOrderCount += 1;

    const source = (order.sourceName || "unknown").trim() || "unknown";
    const financial = order.displayFinancialStatus || "UNKNOWN";
    const fulfillment = order.displayFulfillmentStatus || "UNKNOWN";
    sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
    financialStatusCounts.set(financial, (financialStatusCounts.get(financial) || 0) + 1);
    fulfillmentStatusCounts.set(fulfillment, (fulfillmentStatusCounts.get(fulfillment) || 0) + 1);

    const orderTotal = moneyValue(order.currentTotalPriceSet);
    const orderShipping = moneyValue(order.currentShippingPriceSet);
    const orderTax = moneyValue(order.currentTotalTaxSet);
    const orderDiscounts = moneyValue(order.currentTotalDiscountsSet);
    const orderRefunded = moneyValue(order.totalRefundedSet);
    const orderNetMerchandise = Math.max(0, orderTotal - orderShipping - orderTax);

    if (!isTest && !isCancelled) {
      currentTotal += orderTotal;
      currentShipping += orderShipping;
      currentTax += orderTax;
      currentDiscounts += orderDiscounts;
      totalRefunded += orderRefunded;
      netMerchandiseRevenue += orderNetMerchandise;
    }

    let orderCogs = 0;
    let orderCurrentUnits = 0;
    let orderCostedUnits = 0;
    const lineItems: JsonObject[] = [];

    for (const item of order.lineItems.nodes) {
      const quantity = Math.max(0, item.quantity || 0);
      const itemCurrentQuantity = Math.max(0, item.currentQuantity || 0);
      const unitRevenue = moneyValue(item.discountedUnitPriceAfterAllDiscountsSet);
      const lineRevenueProxy = unitRevenue * itemCurrentQuantity;
      const variantId = item.variant?.id || null;
      const cost = variantId ? costResult.costs.get(variantId) : undefined;
      const lineCogs = cost?.unitCost != null ? cost.unitCost * itemCurrentQuantity : null;
      const vendor = (item.product?.vendor || item.vendor || "Unknown").trim() || "Unknown";

      orderCurrentUnits += itemCurrentQuantity;
      if (lineCogs != null) {
        orderCogs += lineCogs;
        orderCostedUnits += itemCurrentQuantity;
      }

      if (!isTest && !isCancelled) {
        const accumulator = vendorSummary.get(vendor) || {
          vendor,
          current_units: 0,
          revenue_proxy: 0,
          cogs_current_unit_cost: 0,
          costed_units: 0,
        };
        accumulator.current_units += itemCurrentQuantity;
        accumulator.revenue_proxy += lineRevenueProxy;
        if (lineCogs != null) {
          accumulator.cogs_current_unit_cost += lineCogs;
          accumulator.costed_units += itemCurrentQuantity;
        }
        vendorSummary.set(vendor, accumulator);
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
        ordered_quantity: quantity,
        current_quantity: itemCurrentQuantity,
        discounted_unit_price_after_all_discounts: roundMoney(unitRevenue),
        current_line_revenue_proxy: roundMoney(lineRevenueProxy),
        current_unit_cost: cost?.unitCost ?? null,
        current_inventory_quantity: cost?.inventoryQuantity ?? null,
        current_line_cogs: lineCogs == null ? null : roundMoney(lineCogs),
      });
    }

    if (!isTest && !isCancelled) {
      cogs += orderCogs;
      currentUnits += orderCurrentUnits;
      costedUnits += orderCostedUnits;
    }

    normalizedOrders.push({
      order_key: await shortHash(order.id),
      processed_at: order.processedAt,
      updated_at: order.updatedAt || null,
      source,
      financial_status: financial,
      fulfillment_status: fulfillment,
      is_test: isTest,
      is_cancelled: isCancelled,
      currency: moneyCurrency(order.currentTotalPriceSet) || order.currencyCode || null,
      current_subtotal: roundMoney(moneyValue(order.currentSubtotalPriceSet)),
      current_shipping: roundMoney(orderShipping),
      current_discounts: roundMoney(orderDiscounts),
      current_tax: roundMoney(orderTax),
      current_total: roundMoney(orderTotal),
      total_refunded: roundMoney(orderRefunded),
      net_merchandise_revenue: roundMoney(orderNetMerchandise),
      current_cogs: roundMoney(orderCogs),
      costed_units: orderCostedUnits,
      current_units: orderCurrentUnits,
      line_items: lineItems,
    });
  }

  const costCoverage = currentUnits > 0 ? costedUnits / currentUnits : 0;
  const contributionMarginProxy = netMerchandiseRevenue - cogs;

  return {
    ok: true,
    schema_version: REPORT_SCHEMA_VERSION,
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
      revenue_basis: "current order values after returns/refunds where Shopify exposes current fields",
      net_merchandise_revenue_formula: "current_total - current_shipping - current_tax",
      line_revenue_basis: "discountedUnitPriceAfterAllDiscountsSet * currentQuantity (proxy)",
      cogs_basis: "current InventoryItem.unitCost * currentQuantity; not historical unit cost at order time",
      excluded_from_kpis: "test orders and cancelled orders",
    },
    metrics: {
      orders_returned: orders.length,
      valid_orders: validOrderCount,
      cancelled_orders: cancelledOrderCount,
      test_orders: testOrderCount,
      current_total: roundMoney(currentTotal),
      current_shipping: roundMoney(currentShipping),
      current_tax: roundMoney(currentTax),
      current_discounts: roundMoney(currentDiscounts),
      total_refunded: roundMoney(totalRefunded),
      net_merchandise_revenue: roundMoney(netMerchandiseRevenue),
      cogs_current_unit_cost: roundMoney(cogs),
      contribution_margin_proxy_before_adv_and_fulfillment: roundMoney(contributionMarginProxy),
      current_units: currentUnits,
      costed_units: costedUnits,
      cost_coverage: Math.round(costCoverage * 10_000) / 10_000,
    },
    breakdowns: {
      source: Object.fromEntries([...sourceCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
      financial_status: Object.fromEntries([...financialStatusCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
      fulfillment_status: Object.fromEntries([...fulfillmentStatusCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
      vendor: [...vendorSummary.values()]
        .map((entry) => ({
          vendor: entry.vendor,
          current_units: entry.current_units,
          revenue_proxy: roundMoney(entry.revenue_proxy),
          cogs_current_unit_cost: roundMoney(entry.cogs_current_unit_cost),
          contribution_proxy: roundMoney(entry.revenue_proxy - entry.cogs_current_unit_cost),
          costed_units: entry.costed_units,
          cost_coverage: entry.current_units > 0 ? Math.round((entry.costed_units / entry.current_units) * 10_000) / 10_000 : 0,
        }))
        .sort((left, right) => right.revenue_proxy - left.revenue_proxy),
    },
    warnings: [...new Set(warnings)],
    orders: normalizedOrders,
  };
}

function bulkOrdersQuery(window: ReportingWindow): string {
  const query = orderSearchQuery(window).replace(/"/g, "\\\"");
  return `{
    orders(query: "${query}", sortKey: PROCESSED_AT) {
      edges {
        node {
          id
          processedAt
          updatedAt
          cancelledAt
          test
          sourceName
          displayFinancialStatus
          displayFulfillmentStatus
          currencyCode
          currentSubtotalPriceSet { shopMoney { amount currencyCode } }
          currentShippingPriceSet { shopMoney { amount currencyCode } }
          currentTotalDiscountsSet { shopMoney { amount currencyCode } }
          currentTotalTaxSet { shopMoney { amount currencyCode } }
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          totalRefundedSet { shopMoney { amount currencyCode } }
          lineItems {
            edges {
              node {
                id
                title
                vendor
                sku
                quantity
                currentQuantity
                discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount currencyCode } }
                product { id title handle vendor productType }
                variant { id title sku }
              }
            }
          }
        }
      }
    }
  }`;
}

function bulkCatalogQuery(): string {
  return `{
    products {
      edges {
        node {
          id
          title
          handle
          vendor
          productType
          status
          createdAt
          updatedAt
          totalInventory
          variants {
            edges {
              node {
                id
                title
                sku
                price
                compareAtPrice
                inventoryQuantity
                availableForSale
                inventoryItem {
                  id
                  sku
                  tracked
                  unitCost { amount currencyCode }
                }
              }
            }
          }
        }
      }
    }
  }`;
}

async function startBulkOperation(env: ShopifyReportingEnv, dataset: "orders" | "catalog", window?: ReportingWindow): Promise<Response> {
  if (dataset === "orders" && !window) return jsonResponse({ ok: false, error: "invalid_timeframe" }, 400);
  const query = dataset === "orders" ? bulkOrdersQuery(window!) : bulkCatalogQuery();
  const data = await shopifyGraphQL<BulkOperationData>(env, `
    mutation ShopifyAdvBulkExport($query: String!) {
      bulkOperationRunQuery(query: $query, groupObjects: false) {
        bulkOperation { id status createdAt }
        userErrors { field message }
      }
    }
  `, { query });
  const payload = data.bulkOperationRunQuery;
  if (payload.userErrors.length || !payload.bulkOperation) {
    return jsonResponse({
      ok: false,
      error: "bulk_operation_rejected",
      user_errors: payload.userErrors,
    }, 409);
  }
  return jsonResponse({
    ok: true,
    schema_version: REPORT_SCHEMA_VERSION,
    dataset,
    bulk_operation: payload.bulkOperation,
    timeframe: window ? { start: window.startDate, end: window.endDate, timezone: "Europe/Rome" } : null,
    data_policy: "commerce_reporting_no_customer_pii",
  }, 202);
}

async function getBulkStatus(env: ShopifyReportingEnv, operationId: string): Promise<Response> {
  const data = await shopifyGraphQL<BulkStatusData>(env, `
    query ShopifyAdvBulkStatus($id: ID!) {
      bulkOperation(id: $id) {
        id
        status
        errorCode
        objectCount
        rootObjectCount
        fileSize
        url
        partialDataUrl
        createdAt
        completedAt
      }
    }
  `, { id: operationId });
  if (!data.bulkOperation) return jsonResponse({ ok: false, error: "bulk_operation_not_found" }, 404);
  return jsonResponse({
    ok: true,
    schema_version: REPORT_SCHEMA_VERSION,
    data_policy: "commerce_reporting_no_customer_pii",
    bulk_operation: data.bulkOperation,
  });
}

async function handleProtectedRequest(request: Request, env: ShopifyReportingEnv, url: URL): Promise<Response> {
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

  if (url.pathname === "/internal/shopify/scopes") {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    try {
      const scopes = await getGrantedScopes(env);
      return jsonResponse({
        ok: true,
        service: "shopify_adv_reporting",
        scopes,
        requirements: {
          recent_orders: scopes.includes("read_orders"),
          historical_orders_over_60_days: scopes.includes("read_all_orders") && scopes.includes("read_orders"),
          products: scopes.includes("read_products"),
          inventory: scopes.includes("read_inventory") || scopes.includes("read_products"),
        },
      });
    } catch (error) {
      return jsonResponse({ ok: false, error: "shopify_scope_check_failed", detail: safeErrorCode(error) }, 503);
    }
  }

  if (url.pathname === "/internal/shopify/report") {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    const window = parseReportingWindow(url);
    if (!window) {
      return jsonResponse({
        ok: false,
        error: "invalid_timeframe",
        hint: `Use yesterday, last_7_days, last_14_days, month_to_yesterday, or custom start/end up to ${DEFAULT_MAX_REPORT_DAYS} days.`,
      }, 400);
    }
    try {
      const scopes = await getGrantedScopes(env);
      const sixtyDaysAgo = addDays(parseDate(todayInRome())!, -60);
      if (parseDate(window.startDate)! < sixtyDaysAgo && !scopes.includes("read_all_orders")) {
        return jsonResponse({
          ok: false,
          error: "read_all_orders_required",
          requested_start: window.startDate,
          granted_scopes: scopes,
        }, 403);
      }
      return jsonResponse(await buildReport(env, window));
    } catch (error) {
      return jsonResponse({ ok: false, error: "shopify_reporting_failed", detail: safeErrorCode(error) }, 503);
    }
  }

  if (url.pathname === "/internal/shopify/bulk/start") {
    if (request.method !== "POST") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    const datasetRaw = (url.searchParams.get("dataset") || "orders").trim();
    if (datasetRaw !== "orders" && datasetRaw !== "catalog") return jsonResponse({ ok: false, error: "invalid_dataset" }, 400);
    try {
      if (datasetRaw === "catalog") return startBulkOperation(env, "catalog");
      const start = (url.searchParams.get("start") || "").trim();
      const end = (url.searchParams.get("end") || "").trim();
      const reportingUrl = new URL(url.toString());
      reportingUrl.searchParams.set("timeframe", "custom");
      reportingUrl.searchParams.set("start", start);
      reportingUrl.searchParams.set("end", end);
      const window = parseReportingWindow(reportingUrl, 400);
      if (!window) return jsonResponse({ ok: false, error: "invalid_timeframe", hint: "Provide start/end YYYY-MM-DD; maximum 400 days." }, 400);
      const scopes = await getGrantedScopes(env);
      const sixtyDaysAgo = addDays(parseDate(todayInRome())!, -60);
      if (parseDate(window.startDate)! < sixtyDaysAgo && !scopes.includes("read_all_orders")) {
        return jsonResponse({ ok: false, error: "read_all_orders_required", granted_scopes: scopes }, 403);
      }
      return startBulkOperation(env, "orders", window);
    } catch (error) {
      return jsonResponse({ ok: false, error: "shopify_bulk_start_failed", detail: safeErrorCode(error) }, 503);
    }
  }

  if (url.pathname === "/internal/shopify/bulk/status") {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    const operationId = (url.searchParams.get("id") || "").trim();
    if (!/^gid:\/\/shopify\/BulkOperation\/\d+$/.test(operationId)) return jsonResponse({ ok: false, error: "invalid_bulk_operation_id" }, 400);
    try {
      return getBulkStatus(env, operationId);
    } catch (error) {
      return jsonResponse({ ok: false, error: "shopify_bulk_status_failed", detail: safeErrorCode(error) }, 503);
    }
  }

  return jsonResponse({ ok: false, error: "not_found" }, 404);
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown_error";
  if (/read_all_orders|access denied|forbidden|shopify_lookup_forbidden/i.test(message)) return "access_denied";
  if (/unauthorized|401|shopify_lookup_unauthorized/i.test(message)) return "unauthorized";
  if (/429|rate.limit/i.test(message)) return "rate_limited";
  if (/timeout|abort/i.test(message)) return "timeout";
  if (/query|graphql|validation/i.test(message)) return "graphql_error";
  if (/token|auth/i.test(message)) return "auth_unavailable";
  return "upstream_unavailable";
}

export async function handleShopifyReportingRequest(request: Request, env: ShopifyReportingEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/internal/shopify/")) return null;

  if (url.pathname === "/internal/shopify/health") {
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    return jsonResponse({
      ok: true,
      service: "shopify_adv_reporting",
      schema_version: REPORT_SCHEMA_VERSION,
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

  return handleProtectedRequest(request, env, url);
}
