import { handleGoogleAdsReportingRequest } from "./google-ads-reporting";
import { handleKlaviyoReportingRequest } from "./klaviyo-reporting";
import { handleMetaReportingRequest } from "./meta-reporting";
import { handleShopifyReportingRequest } from "./shopify-reporting";

type HistoricalAuditEnv = {
  DAILY_PULSE_ACCESS_TOKEN?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
  KLAVIYO_PRIVATE_API_KEY?: string;
  KLAVIYO_CONVERSION_METRIC_ID?: string;
  SHOPIFY_REPORT_ACCESS_TOKEN?: string;
  META_REPORT_ACCESS_TOKEN?: string;
  META_ADS_ACCESS_TOKEN?: string;
  META_AD_ACCOUNT_ID?: string;
  META_GRAPH_API_VERSION?: string;
  GOOGLE_ADS_REPORT_ACCESS_TOKEN?: string;
  GOOGLE_ADS_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
  GOOGLE_ADS_REFRESH_TOKEN?: string;
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  GOOGLE_ADS_CUSTOMER_ID?: string;
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;
  GOOGLE_ADS_API_VERSION?: string;
  [key: string]: unknown;
};

type JsonObject = Record<string, unknown>;
type Handler = (request: Request, env: any) => Promise<Response | null>;

type SourceResult = {
  ok: boolean;
  status: number;
  body: JsonObject;
};

type ChannelAccumulator = {
  channel: string;
  group: "ecommerce_direct" | "store_proxy_draft" | "other_channel";
  orders: number;
  current_total: number;
  shipping: number;
  tax: number;
  discounts: number;
  refunded: number;
  net_merchandise_revenue: number;
  cogs: number;
  contribution_before_adv_and_fulfillment: number;
  units: number;
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

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function timingSafeEqualText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

function auditToken(env: HistoricalAuditEnv): string {
  return normalize(env.DAILY_PULSE_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);
}

function isAuthorized(request: Request, env: HistoricalAuditEnv): boolean {
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  return timingSafeEqualText(supplied, auditToken(env));
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function daysInclusive(start: string, end: string): number {
  const startMs = new Date(`${start}T12:00:00Z`).getTime();
  const endMs = new Date(`${end}T12:00:00Z`).getTime();
  return Math.floor((endMs - startMs) / 86_400_000) + 1;
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

async function invoke(handler: Handler, path: string, token: string, env: HistoricalAuditEnv): Promise<SourceResult> {
  if (!token) return { ok: false, status: 503, body: { ok: false, error: "internal_report_token_not_configured" } };
  try {
    const response = await handler(new Request(`https://internal.local${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }), env);
    if (!response) return { ok: false, status: 404, body: { ok: false, error: "handler_not_found" } };
    let body: JsonObject = {};
    try {
      body = await response.json() as JsonObject;
    } catch {
      body = { ok: false, error: "invalid_json_response" };
    }
    return { ok: response.ok && body.ok !== false, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      body: { ok: false, error: error instanceof Error ? error.message : "internal_handler_error" },
    };
  }
}

function canonicalChannel(source: string): { channel: string; group: ChannelAccumulator["group"] } {
  const value = source.trim();
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, " ");

  if (["web", "online store", "onlinestore"].includes(normalized)) {
    return { channel: "Online Store", group: "ecommerce_direct" };
  }
  if (["shop", "shop app", "shop channel"].includes(normalized)) {
    return { channel: "Shop", group: "ecommerce_direct" };
  }
  if (normalized.includes("draft")) {
    return { channel: "Draft Orders", group: "store_proxy_draft" };
  }
  return { channel: value || "Unknown", group: "other_channel" };
}

function emptyChannel(channel: string, group: ChannelAccumulator["group"]): ChannelAccumulator {
  return {
    channel,
    group,
    orders: 0,
    current_total: 0,
    shipping: 0,
    tax: 0,
    discounts: 0,
    refunded: 0,
    net_merchandise_revenue: 0,
    cogs: 0,
    contribution_before_adv_and_fulfillment: 0,
    units: 0,
  };
}

function addChannel(target: ChannelAccumulator, source: ChannelAccumulator): void {
  target.orders += source.orders;
  target.current_total += source.current_total;
  target.shipping += source.shipping;
  target.tax += source.tax;
  target.discounts += source.discounts;
  target.refunded += source.refunded;
  target.net_merchandise_revenue += source.net_merchandise_revenue;
  target.cogs += source.cogs;
  target.contribution_before_adv_and_fulfillment += source.contribution_before_adv_and_fulfillment;
  target.units += source.units;
}

function finalizeChannel(row: ChannelAccumulator): JsonObject {
  return {
    channel: row.channel,
    group: row.group,
    orders: row.orders,
    current_total: round(row.current_total),
    shipping: round(row.shipping),
    tax: round(row.tax),
    discounts: round(row.discounts),
    refunded: round(row.refunded),
    net_merchandise_revenue: round(row.net_merchandise_revenue),
    aov_net_merchandise: row.orders > 0 ? round(row.net_merchandise_revenue / row.orders) : 0,
    cogs_current_unit_cost: round(row.cogs),
    contribution_before_adv_and_fulfillment: round(row.contribution_before_adv_and_fulfillment),
    units: row.units,
  };
}

function shopifyAudit(source: SourceResult): JsonObject {
  if (!source.ok) {
    return { ok: false, status: source.status, error: source.body.error || "unavailable", detail: source.body.detail || null };
  }

  const rows = Array.isArray(source.body.orders) ? source.body.orders as JsonObject[] : [];
  const channels = new Map<string, ChannelAccumulator>();

  for (const order of rows) {
    if (order.is_test === true || order.is_cancelled === true) continue;
    const rawSource = normalize(order.source) || "Unknown";
    const canonical = canonicalChannel(rawSource);
    const key = `${canonical.group}:${canonical.channel}`;
    const row = channels.get(key) || emptyChannel(canonical.channel, canonical.group);
    row.orders += 1;
    row.current_total += numberValue(order.current_total);
    row.shipping += numberValue(order.current_shipping);
    row.tax += numberValue(order.current_tax);
    row.discounts += numberValue(order.current_discounts);
    row.refunded += numberValue(order.total_refunded);
    row.net_merchandise_revenue += numberValue(order.net_merchandise_revenue);
    row.cogs += numberValue(order.current_cogs);
    row.units += numberValue(order.current_units);
    row.contribution_before_adv_and_fulfillment = row.net_merchandise_revenue - row.cogs;
    channels.set(key, row);
  }

  const direct = emptyChannel("Online Store + Shop", "ecommerce_direct");
  const draft = emptyChannel("Draft Orders", "store_proxy_draft");
  const other: ChannelAccumulator[] = [];

  for (const row of channels.values()) {
    if (row.group === "ecommerce_direct") addChannel(direct, row);
    else if (row.group === "store_proxy_draft") addChannel(draft, row);
    else other.push(row);
  }

  const allChannels = [...channels.values()]
    .sort((left, right) => right.net_merchandise_revenue - left.net_merchandise_revenue)
    .map(finalizeChannel);
  const otherChannels = other
    .sort((left, right) => right.net_merchandise_revenue - left.net_merchandise_revenue)
    .map(finalizeChannel);

  return {
    ok: true,
    timeframe: source.body.timeframe || null,
    ecommerce_direct: finalizeChannel(direct),
    store_proxy_draft: finalizeChannel(draft),
    other_channels: otherChannels,
    all_channels: allChannels,
    overall_metrics: source.body.metrics || {},
    vendor_breakdown: source.body.breakdowns && typeof source.body.breakdowns === "object"
      ? (source.body.breakdowns as JsonObject).vendor || []
      : [],
    warnings: source.body.warnings || [],
    methodology: source.body.methodology || {},
  };
}

function metaAudit(source: SourceResult): JsonObject {
  if (!source.ok) return { ok: false, status: source.status, error: source.body.error || "unavailable", detail: source.body.detail || null };
  const rows = Array.isArray(source.body.rows) ? source.body.rows as JsonObject[] : [];
  const totals = { spend: 0, impressions: 0, reach: 0, clicks: 0, link_clicks: 0, purchases: 0, purchase_value: 0 };
  for (const row of rows) {
    const metrics = row.metrics && typeof row.metrics === "object" ? row.metrics as JsonObject : {};
    totals.spend += numberValue(metrics.spend);
    totals.impressions += numberValue(metrics.impressions);
    totals.reach += numberValue(metrics.reach);
    totals.clicks += numberValue(metrics.clicks);
    totals.link_clicks += numberValue(metrics.link_clicks);
    totals.purchases += numberValue(metrics.purchases);
    totals.purchase_value += numberValue(metrics.purchase_value);
  }
  return {
    ok: true,
    time_range: source.body.time_range || null,
    totals: {
      spend: round(totals.spend),
      impressions: totals.impressions,
      reach: totals.reach,
      clicks: totals.clicks,
      link_clicks: totals.link_clicks,
      purchases: totals.purchases,
      purchase_value: round(totals.purchase_value),
      roas: totals.spend > 0 ? round(totals.purchase_value / totals.spend, 4) : 0,
      cpa: totals.purchases > 0 ? round(totals.spend / totals.purchases) : 0,
    },
    campaigns: rows,
  };
}

function googleAudit(source: SourceResult): JsonObject {
  if (!source.ok) return { ok: false, status: source.status, error: source.body.error || "unavailable", detail: source.body.detail || null };
  return {
    ok: true,
    time_range: source.body.time_range || null,
    totals: source.body.totals || {},
    campaigns: source.body.rows || [],
  };
}

function klaviyoTotals(results: unknown[]): JsonObject {
  const keys = [
    "recipients", "delivered", "opens_unique", "clicks_unique", "conversions",
    "conversion_uniques", "conversion_value", "bounced", "unsubscribes", "spam_complaints",
  ];
  const totals: JsonObject = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const entry of results) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as JsonObject;
    const statistics = row.statistics && typeof row.statistics === "object" ? row.statistics as JsonObject : row;
    for (const key of keys) totals[key] = numberValue(totals[key]) + numberValue(statistics[key]);
  }
  return totals;
}

function klaviyoAudit(source: SourceResult): JsonObject {
  if (!source.ok) return { ok: false, status: source.status, error: source.body.error || "unavailable", detail: source.body.detail || null };
  const campaigns = Array.isArray(source.body.campaigns) ? source.body.campaigns as unknown[] : [];
  const flows = Array.isArray(source.body.flows) ? source.body.flows as unknown[] : [];
  return {
    ok: true,
    timeframe: source.body.timeframe || null,
    campaign_totals: klaviyoTotals(campaigns),
    flow_totals: klaviyoTotals(flows),
    campaigns,
    flows,
  };
}

export async function handleHistoricalAuditRequest(request: Request, env: HistoricalAuditEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/internal/historical-audit")) return null;

  if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  if (url.pathname !== "/internal/historical-audit/report") return jsonResponse({ ok: false, error: "not_found" }, 404);

  const start = normalize(url.searchParams.get("start"));
  const end = normalize(url.searchParams.get("end"));
  const label = normalize(url.searchParams.get("label")) || `${start}_${end}`;
  const days = validDate(start) && validDate(end) && start <= end ? daysInclusive(start, end) : 0;
  if (!days || days > 31) {
    return jsonResponse({ ok: false, error: "invalid_range", hint: "Use start/end YYYY-MM-DD with a maximum of 31 days." }, 400);
  }

  const query = `timeframe=custom&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  const shopifyToken = normalize(env.SHOPIFY_REPORT_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);
  const metaToken = normalize(env.META_REPORT_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);
  const googleToken = normalize(env.GOOGLE_ADS_REPORT_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);
  const klaviyoToken = normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);

  const [shopifyRaw, metaRaw, googleRaw, klaviyoRaw] = await Promise.all([
    invoke(handleShopifyReportingRequest, `/internal/shopify/report?${query}`, shopifyToken, {
      ...env,
      SHOPIFY_REPORT_ACCESS_TOKEN: shopifyToken,
    }),
    invoke(handleMetaReportingRequest, `/internal/meta/report?${query}&level=campaign&daily=0`, metaToken, env),
    invoke(handleGoogleAdsReportingRequest, `/internal/google-ads/report?${query}`, googleToken, env),
    invoke(handleKlaviyoReportingRequest, `/internal/klaviyo/report?${query}`, klaviyoToken, env),
  ]);

  const shopify = shopifyAudit(shopifyRaw);
  const meta = metaAudit(metaRaw);
  const google = googleAudit(googleRaw);
  const klaviyo = klaviyoAudit(klaviyoRaw);
  const direct = shopify.ecommerce_direct && typeof shopify.ecommerce_direct === "object"
    ? shopify.ecommerce_direct as JsonObject
    : {};
  const metaTotals = meta.totals && typeof meta.totals === "object" ? meta.totals as JsonObject : {};
  const googleTotals = google.totals && typeof google.totals === "object" ? google.totals as JsonObject : {};
  const directRevenue = numberValue(direct.net_merchandise_revenue);
  const metaSpend = numberValue(metaTotals.spend);
  const googleSpend = numberValue(googleTotals.spend);
  const paidSpend = metaSpend + googleSpend;

  return jsonResponse({
    ok: true,
    service: "historical_commerce_audit",
    generated_at: new Date().toISOString(),
    timezone: "Europe/Rome",
    label,
    range: { start, end, days },
    sources: { shopify, meta, google, klaviyo },
    combined: {
      ecommerce_direct_net_merchandise_revenue: round(directRevenue),
      meta_spend: round(metaSpend),
      google_spend: round(googleSpend),
      paid_media_spend_meta_google: round(paidSpend),
      ecommerce_direct_mer_meta_google: paidSpend > 0 ? round(directRevenue / paidSpend, 4) : 0,
    },
    source_status: {
      shopify: { ok: shopifyRaw.ok, status: shopifyRaw.status },
      meta: { ok: metaRaw.ok, status: metaRaw.status },
      google: { ok: googleRaw.ok, status: googleRaw.status },
      klaviyo: { ok: klaviyoRaw.ok, status: klaviyoRaw.status },
    },
    notes: [
      "Online Store and Shop are aggregated only inside ecommerce_direct.",
      "Draft Orders are kept separate as an indicative store-sales proxy.",
      "Every other Shopify source is preserved as its own channel and is excluded from ecommerce_direct MER.",
      "Shopify order periods use processedAt; refund totals are current order-level refunds and can include refunds issued after the original sale date.",
      "Meta, Google and Klaviyo attribution is never added to Shopify revenue.",
      "Shopify COGS uses current InventoryItem.unitCost as a proxy, not historical unit cost at sale time.",
    ],
  });
}
