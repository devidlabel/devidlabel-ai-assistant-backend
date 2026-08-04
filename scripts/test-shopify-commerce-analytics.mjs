import { readFileSync, rmSync } from 'node:fs';

const assert = (condition, message) => {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
};

const reporterSource = readFileSync('src/shopify-analytics-reporting.ts', 'utf8');
assert(/parseErrors\s*\{\s*message\s*\}/m.test(reporterSource), 'ShopifyQL parseErrors must select message');

process.env.WORKER_URL = 'https://worker.test';
process.env.DAILY_PULSE_ACCESS_TOKEN = 'daily-secret';
delete process.env.SHOPIFY_REPORT_ACCESS_TOKEN;

const authorizationHeaders = [];
const moneyOrder = {
  is_test: false,
  is_cancelled: false,
  source: 'web',
  current_subtotal: 100,
  current_discounts: 10,
  current_total: 127,
  current_shipping: 5,
  current_tax: 22,
  total_refunded: 0,
  net_merchandise_revenue: 100,
  current_cogs: 40,
  current_units: 2,
  costed_units: 1,
  line_items: [{
    product_id: 'gid://shopify/Product/1',
    product_title: 'Test Product',
    handle: 'test-product',
    vendor: 'Devid Label',
    product_type: 'Pantaloni',
    current_quantity: 2,
    current_line_revenue_proxy: 100,
    current_line_cogs: null,
  }],
};

const draftOrder = {
  ...moneyOrder,
  source: 'draft_order',
  net_merchandise_revenue: 300,
  current_subtotal: 300,
  current_total: 366,
  current_units: 1,
  costed_units: 1,
  current_cogs: 100,
  line_items: [],
};

globalThis.fetch = async (url, init = {}) => {
  authorizationHeaders.push(new Headers(init.headers).get('Authorization'));
  const requestUrl = new URL(url);
  if (requestUrl.pathname === '/internal/shopify/report') {
    return new Response(JSON.stringify({
      ok: true,
      warnings: ['unit_cost_unavailable_or_permission_missing'],
      orders: [moneyOrder, draftOrder],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (requestUrl.pathname === '/internal/shopify-analytics/report') {
    return new Response(JSON.stringify({
      ok: true,
      totals: {
        all: { sessions: 120, online_store_visitors: 110 },
        human: {
          sessions: 100,
          online_store_visitors: 90,
          sessions_that_completed_checkout: 5,
          conversion_rate: 0.05,
        },
        bot: { sessions: 20, online_store_visitors: 20 },
      },
      breakdowns: {
        human_traffic_source: [],
        bot_traffic_source: [],
        human_utm: [],
        human_landing_page: [],
        daily_human_bot: [],
      },
      methodology: {},
      warnings: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ ok: false, error: 'not_found' }), { status: 404 });
};

await import(`./build-shopify-commerce-analytics.mjs?test=${Date.now()}`);
const output = JSON.parse(readFileSync('shopify-commerce-analytics.json', 'utf8'));
rmSync('shopify-commerce-analytics.json', { force: true });

assert(output.ok === true, 'bundle should succeed with mocked sources');
assert(output.windows.length === 5, 'bundle should include 1/3/7/14/30-day windows');
const yesterday = output.windows[0];
assert(yesterday.commerce.ecommerce_direct.net_merchandise_revenue === 100, 'direct revenue must exclude draft orders');
assert(yesterday.commerce.store_proxy_draft.net_merchandise_revenue === 300, 'draft orders must stay separate');
assert(yesterday.commerce.ecommerce_direct.cost_coverage === 0.5, 'direct cost coverage should be preserved');
assert(yesterday.commerce.ecommerce_direct.contribution_before_adv_and_fulfillment === null, 'partial COGS must suppress contribution');
assert(yesterday.commerce.top_products_ecommerce_direct[0].contribution_proxy === null, 'partial product COGS must suppress product contribution');
assert(yesterday.commerce.cost_warnings.includes('unit_cost_unavailable_or_permission_missing'), 'source cost warnings must propagate');
assert(yesterday.combined.human_sessions === 100, 'human sessions should drive combined metrics');
assert(yesterday.combined.revenue_per_human_session === 1, 'revenue per human session should use direct revenue only');
assert(yesterday.combined.bot_session_share === 0.1667, 'bot share should remain diagnostic');
assert(authorizationHeaders.every((header) => header === 'Bearer daily-secret'), 'Daily Pulse token fallback must authenticate all snapshot calls');

console.log('Shopify commerce analytics bundle tests passed');
