import { writeFileSync } from 'node:fs';

const worker = process.env.WORKER_URL || 'https://devidlabel-ai-assistant-backend.devidlabel.workers.dev';
const token = process.env.SHOPIFY_REPORT_ACCESS_TOKEN || process.env.DAILY_PULSE_ACCESS_TOKEN || '';

if (!token) throw new Error('shopify_report_access_token_not_configured');

function dateInRome(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(date, days) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function numberValue(value) {
  const parsed = typeof value === 'number' ? value : Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

async function fetchProtected(path) {
  try {
    const response = await fetch(`${worker}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { ok: false, error: 'invalid_json', sample: text.slice(0, 300) };
    }
    return { ok: response.ok && body.ok !== false, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { ok: false, error: error instanceof Error ? error.message : 'fetch_failed' },
    };
  }
}

function channelFor(source) {
  const raw = String(source || '').trim();
  const normalized = raw.toLowerCase().replace(/[\s_-]+/g, ' ');
  if (['web', 'online store', 'onlinestore'].includes(normalized)) {
    return { name: 'Online Store', group: 'ecommerce_direct' };
  }
  if (['shop', 'shop app', 'shop channel'].includes(normalized)) {
    return { name: 'Shop', group: 'ecommerce_direct' };
  }
  if (normalized.includes('draft')) {
    return { name: 'Draft Orders', group: 'store_proxy_draft' };
  }
  return { name: raw || 'Unknown', group: 'other_channel' };
}

function emptyChannel(name, group) {
  return {
    channel: name,
    group,
    orders: 0,
    gross_merchandise_sales: 0,
    current_subtotal: 0,
    current_total: 0,
    shipping: 0,
    tax: 0,
    discounts: 0,
    refunded: 0,
    net_merchandise_revenue: 0,
    cogs: 0,
    units: 0,
    costed_units: 0,
  };
}

function addMetrics(target, order) {
  target.orders += 1;
  target.current_subtotal += numberValue(order.current_subtotal);
  target.gross_merchandise_sales += numberValue(order.current_subtotal) + numberValue(order.current_discounts);
  target.current_total += numberValue(order.current_total);
  target.shipping += numberValue(order.current_shipping);
  target.tax += numberValue(order.current_tax);
  target.discounts += numberValue(order.current_discounts);
  target.refunded += numberValue(order.total_refunded);
  target.net_merchandise_revenue += numberValue(order.net_merchandise_revenue);
  target.cogs += numberValue(order.current_cogs);
  target.units += numberValue(order.current_units);
  target.costed_units += numberValue(order.costed_units);
}

function finalize(row) {
  const costCoverage = row.units > 0 ? row.costed_units / row.units : 1;
  const cogsComplete = costCoverage >= 0.999999;
  return {
    channel: row.channel,
    group: row.group,
    orders: row.orders,
    gross_merchandise_sales: round(row.gross_merchandise_sales),
    current_subtotal: round(row.current_subtotal),
    current_total: round(row.current_total),
    shipping: round(row.shipping),
    tax: round(row.tax),
    discounts: round(row.discounts),
    refunded: round(row.refunded),
    net_merchandise_revenue: round(row.net_merchandise_revenue),
    aov_net_merchandise: row.orders ? round(row.net_merchandise_revenue / row.orders) : 0,
    cogs_current_unit_cost: round(row.cogs),
    units: row.units,
    costed_units: row.costed_units,
    cost_coverage: round(costCoverage, 4),
    cogs_complete: cogsComplete,
    contribution_before_adv_and_fulfillment: cogsComplete
      ? round(row.net_merchandise_revenue - row.cogs)
      : null,
  };
}

function finalizeMerchandiseRow(row) {
  const costCoverage = row.units > 0 ? row.costed_units / row.units : 1;
  const cogsComplete = costCoverage >= 0.999999;
  return {
    ...row,
    revenue: round(row.revenue),
    cogs: round(row.cogs),
    cost_coverage: round(costCoverage, 4),
    cogs_complete: cogsComplete,
    contribution_proxy: cogsComplete ? round(row.revenue - row.cogs) : null,
  };
}

function summarizeOrders(report) {
  const orders = Array.isArray(report?.orders) ? report.orders : [];
  const direct = emptyChannel('Online Store + Shop', 'ecommerce_direct');
  const draft = emptyChannel('Draft Orders', 'store_proxy_draft');
  const other = new Map();
  const vendors = new Map();
  const products = new Map();

  for (const order of orders) {
    if (order.is_test === true || order.is_cancelled === true) continue;
    const channel = channelFor(order.source);
    if (channel.group === 'ecommerce_direct') addMetrics(direct, order);
    else if (channel.group === 'store_proxy_draft') addMetrics(draft, order);
    else {
      const row = other.get(channel.name) || emptyChannel(channel.name, channel.group);
      addMetrics(row, order);
      other.set(channel.name, row);
    }

    if (channel.group !== 'ecommerce_direct') continue;
    for (const item of Array.isArray(order.line_items) ? order.line_items : []) {
      const quantity = numberValue(item.current_quantity);
      const revenue = numberValue(item.current_line_revenue_proxy);
      const hasCogs = typeof item.current_line_cogs === 'number' && Number.isFinite(item.current_line_cogs);
      const lineCogs = hasCogs ? item.current_line_cogs : 0;
      const vendor = String(item.vendor || 'Unknown').trim() || 'Unknown';

      const vendorRow = vendors.get(vendor) || {
        vendor,
        units: 0,
        costed_units: 0,
        revenue: 0,
        cogs: 0,
      };
      vendorRow.units += quantity;
      vendorRow.revenue += revenue;
      if (hasCogs) {
        vendorRow.costed_units += quantity;
        vendorRow.cogs += lineCogs;
      }
      vendors.set(vendor, vendorRow);

      const productKey = String(item.product_id || item.handle || item.product_title || 'Unknown');
      const productRow = products.get(productKey) || {
        product_id: item.product_id || null,
        title: item.product_title || null,
        handle: item.handle || null,
        vendor,
        product_type: item.product_type || null,
        units: 0,
        costed_units: 0,
        revenue: 0,
        cogs: 0,
      };
      productRow.units += quantity;
      productRow.revenue += revenue;
      if (hasCogs) {
        productRow.costed_units += quantity;
        productRow.cogs += lineCogs;
      }
      products.set(productKey, productRow);
    }
  }

  return {
    ecommerce_direct: finalize(direct),
    store_proxy_draft: finalize(draft),
    other_channels: [...other.values()]
      .map(finalize)
      .sort((left, right) => right.net_merchandise_revenue - left.net_merchandise_revenue),
    top_vendors_ecommerce_direct: [...vendors.values()]
      .map(finalizeMerchandiseRow)
      .sort((left, right) => right.revenue - left.revenue)
      .slice(0, 25),
    top_products_ecommerce_direct: [...products.values()]
      .map(finalizeMerchandiseRow)
      .sort((left, right) => right.revenue - left.revenue)
      .slice(0, 50),
    cost_warnings: Array.isArray(report?.warnings) ? report.warnings : [],
  };
}

const today = dateInRome();
const end = addDays(today, -1);
const windows = [1, 3, 7, 14, 30].map((days) => ({
  key: days === 1 ? 'yesterday' : `last_${days}_days`,
  days,
  start: addDays(end, -(days - 1)),
  end,
}));

const outputWindows = [];
for (const window of windows) {
  const query = `timeframe=custom&start=${window.start}&end=${window.end}`;
  const [ordersResult, analyticsResult] = await Promise.all([
    fetchProtected(`/internal/shopify/report?${query}`),
    fetchProtected(`/internal/shopify-analytics/report?${query}`),
  ]);

  const commerce = ordersResult.ok ? summarizeOrders(ordersResult.body) : null;
  const analytics = analyticsResult.ok ? analyticsResult.body : null;
  const human = analytics?.totals?.human || {};
  const bot = analytics?.totals?.bot || {};
  const all = analytics?.totals?.all || {};
  const humanSessions = numberValue(human.sessions);
  const directRevenue = numberValue(commerce?.ecommerce_direct?.net_merchandise_revenue);
  const allSessions = numberValue(all.sessions);
  const botSessions = numberValue(bot.sessions);

  outputWindows.push({
    ...window,
    source_status: {
      orders: {
        ok: ordersResult.ok,
        status: ordersResult.status,
        error: ordersResult.ok ? null : ordersResult.body?.error || 'unavailable',
        detail: ordersResult.body?.detail || null,
      },
      analytics: {
        ok: analyticsResult.ok,
        status: analyticsResult.status,
        error: analyticsResult.ok ? null : analyticsResult.body?.error || 'unavailable',
        detail: analyticsResult.body?.detail || null,
        reinstall_required: analyticsResult.body?.reinstall_required === true,
      },
    },
    commerce,
    analytics: analytics ? {
      totals: analytics.totals,
      breakdowns: analytics.breakdowns,
      methodology: analytics.methodology,
      warnings: analytics.warnings || [],
    } : null,
    combined: commerce && analytics ? {
      human_sessions: humanSessions,
      human_visitors: numberValue(human.online_store_visitors),
      human_conversion_rate: numberValue(human.conversion_rate),
      sessions_that_completed_checkout_human: numberValue(human.sessions_that_completed_checkout),
      revenue_per_human_session: humanSessions > 0 ? round(directRevenue / humanSessions, 4) : 0,
      bot_sessions: botSessions,
      all_sessions: allSessions,
      bot_session_share: allSessions > 0 ? round(botSessions / allSessions, 4) : 0,
    } : null,
  });
}

const output = {
  ok: outputWindows.every((window) => window.source_status.orders.ok && window.source_status.analytics.ok),
  service: 'shopify_commerce_analytics_bundle',
  generated_at: new Date().toISOString(),
  timezone: 'Europe/Rome',
  primary_window: 'yesterday',
  windows: outputWindows,
  methodology: {
    ecommerce_direct: 'Only Shopify order sources canonicalized as Online Store or Shop.',
    excluded_from_site_kpis: 'Draft Orders, marketplaces, unknown and other sales channels.',
    human_kpis: "ShopifyQL sessions filtered with human_or_bot_session = 'human'.",
    bot_visibility: 'Bot sessions are retained separately for diagnostics and excluded from business conversion KPIs.',
    revenue_per_session: 'Online Store + Shop net merchandise revenue / Shopify human sessions.',
    gross_merchandise_sales_proxy: 'current_subtotal + current_discounts for valid, non-cancelled direct orders.',
    contribution_policy: 'Contribution is null unless all sold units in the relevant group have current unit cost coverage.',
  },
};

writeFileSync('shopify-commerce-analytics.json', JSON.stringify(output, null, 2));
console.log(JSON.stringify({
  generated_at: output.generated_at,
  ok: output.ok,
  windows: output.windows.map((window) => ({
    key: window.key,
    source_status: window.source_status,
    ecommerce_direct: window.commerce?.ecommerce_direct || null,
    combined: window.combined,
  })),
}, null, 2));
