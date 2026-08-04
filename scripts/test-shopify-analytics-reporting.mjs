import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = mkdtempSync(join(tmpdir(), 'shopify-analytics-reporting-'));
execFileSync('npx', ['tsc', '--outDir', out, '--noEmit', 'false', '--module', 'ESNext', '--target', 'ES2022', '--moduleResolution', 'Bundler'], { stdio: 'inherit' });

const compiledReporter = join(out, 'shopify-analytics-reporting.js');
writeFileSync(
  compiledReporter,
  readFileSync(compiledReporter, 'utf8').replace('from "./index";', 'from "./index.js";'),
  'utf8',
);

const { handleShopifyAnalyticsReportingRequest } = await import(`file://${compiledReporter}`);

const assert = (condition, message) => {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
};

const env = () => ({
  SHOPIFY_SHOP_DOMAIN: 'devid-label.myshopify.com',
  SHOPIFY_ADMIN_ACCESS_TOKEN: 'shpat_test_only',
  SHOPIFY_API_VERSION: '2025-10',
  SHOPIFY_REPORT_ACCESS_TOKEN: 'report-secret',
  COMMERCE_TENANT_ID: 'devid_multibrand',
});

const authorized = (url) => new Request(url, {
  headers: { Authorization: 'Bearer report-secret' },
});

function installFetchMock({ readReports = true } = {}) {
  const calls = [];
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(init.body || '{}');
    const graphql = body.query || '';
    const variables = body.variables || {};
    calls.push({ graphql, variables });

    if (graphql.includes('ShopifyAnalyticsAccessScopes')) {
      const scopes = ['read_orders', 'read_products'];
      if (readReports) scopes.push('read_reports');
      return new Response(JSON.stringify({
        data: { currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (graphql.includes('ShopifyAnalyticsQuery')) {
      const query = variables.query || '';
      let rows;
      if (query.includes('GROUP BY referrer_source, referrer_name')) {
        rows = query.includes("= 'bot'")
          ? [{ referrer_source: 'direct', referrer_name: null, sessions: 20, online_store_visitors: 20, sessions_that_completed_checkout: 0, conversion_rate: '0' }]
          : [{ referrer_source: 'search', referrer_name: 'Google', sessions: 80, online_store_visitors: 70, sessions_that_completed_checkout: 4, conversion_rate: '0.05' }];
      } else if (query.includes('GROUP BY utm_source, utm_medium')) {
        rows = [{ utm_source: 'google', utm_medium: 'cpc', sessions: 35, online_store_visitors: 30, sessions_that_completed_checkout: 2, conversion_rate: '0.057142' }];
      } else if (query.includes('GROUP BY landing_page_path, landing_page_type')) {
        rows = [{ landing_page_path: '/collections/sprayground', landing_page_type: 'collection', sessions: 25, online_store_visitors: 23, sessions_that_completed_checkout: 2, conversion_rate: '0.08', bounce_rate: '0.32', average_session_duration: 95 }];
      } else if (query.includes('GROUP BY human_or_bot_session')) {
        rows = [
          { day: '2026-08-03', human_or_bot_session: 'Human', sessions: 100, online_store_visitors: 90, sessions_that_completed_checkout: 5, conversion_rate: '0.05' },
          { day: '2026-08-03', human_or_bot_session: 'Bot', sessions: 20, online_store_visitors: 20, sessions_that_completed_checkout: 0, conversion_rate: '0' },
        ];
      } else if (query.includes("= 'human'")) {
        rows = [{ sessions: 100, online_store_visitors: 90, pageviews: 260, pageviews_per_session: '2.6', average_session_duration: 88, bounces: 35, bounce_rate: '0.35', sessions_with_cart_additions: 15, sessions_that_reached_checkout: 8, sessions_that_completed_checkout: 5, added_to_cart_rate: '0.15', reached_checkout_rate: '0.08', conversion_rate: '0.05' }];
      } else if (query.includes("= 'bot'")) {
        rows = [{ sessions: 20, online_store_visitors: 20, pageviews: 22, pageviews_per_session: '1.1', average_session_duration: 3, bounces: 19, bounce_rate: '0.95', sessions_with_cart_additions: 0, sessions_that_reached_checkout: 0, sessions_that_completed_checkout: 0, added_to_cart_rate: '0', reached_checkout_rate: '0', conversion_rate: '0' }];
      } else {
        rows = [{ sessions: 120, online_store_visitors: 110, pageviews: 282, pageviews_per_session: '2.35', average_session_duration: 74, bounces: 54, bounce_rate: '0.45', sessions_with_cart_additions: 15, sessions_that_reached_checkout: 8, sessions_that_completed_checkout: 5, added_to_cart_rate: '0.125', reached_checkout_rate: '0.066667', conversion_rate: '0.041667' }];
      }

      return new Response(JSON.stringify({
        data: {
          shopifyqlQuery: {
            tableData: {
              columns: Object.keys(rows[0] || {}).map((name) => ({ name, dataType: 'STRING', displayName: name })),
              rows,
            },
            parseErrors: [],
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

let response = await handleShopifyAnalyticsReportingRequest(new Request('https://worker.test/internal/shopify-analytics/health'), env());
assert(response?.status === 200, 'health should return 200');
let payload = await response.json();
assert(payload.capabilities.native_human_bot_split === true, 'health should expose native bot split capability');
assert(!JSON.stringify(payload).includes('shpat_test_only'), 'health must not expose Shopify token');

response = await handleShopifyAnalyticsReportingRequest(new Request('https://worker.test/internal/shopify-analytics/report?timeframe=yesterday'), env());
assert(response?.status === 401, 'analytics report should require bearer authorization');

installFetchMock({ readReports: false });
response = await handleShopifyAnalyticsReportingRequest(authorized('https://worker.test/internal/shopify-analytics/report?timeframe=yesterday'), env());
payload = await response.json();
assert(response.status === 403 && payload.error === 'read_reports_required', 'report should fail explicitly when read_reports is missing');

const calls = installFetchMock({ readReports: true });
response = await handleShopifyAnalyticsReportingRequest(authorized('https://worker.test/internal/shopify-analytics/report?timeframe=custom&start=2026-08-03&end=2026-08-03'), env());
payload = await response.json();
assert(response.status === 200 && payload.ok === true, 'analytics report should succeed');
assert(payload.totals.human.sessions === 100, 'human sessions should be returned separately');
assert(payload.totals.bot.sessions === 20, 'bot sessions should be returned separately');
assert(payload.totals.all.sessions === 120, 'all sessions should remain visible');
assert(payload.totals.human.conversion_rate === '0.05', 'human conversion rate should be the primary clean KPI');
assert(payload.breakdowns.human_traffic_source[0].referrer_name === 'Google', 'human traffic source should be returned');
assert(payload.breakdowns.bot_traffic_source[0].sessions === 20, 'bot traffic source should be retained for diagnostics');
assert(payload.breakdowns.human_utm[0].utm_medium === 'cpc', 'UTM breakdown should be returned');
assert(payload.breakdowns.human_landing_page[0].landing_page_path === '/collections/sprayground', 'landing page breakdown should be returned');
assert(calls.filter((call) => call.graphql.includes('ShopifyAnalyticsQuery')).length === 8, 'all analytics queries should execute');
assert(calls.some((call) => String(call.variables.query).includes("human_or_bot_session = 'human'")), 'queries should explicitly filter human sessions');
assert(calls.some((call) => String(call.variables.query).includes("human_or_bot_session = 'bot'")), 'queries should explicitly retain bot sessions');

console.log('Shopify analytics reporting tests passed');
