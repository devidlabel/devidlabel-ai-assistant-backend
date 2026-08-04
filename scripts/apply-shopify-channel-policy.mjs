import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(source, search, replacement, label) {
  const index = source.indexOf(search);
  if (index < 0) throw new Error(`Missing replacement target: ${label}`);
  if (source.indexOf(search, index + search.length) >= 0) throw new Error(`Replacement target is not unique: ${label}`);
  return source.slice(0, index) + replacement + source.slice(index + search.length);
}

function replaceFunction(source, signature, nextSignature, replacement, label) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing function start: ${label}`);
  const end = source.indexOf(nextSignature, start);
  if (end < 0) throw new Error(`Missing function end: ${label}`);
  return source.slice(0, start) + replacement.trimEnd() + "\n\n" + source.slice(end);
}

const shopifyPath = "src/shopify-reporting.ts";
let shopify = readFileSync(shopifyPath, "utf8");
shopify = replaceOnce(shopify, "const SCHEMA_VERSION = 1;", "const SCHEMA_VERSION = 2;", "Shopify schema version");

const channelHelpers = String.raw`
type ChannelGroup = "ecommerce" | "draft_store_proxy" | "marketplace" | "other";

type ChannelClassification = {
  group: ChannelGroup;
  label: string;
};

type MetricsAccumulator = {
  validOrders: number;
  currentTotal: number;
  currentShipping: number;
  currentTax: number;
  currentDiscounts: number;
  totalRefunded: number;
  netMerchandiseRevenue: number;
  cogs: number;
  currentUnits: number;
  costedUnits: number;
};

type SourceMetricsAccumulator = MetricsAccumulator & {
  source: string;
  group: ChannelGroup;
  label: string;
};

const ECOMMERCE_SOURCE_NAMES = ["web", "online_store", "shop", "3890849"] as const;

function sourceKey(source: string): string {
  return source.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function classifySource(source: string): ChannelClassification {
  const key = sourceKey(source);
  if (key === "web" || key === "online_store") return { group: "ecommerce", label: "Online Store" };
  if (key === "shop" || key === "3890849") return { group: "ecommerce", label: "Shop" };
  if (key.includes("draft")) return { group: "draft_store_proxy", label: "Draft Orders / store proxy" };
  if (/(amazon|spartoo|miinto|tiktok|ebay|farfetch|marketplace|channable)/.test(key)) {
    return { group: "marketplace", label: source };
  }
  if (key === "prestashop") return { group: "other", label: "Prestashop legacy/import" };
  return { group: "other", label: source || "Unknown" };
}

function createMetricsAccumulator(): MetricsAccumulator {
  return {
    validOrders: 0,
    currentTotal: 0,
    currentShipping: 0,
    currentTax: 0,
    currentDiscounts: 0,
    totalRefunded: 0,
    netMerchandiseRevenue: 0,
    cogs: 0,
    currentUnits: 0,
    costedUnits: 0,
  };
}

function addOrderMetrics(
  accumulator: MetricsAccumulator,
  values: {
    currentTotal: number;
    currentShipping: number;
    currentTax: number;
    currentDiscounts: number;
    totalRefunded: number;
    netMerchandiseRevenue: number;
    cogs: number;
    currentUnits: number;
    costedUnits: number;
  },
): void {
  accumulator.validOrders += 1;
  accumulator.currentTotal += values.currentTotal;
  accumulator.currentShipping += values.currentShipping;
  accumulator.currentTax += values.currentTax;
  accumulator.currentDiscounts += values.currentDiscounts;
  accumulator.totalRefunded += values.totalRefunded;
  accumulator.netMerchandiseRevenue += values.netMerchandiseRevenue;
  accumulator.cogs += values.cogs;
  accumulator.currentUnits += values.currentUnits;
  accumulator.costedUnits += values.costedUnits;
}

function metricsOutput(accumulator: MetricsAccumulator): JsonObject {
  const costCoverage = accumulator.currentUnits ? accumulator.costedUnits / accumulator.currentUnits : 0;
  const grossMarginProxy = accumulator.netMerchandiseRevenue - accumulator.cogs;
  return {
    valid_orders: accumulator.validOrders,
    current_total: roundMoney(accumulator.currentTotal),
    current_shipping: roundMoney(accumulator.currentShipping),
    current_tax: roundMoney(accumulator.currentTax),
    current_discounts: roundMoney(accumulator.currentDiscounts),
    total_refunded: roundMoney(accumulator.totalRefunded),
    net_merchandise_revenue: roundMoney(accumulator.netMerchandiseRevenue),
    cogs_current_unit_cost: roundMoney(accumulator.cogs),
    gross_margin_proxy_before_adv_fulfillment_and_fees: roundMoney(grossMarginProxy),
    contribution_margin_proxy_before_adv_and_fulfillment: roundMoney(grossMarginProxy),
    current_units: accumulator.currentUnits,
    costed_units: accumulator.costedUnits,
    cost_coverage: Math.round(costCoverage * 10_000) / 10_000,
    average_order_value_gross: accumulator.validOrders ? roundMoney(accumulator.currentTotal / accumulator.validOrders) : 0,
    net_merchandise_revenue_per_order: accumulator.validOrders ? roundMoney(accumulator.netMerchandiseRevenue / accumulator.validOrders) : 0,
    units_per_order: accumulator.validOrders ? Math.round((accumulator.currentUnits / accumulator.validOrders) * 100) / 100 : 0,
  };
}

function sourceRows(
  sourceMetrics: Map<string, SourceMetricsAccumulator>,
  group?: ChannelGroup,
): JsonObject[] {
  return [...sourceMetrics.values()]
    .filter((row) => !group || row.group === group)
    .map((row) => ({
      source: row.source,
      label: row.label,
      channel_group: row.group,
      metrics: metricsOutput(row),
    }))
    .sort((left, right) => {
      const leftMetrics = left.metrics as JsonObject;
      const rightMetrics = right.metrics as JsonObject;
      return Number(rightMetrics.net_merchandise_revenue || 0) - Number(leftMetrics.net_merchandise_revenue || 0);
    });
}
`;

shopify = replaceOnce(
  shopify,
  `function bump(map: Map<string, number>, key: string): void {\n  map.set(key, (map.get(key) || 0) + 1);\n}\n\nasync function buildReport`,
  `function bump(map: Map<string, number>, key: string): void {\n  map.set(key, (map.get(key) || 0) + 1);\n}\n\n${channelHelpers.trim()}\n\nasync function buildReport`,
  "Shopify channel helper insertion",
);

const buildReport = String.raw`
async function buildReport(env: ShopifyReportingEnv, window: Window, scopes: string[]): Promise<JsonObject> {
  const { orders, warnings } = await fetchOrders(env, window);
  const variantIds = orders.flatMap((order) => order.lineItems.nodes.map((item) => item.variant?.id || "")).filter(Boolean);
  const costResult = await fetchCosts(env, variantIds);
  if (costResult.warning) warnings.push(costResult.warning);

  const sources = new Map<string, number>();
  const validSources = new Map<string, number>();
  const financialStatuses = new Map<string, number>();
  const fulfillmentStatuses = new Map<string, number>();
  const vendors = new Map<string, VendorAccumulator>();
  const sourceMetrics = new Map<string, SourceMetricsAccumulator>();
  const ecommerce = createMetricsAccumulator();
  const draftStoreProxy = createMetricsAccumulator();
  const marketplaces = createMetricsAccumulator();
  const otherChannels = createMetricsAccumulator();
  const allShopify = createMetricsAccumulator();

  let cancelledOrders = 0;
  let testOrders = 0;
  const normalizedOrders: JsonObject[] = [];

  for (const order of orders) {
    const isTest = order.test === true;
    const isCancelled = Boolean(order.cancelledAt);
    if (isTest) testOrders += 1;
    if (isCancelled) cancelledOrders += 1;

    const source = (order.sourceName || "unknown").trim() || "unknown";
    const channel = classifySource(source);
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

      if (!isTest && !isCancelled && channel.group === "ecommerce") {
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
      bump(validSources, source);
      const values = {
        currentTotal: orderTotal,
        currentShipping: orderShipping,
        currentTax: orderTax,
        currentDiscounts: orderDiscount,
        totalRefunded: orderRefunded,
        netMerchandiseRevenue: orderMerchandise,
        cogs: orderCogs,
        currentUnits: orderUnits,
        costedUnits: orderCostedUnits,
      };
      addOrderMetrics(allShopify, values);
      if (channel.group === "ecommerce") addOrderMetrics(ecommerce, values);
      else if (channel.group === "draft_store_proxy") addOrderMetrics(draftStoreProxy, values);
      else if (channel.group === "marketplace") addOrderMetrics(marketplaces, values);
      else addOrderMetrics(otherChannels, values);

      const sourceRow = sourceMetrics.get(source) || {
        ...createMetricsAccumulator(),
        source,
        group: channel.group,
        label: channel.label,
      };
      addOrderMetrics(sourceRow, values);
      sourceMetrics.set(source, sourceRow);
    }

    normalizedOrders.push({
      order_key: await orderKey(order.id),
      processed_at: order.processedAt,
      updated_at: order.updatedAt || null,
      source,
      channel_group: channel.group,
      channel_label: channel.label,
      included_in_ecommerce_kpis: channel.group === "ecommerce",
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

  const vendorBreakdown = [...vendors.values()].map((row) => ({
    vendor: row.vendor,
    current_units: row.currentUnits,
    costed_units: row.costedUnits,
    revenue_proxy: roundMoney(row.revenueProxy),
    cogs_current_unit_cost: roundMoney(row.cogs),
    gross_margin_proxy: roundMoney(row.revenueProxy - row.cogs),
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
    channel_policy: {
      ecommerce: {
        definition: "Only Online Store and Shop orders are included in ecommerce KPIs and ecommerce MER.",
        included_source_names: [...ECOMMERCE_SOURCE_NAMES],
        labels: ["Online Store", "Shop"],
      },
      draft_orders_store_proxy: {
        definition: "Draft Orders are reported separately as an approximate proxy of physical-store sales, not as ecommerce.",
        precision: "approximate_not_official_pos",
      },
      marketplaces: {
        definition: "Marketplace orders are excluded from ecommerce KPIs and reported separately by source and in aggregate.",
      },
      other_channels: {
        definition: "Legacy imports and uncategorized Shopify sources are excluded from ecommerce KPIs and reported separately.",
      },
    },
    methodology: {
      order_date_basis: "processedAt",
      primary_kpi_scope: "ecommerce_only_online_store_and_shop",
      net_merchandise_revenue_formula: "current_total - current_shipping - current_tax",
      line_revenue_basis: "discountedUnitPriceAfterAllDiscountsSet * currentQuantity (proxy)",
      cogs_basis: "current InventoryItem.unitCost * currentQuantity; not historical cost at sale time",
      excluded_from_all_valid_order_metrics: "test orders and cancelled orders",
      excluded_from_ecommerce_kpis: "draft orders/store proxy, marketplaces, Prestashop legacy/import and all other sources",
      deprecated_metric_alias: "contribution_margin_proxy_before_adv_and_fulfillment equals gross margin proxy and is retained temporarily for compatibility",
    },
    metrics: {
      orders_returned: orders.length,
      cancelled_orders_all_channels: cancelledOrders,
      test_orders_all_channels: testOrders,
      ...metricsOutput(ecommerce),
    },
    segments: {
      ecommerce: {
        label: "E-commerce Devid Label",
        included_channels: ["Online Store", "Shop"],
        metrics: metricsOutput(ecommerce),
        vendor: vendorBreakdown,
        by_source: sourceRows(sourceMetrics, "ecommerce"),
      },
      draft_orders_store_proxy: {
        label: "Draft Orders / proxy negozio fisico",
        caveat: "Approximate snapshot only; it is not a precise official physical-store sales ledger.",
        metrics: metricsOutput(draftStoreProxy),
        by_source: sourceRows(sourceMetrics, "draft_store_proxy"),
      },
      marketplaces: {
        label: "Marketplace",
        metrics: metricsOutput(marketplaces),
        by_source: sourceRows(sourceMetrics, "marketplace"),
      },
      other_channels: {
        label: "Altri canali Shopify",
        metrics: metricsOutput(otherChannels),
        by_source: sourceRows(sourceMetrics, "other"),
      },
      all_shopify: {
        label: "Totale Shopify, solo contesto commerciale",
        caveat: "Never use this total as the ecommerce numerator for MER or ecommerce KPIs.",
        metrics: metricsOutput(allShopify),
        by_source: sourceRows(sourceMetrics),
      },
    },
    breakdowns: {
      source_all_returned_orders: Object.fromEntries([...sources.entries()].sort(([a], [b]) => a.localeCompare(b))),
      source_valid_orders: Object.fromEntries([...validSources.entries()].sort(([a], [b]) => a.localeCompare(b))),
      channel_group_valid_orders: {
        ecommerce: ecommerce.validOrders,
        draft_store_proxy: draftStoreProxy.validOrders,
        marketplace: marketplaces.validOrders,
        other: otherChannels.validOrders,
      },
      financial_status_all_returned_orders: Object.fromEntries([...financialStatuses.entries()].sort(([a], [b]) => a.localeCompare(b))),
      fulfillment_status_all_returned_orders: Object.fromEntries([...fulfillmentStatuses.entries()].sort(([a], [b]) => a.localeCompare(b))),
      vendor_ecommerce_only: vendorBreakdown,
      source: Object.fromEntries([...sources.entries()].sort(([a], [b]) => a.localeCompare(b))),
      financial_status: Object.fromEntries([...financialStatuses.entries()].sort(([a], [b]) => a.localeCompare(b))),
      fulfillment_status: Object.fromEntries([...fulfillmentStatuses.entries()].sort(([a], [b]) => a.localeCompare(b))),
      vendor: vendorBreakdown,
    },
    warnings: [...new Set(warnings)],
    orders: normalizedOrders,
  };
}
`;

shopify = replaceFunction(shopify, "async function buildReport", "function bulkOrdersQuery", buildReport, "Shopify buildReport");
shopify = replaceOnce(
  shopify,
  `      capabilities: {\n        pii_free_order_reporting: true,\n        current_inventory_cost_join: true,\n        bulk_order_backfill: true,\n        bulk_catalog_export: true,\n      },`,
  `      capabilities: {\n        pii_free_order_reporting: true,\n        current_inventory_cost_join: true,\n        ecommerce_channel_segmentation: true,\n        draft_order_store_proxy: true,\n        marketplace_source_segmentation: true,\n        bulk_order_backfill: true,\n        bulk_catalog_export: true,\n      },`,
  "Shopify health capabilities",
);
writeFileSync(shopifyPath, shopify);

const pulsePath = "src/daily-pulse.ts";
let pulse = readFileSync(pulsePath, "utf8");
pulse = replaceOnce(
  pulse,
  `    metrics: source.body.metrics || {},\n    breakdowns: source.body.breakdowns || {},\n    warnings: source.body.warnings || [],`,
  `    channel_policy: source.body.channel_policy || {},\n    metrics: source.body.metrics || {},\n    segments: source.body.segments || {},\n    breakdowns: source.body.breakdowns || {},\n    warnings: source.body.warnings || [],`,
  "Daily Pulse Shopify summary segments",
);

const combinedKpis = String.raw`
function combinedKpis(sources: { shopify: JsonObject; meta: JsonObject; google: JsonObject }): JsonObject {
  const shopifyMetrics = sources.shopify.metrics && typeof sources.shopify.metrics === "object" ? sources.shopify.metrics as JsonObject : {};
  const metaTotals = sources.meta.totals && typeof sources.meta.totals === "object" ? sources.meta.totals as JsonObject : {};
  const googleTotals = sources.google.totals && typeof sources.google.totals === "object" ? sources.google.totals as JsonObject : {};

  const ecommerceRevenue = numberValue(shopifyMetrics.net_merchandise_revenue);
  const grossMarginBeforeAds = numberValue(shopifyMetrics.gross_margin_proxy_before_adv_fulfillment_and_fees)
    || numberValue(shopifyMetrics.contribution_margin_proxy_before_adv_and_fulfillment);
  const metaSpend = numberValue(metaTotals.spend);
  const googleSpend = numberValue(googleTotals.spend);
  const paidSpend = metaSpend + googleSpend;
  const mer = paidSpend > 0 ? round(ecommerceRevenue / paidSpend, 4) : 0;
  return {
    shopify_ecommerce_net_merchandise_revenue: round(ecommerceRevenue),
    shopify_net_merchandise_revenue: round(ecommerceRevenue),
    ecommerce_revenue_scope: "online_store_and_shop_only",
    meta_spend: round(metaSpend),
    google_spend: round(googleSpend),
    paid_media_spend_meta_google: round(paidSpend),
    ecommerce_mer_meta_google: mer,
    mer_meta_google: mer,
    gross_margin_proxy_before_adv_fulfillment_and_fees: round(grossMarginBeforeAds),
    gross_margin_proxy_after_meta_google_before_fulfillment_and_fees: round(grossMarginBeforeAds - paidSpend),
    contribution_proxy_before_adv_and_fulfillment: round(grossMarginBeforeAds),
    contribution_proxy_after_meta_google_before_fulfillment: round(grossMarginBeforeAds - paidSpend),
  };
}
`;
pulse = replaceFunction(pulse, "function combinedKpis", "async function buildWindow", combinedKpis, "Daily Pulse combined KPIs");
pulse = replaceOnce(
  pulse,
  `      "Shopify COGS uses current InventoryItem.unitCost as a proxy, not historical unit cost at sale time.",\n      "Combined paid-media MER currently includes Meta + Google only.",\n      "Klaviyo attribution remains platform-reported and should not be added to Shopify revenue as incremental revenue.",`,
  `      "Ecommerce KPIs and MER use only Shopify Online Store and Shop orders; Draft Orders, marketplaces and other sources are reported separately.",\n      "Draft Orders are an approximate proxy of physical-store sales and are not ecommerce.",\n      "Shopify all-channel totals are context only and must never be used as the ecommerce MER numerator.",\n      "Shopify COGS uses current InventoryItem.unitCost as a proxy, not historical unit cost at sale time.",\n      "The pre-ADV profitability value is a gross-margin proxy until fulfillment, payment fees, packaging and variable return costs are included.",\n      "Combined paid-media MER currently includes Meta + Google only.",\n      "Klaviyo attribution remains platform-reported and should not be added to Shopify revenue as incremental revenue.",`,
  "Daily Pulse methodology notes",
);
writeFileSync(pulsePath, pulse);

const mcpPath = "src/mare-mcp.ts";
let mcp = readFileSync(mcpPath, "utf8");
mcp = replaceOnce(
  mcp,
  `description: "Returns the executive commerce pulse for yesterday and the last 7 complete days, combining Shopify, paid media, GA4, Search Console and Klaviyo. Shopify remains the source of truth for revenue.",`,
  `description: "Returns the executive commerce pulse for yesterday and the last 7 complete days. Ecommerce revenue and MER use only Shopify Online Store and Shop; Draft Orders, marketplaces and other Shopify sources are reported separately.",`,
  "MCP Daily Pulse description",
);
mcp = replaceOnce(
  mcp,
  `description: "Returns PII-free Shopify commerce metrics, COGS proxy, contribution proxy and source/vendor breakdowns for a selected completed period.",`,
  `description: "Returns PII-free Shopify reporting segmented into ecommerce (Online Store + Shop only), Draft Orders as an approximate physical-store proxy, marketplaces by source, other channels and all-Shopify context totals. Ecommerce KPIs exclude every non-ecommerce segment.",`,
  "MCP Shopify description",
);
writeFileSync(mcpPath, mcp);

const klaviyoPath = "src/klaviyo-reporting.ts";
let klaviyo = readFileSync(klaviyoPath, "utf8");
klaviyo = replaceOnce(
  klaviyo,
  `const KLAVIYO_REVISION = "2026-07-15";`,
  `const KLAVIYO_REVISION = "2026-07-15";\nconst KLAVIYO_MAX_RETRIES = 3;\nconst KLAVIYO_REPORT_CACHE_TTL_MS = 10 * 60 * 1000;\n\nlet cachedConversionMetricId: string | null = null;\nconst reportCache = new Map<string, { expiresAt: number; body: JsonObject }>();`,
  "Klaviyo cache constants",
);

const klaviyoFetch = String.raw`
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function klaviyoFetch(
  path: string,
  apiKey: string,
  init: RequestInit = {},
): Promise<JsonObject> {
  let lastStatus = 0;
  let lastBody: JsonObject = {};

  for (let attempt = 0; attempt <= KLAVIYO_MAX_RETRIES; attempt += 1) {
    const response = await fetch(`${KLAVIYO_API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.api+json",
        Authorization: `Klaviyo-API-Key ${apiKey}`,
        revision: KLAVIYO_REVISION,
        ...(init.body ? { "Content-Type": "application/vnd.api+json" } : {}),
        ...(init.headers || {}),
      },
    });

    let body: JsonObject = {};
    try {
      body = await response.json() as JsonObject;
    } catch {
      body = {};
    }

    if (response.ok) return body;
    lastStatus = response.status;
    lastBody = body;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= KLAVIYO_MAX_RETRIES) break;
    const retryAfterSeconds = Number(response.headers.get("Retry-After") || "0");
    const backoff = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : 300 * (2 ** attempt);
    await sleep(Math.min(backoff, 5000));
  }

  const error = new Error(`Klaviyo API request failed (${lastStatus || "unknown"})`);
  (error as Error & { status?: number; payload?: JsonObject }).status = lastStatus || undefined;
  (error as Error & { status?: number; payload?: JsonObject }).payload = lastBody;
  throw error;
}
`;
klaviyo = replaceFunction(klaviyo, "async function klaviyoFetch", "function metricScore", klaviyoFetch, "Klaviyo fetch retry");

const resolveMetric = String.raw`
async function resolveConversionMetricId(apiKey: string, env: KlaviyoReportingEnv): Promise<string> {
  const configured = normalizeSecret(env.KLAVIYO_CONVERSION_METRIC_ID);
  if (configured) return configured;
  if (cachedConversionMetricId) return cachedConversionMetricId;

  let path = "/api/metrics?fields[metric]=name,integration";
  let best: { id: string; score: number } | null = null;
  let pageCount = 0;

  while (path && pageCount < 10) {
    const payload = await klaviyoFetch(path, apiKey);
    const data = Array.isArray(payload.data) ? payload.data as KlaviyoMetric[] : [];
    for (const metric of data) {
      const id = typeof metric.id === "string" ? metric.id : "";
      const score = metricScore(metric);
      if (id && score >= 0 && (!best || score > best.score)) best = { id, score };
    }
    if (best?.score === 100) {
      cachedConversionMetricId = best.id;
      return best.id;
    }

    const links = payload.links && typeof payload.links === "object" ? payload.links as JsonObject : {};
    const next = typeof links.next === "string" ? links.next : "";
    if (!next) break;
    const nextUrl = new URL(next);
    path = `${nextUrl.pathname}${nextUrl.search}`;
    pageCount += 1;
  }

  if (!best) throw new Error("Placed Order metric not found. Configure KLAVIYO_CONVERSION_METRIC_ID explicitly.");
  cachedConversionMetricId = best.id;
  return best.id;
}
`;
klaviyo = replaceFunction(klaviyo, "async function resolveConversionMetricId", "function buildReportBody", resolveMetric, "Klaviyo metric cache");
klaviyo = replaceOnce(
  klaviyo,
  `        conversion_metric_id: Boolean(normalizeSecret(env.KLAVIYO_CONVERSION_METRIC_ID)),\n      },`,
  `        conversion_metric_id: Boolean(normalizeSecret(env.KLAVIYO_CONVERSION_METRIC_ID)),\n      },\n      resilience: {\n        retry_429_and_5xx: true,\n        maximum_retries: KLAVIYO_MAX_RETRIES,\n        report_cache_ttl_seconds: KLAVIYO_REPORT_CACHE_TTL_MS / 1000,\n        conversion_metric_memory_cache: true,\n      },`,
  "Klaviyo health resilience",
);
klaviyo = replaceOnce(
  klaviyo,
  `    const conversionMetricId = await resolveConversionMetricId(apiKey, env);\n    const [campaignPayload, flowPayload] = await Promise.all([\n      queryValuesReport(apiKey, "campaign", timeframe, conversionMetricId),\n      queryValuesReport(apiKey, "flow", timeframe, conversionMetricId),\n    ]);\n\n    return jsonResponse({\n      ok: true,\n      service: "klaviyo_reporting",\n      revision: KLAVIYO_REVISION,\n      generated_at: new Date().toISOString(),\n      timeframe,\n      conversion_metric: {\n        id: conversionMetricId,\n        name: "Placed Order",\n      },\n      statistics: [...REPORT_STATISTICS],\n      campaigns: reportResults(campaignPayload),\n      flows: reportResults(flowPayload),\n    });`,
  `    const conversionMetricId = await resolveConversionMetricId(apiKey, env);\n    const cacheKey = JSON.stringify({ timeframe, conversionMetricId });\n    const cached = reportCache.get(cacheKey);\n    if (cached && cached.expiresAt > Date.now()) {\n      return jsonResponse({ ...cached.body, cache: { hit: true, ttl_seconds: KLAVIYO_REPORT_CACHE_TTL_MS / 1000 } });\n    }\n\n    const campaignPayload = await queryValuesReport(apiKey, "campaign", timeframe, conversionMetricId);\n    await sleep(250);\n    const flowPayload = await queryValuesReport(apiKey, "flow", timeframe, conversionMetricId);\n    const responseBody: JsonObject = {\n      ok: true,\n      service: "klaviyo_reporting",\n      revision: KLAVIYO_REVISION,\n      generated_at: new Date().toISOString(),\n      timeframe,\n      conversion_metric: {\n        id: conversionMetricId,\n        name: "Placed Order",\n      },\n      statistics: [...REPORT_STATISTICS],\n      campaigns: reportResults(campaignPayload),\n      flows: reportResults(flowPayload),\n      cache: { hit: false, ttl_seconds: KLAVIYO_REPORT_CACHE_TTL_MS / 1000 },\n    };\n    reportCache.set(cacheKey, { expiresAt: Date.now() + KLAVIYO_REPORT_CACHE_TTL_MS, body: responseBody });\n    return jsonResponse(responseBody);`,
  "Klaviyo sequential cached reports",
);
klaviyo = replaceOnce(
  klaviyo,
  `    return jsonResponse({\n      ok: false,\n      error: "klaviyo_reporting_failed",\n      detail: safeError(error),\n    }, 502);`,
  `    const detail = safeError(error);\n    return jsonResponse({\n      ok: false,\n      error: "klaviyo_reporting_failed",\n      detail,\n    }, detail.status === 429 ? 429 : 502);`,
  "Klaviyo error status",
);
writeFileSync(klaviyoPath, klaviyo);

const shopifyTestPath = "scripts/test-shopify-reporting.mjs";
let shopifyTest = readFileSync(shopifyTestPath, "utf8");
shopifyTest = replaceOnce(
  shopifyTest,
  `assert(payload.metrics.valid_orders === 1, 'report should count valid order');`,
  `assert(payload.metrics.valid_orders === 1, 'ecommerce metrics should count Online Store order');\nassert(payload.channel_policy.ecommerce.included_source_names.includes('web'), 'channel policy should include Online Store source');\nassert(payload.channel_policy.ecommerce.included_source_names.includes('3890849'), 'channel policy should include Shop source');\nassert(payload.segments.ecommerce.metrics.valid_orders === 1, 'ecommerce segment should contain Online Store order');\nassert(payload.segments.all_shopify.metrics.valid_orders === 1, 'all-Shopify context should include valid order');`,
  "Shopify base channel assertions",
);

const channelTest = String.raw`

function installChannelSegmentationFetchMock() {
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(init.body || '{}');
    const query = body.query || '';
    if (query.includes('ShopifyReportingAccessScopes')) {
      return new Response(JSON.stringify({ data: { currentAppInstallation: { accessScopes: [
        { handle: 'read_orders' }, { handle: 'read_all_orders' }, { handle: 'read_products' }, { handle: 'read_inventory' },
      ] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (query.includes('ShopifyAdvOrders')) {
      const makeOrder = (id, sourceName) => ({
        id: `gid://shopify/Order/${id}`,
        processedAt: '2026-07-29T10:00:00+02:00',
        updatedAt: '2026-07-29T10:30:00+02:00',
        cancelledAt: null,
        test: false,
        sourceName,
        displayFinancialStatus: 'PAID',
        displayFulfillmentStatus: 'FULFILLED',
        currencyCode: 'EUR',
        currentSubtotalPriceSet: moneyBag(95),
        currentShippingPriceSet: moneyBag(5),
        currentTotalDiscountsSet: moneyBag(0),
        currentTotalTaxSet: moneyBag(21),
        currentTotalPriceSet: moneyBag(121),
        totalRefundedSet: moneyBag(0),
        lineItems: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{
            id: `gid://shopify/LineItem/${id}`,
            title: 'Test product', vendor: 'Devid Label', sku: 'TEST', quantity: 1, currentQuantity: 1,
            discountedUnitPriceAfterAllDiscountsSet: moneyBag(95),
            product: { id: 'gid://shopify/Product/1', title: 'Test product', handle: 'test-product', vendor: 'Devid Label', productType: 'Test' },
            variant: { id: 'gid://shopify/ProductVariant/1', title: 'Default', sku: 'TEST' },
          }],
        },
      });
      return new Response(JSON.stringify({ data: { orders: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          makeOrder('1', 'web'),
          makeOrder('2', '3890849'),
          makeOrder('3', 'shopify_draft_order'),
          makeOrder('4', 'amazon'),
          makeOrder('5', 'prestashop'),
        ],
      } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (query.includes('ShopifyAdvVariantCosts')) {
      return new Response(JSON.stringify({ data: { nodes: [{
        id: 'gid://shopify/ProductVariant/1', inventoryQuantity: 20,
        inventoryItem: { id: 'gid://shopify/InventoryItem/1', unitCost: { amount: '40.00', currencyCode: 'EUR' } },
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

installChannelSegmentationFetchMock();
response = await handleShopifyReportingRequest(authorized('https://worker.test/internal/shopify/report?timeframe=yesterday'), baseEnv());
payload = await response.json();
assert(response.status === 200, 'channel-segmented report should succeed');
assert(payload.metrics.valid_orders === 2, 'ecommerce KPIs must include only Online Store and Shop');
assert(payload.metrics.net_merchandise_revenue === 190, 'ecommerce revenue must exclude draft, marketplace and other channels');
assert(payload.segments.draft_orders_store_proxy.metrics.valid_orders === 1, 'Draft Orders must be separate physical-store proxy');
assert(payload.segments.marketplaces.metrics.valid_orders === 1, 'marketplace orders must be separate');
assert(payload.segments.other_channels.metrics.valid_orders === 1, 'legacy/other orders must be separate');
assert(payload.segments.all_shopify.metrics.valid_orders === 5, 'all Shopify valid orders must remain available as context');
assert(payload.segments.marketplaces.by_source[0].source === 'amazon', 'marketplace source must be cited individually');
assert(payload.orders.find((order) => order.source === 'shopify_draft_order').included_in_ecommerce_kpis === false, 'draft order must never enter ecommerce KPIs');
`;
shopifyTest = replaceOnce(shopifyTest, "\nconsole.log('Shopify ADV reporting tests passed');", `${channelTest}\nconsole.log('Shopify ADV reporting tests passed');`, "Shopify channel test insertion");
writeFileSync(shopifyTestPath, shopifyTest);

const klaviyoTest = String.raw`import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = mkdtempSync(join(tmpdir(), 'klaviyo-reporting-'));
execFileSync('npx', ['tsc', '--outDir', out, '--noEmit', 'false', '--module', 'ESNext', '--target', 'ES2022', '--moduleResolution', 'Bundler'], { stdio: 'inherit' });
const compiled = join(out, 'klaviyo-reporting.js');
const { handleKlaviyoReportingRequest } = await import(`file://${compiled}`);

const assert = (condition, message) => {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
};

const env = {
  KLAVIYO_PRIVATE_API_KEY: 'pk_test',
  KLAVIYO_REPORT_ACCESS_TOKEN: 'report-secret',
};
const request = () => new Request('https://worker.test/internal/klaviyo/report?timeframe=last_7_days', {
  headers: { Authorization: 'Bearer report-secret' },
});
let metricsCalls = 0;
let campaignCalls = 0;
let flowCalls = 0;
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname;
  if (path === '/api/metrics') {
    metricsCalls += 1;
    return new Response(JSON.stringify({ data: [{
      id: 'metric-placed-order',
      attributes: { name: 'Placed Order', integration: { name: 'Shopify' } },
    }], links: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (path === '/api/campaign-values-reports/') {
    campaignCalls += 1;
    if (campaignCalls === 1) {
      return new Response(JSON.stringify({ errors: [{ detail: 'rate limited' }] }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'Retry-After': '0' },
      });
    }
    return new Response(JSON.stringify({ data: { attributes: { results: [{ statistics: { recipients: 10 } }] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (path === '/api/flow-values-reports/') {
    flowCalls += 1;
    return new Response(JSON.stringify({ data: { attributes: { results: [{ statistics: { recipients: 20 } }] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
};

let response = await handleKlaviyoReportingRequest(request(), env);
let payload = await response.json();
assert(response.status === 200 && payload.ok === true, 'Klaviyo report should recover from 429');
assert(campaignCalls === 2, 'Klaviyo campaign report should retry once after 429');
assert(flowCalls === 1, 'Klaviyo flow report should run sequentially once');
assert(metricsCalls === 1, 'Placed Order metric should resolve once');
assert(payload.cache.hit === false, 'first Klaviyo response should be uncached');

response = await handleKlaviyoReportingRequest(request(), env);
payload = await response.json();
assert(response.status === 200 && payload.cache.hit === true, 'second Klaviyo response should use cache');
assert(campaignCalls === 2 && flowCalls === 1 && metricsCalls === 1, 'cached report should avoid additional Klaviyo API calls');

console.log('Klaviyo reporting resilience tests passed');
`;
writeFileSync("scripts/test-klaviyo-reporting.mjs", klaviyoTest);

const packagePath = "package.json";
let packageJson = readFileSync(packagePath, "utf8");
packageJson = replaceOnce(
  packageJson,
  `    "test:shopify-reporting": "node scripts/test-shopify-reporting.mjs",`,
  `    "test:shopify-reporting": "node scripts/test-shopify-reporting.mjs",\n    "test:klaviyo-reporting": "node scripts/test-klaviyo-reporting.mjs",`,
  "Klaviyo test package script",
);
writeFileSync(packagePath, packageJson);

const workflowPath = ".github/workflows/deploy-worker.yml";
let workflow = readFileSync(workflowPath, "utf8");
workflow = replaceOnce(
  workflow,
  `      - name: Test Shopify ADV reporting\n        run: npm run test:shopify-reporting\n\n      - name: Test Meta Marketing bridge`,
  `      - name: Test Shopify ADV reporting\n        run: npm run test:shopify-reporting\n\n      - name: Test Klaviyo reporting resilience\n        run: npm run test:klaviyo-reporting\n\n      - name: Test Meta Marketing bridge`,
  "Klaviyo workflow test",
);
writeFileSync(workflowPath, workflow);

console.log("Applied Shopify channel segmentation, Daily Pulse corrections and Klaviyo resilience changes.");
