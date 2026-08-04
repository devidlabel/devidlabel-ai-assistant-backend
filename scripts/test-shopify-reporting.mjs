import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = mkdtempSync(join(tmpdir(), 'shopify-reporting-'));
execFileSync('npx', ['tsc', '--outDir', out, '--noEmit', 'false', '--module', 'ESNext', '--target', 'ES2022', '--moduleResolution', 'Bundler'], { stdio: 'inherit' });

// Source imports follow the Worker/bundler convention (`./index`). Node ESM does not
// resolve extensionless specifiers in the temporary emitted test files, so make only
// the temporary compiled copy explicit without changing production source imports.
const compiledReporter = join(out, 'shopify-reporting.js');
writeFileSync(
  compiledReporter,
  readFileSync(compiledReporter, 'utf8').replace('from "./index";', 'from "./index.js";'),
  'utf8',
);

const { handleShopifyReportingRequest } = await import(`file://${compiledReporter}`);

const assert = (condition, message) => {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
};

const baseEnv = () => ({
  SHOPIFY_SHOP_DOMAIN: 'devid-label.myshopify.com',
  SHOPIFY_ADMIN_ACCESS_TOKEN: 'shpat_test_only',
  SHOPIFY_API_VERSION: '2025-10',
  SHOPIFY_REPORT_ACCESS_TOKEN: 'report-secret',
  COMMERCE_TENANT_ID: 'devid_multibrand',
});

const authorized = (url, method = 'GET') => new Request(url, {
  method,
  headers: { Authorization: 'Bearer report-secret' },
});

const moneyBag = (amount) => ({ shopMoney: { amount: String(amount), currencyCode: 'EUR' } });

function installFetchMock({ allOrders = true } = {}) {
  const calls = [];
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(init.body || '{}');
    const query = body.query || '';
    calls.push({ query, variables: body.variables || {} });

    if (query.includes('ShopifyReportingAccessScopes')) {
      const scopes = ['read_orders', 'read_products', 'read_inventory'];
      if (allOrders) scopes.push('read_all_orders');
      return new Response(JSON.stringify({
        data: { currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (query.includes('ShopifyAdvOrders')) {
      return new Response(JSON.stringify({
        data: {
          orders: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{
              id: 'gid://shopify/Order/999999999',
              processedAt: '2026-07-29T10:00:00+02:00',
              updatedAt: '2026-07-29T10:30:00+02:00',
              cancelledAt: null,
              test: false,
              sourceName: 'web',
              displayFinancialStatus: 'PAID',
              displayFulfillmentStatus: 'FULFILLED',
              currencyCode: 'EUR',
              currentSubtotalPriceSet: moneyBag(95),
              currentShippingPriceSet: moneyBag(5),
              currentTotalDiscountsSet: moneyBag(10),
              currentTotalTaxSet: moneyBag(21),
              currentTotalPriceSet: moneyBag(121),
              totalRefundedSet: moneyBag(0),
              lineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  id: 'gid://shopify/LineItem/1',
                  title: 'Cargo Courmayeur',
                  vendor: 'Devid Label',
                  sku: 'COURMA-MIL-M',
                  quantity: 1,
                  currentQuantity: 1,
                  discountedUnitPriceAfterAllDiscountsSet: moneyBag(95),
                  product: {
                    id: 'gid://shopify/Product/1',
                    title: 'Cargo Courmayeur',
                    handle: 'cargo-courmayeur',
                    vendor: 'Devid Label',
                    productType: 'Pantaloni',
                  },
                  variant: {
                    id: 'gid://shopify/ProductVariant/1',
                    title: 'Military / M',
                    sku: 'COURMA-MIL-M',
                  },
                }],
              },
            }],
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (query.includes('ShopifyAdvVariantCosts')) {
      return new Response(JSON.stringify({
        data: {
          nodes: [{
            id: 'gid://shopify/ProductVariant/1',
            inventoryQuantity: 8,
            inventoryItem: {
              id: 'gid://shopify/InventoryItem/1',
              unitCost: { amount: '40.00', currencyCode: 'EUR' },
            },
          }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (query.includes('ShopifyAdvBulkExport')) {
      assert(typeof body.variables?.query === 'string', 'bulk query should be passed as a GraphQL variable');
      const lower = body.variables.query.toLowerCase();
      assert(!lower.includes('email'), 'bulk query must not request email');
      assert(!lower.includes('customer {'), 'bulk query must not request customer');
      assert(!lower.includes('shippingaddress'), 'bulk query must not request shipping address');
      return new Response(JSON.stringify({
        data: {
          bulkOperationRunQuery: {
            bulkOperation: { id: 'gid://shopify/BulkOperation/123', status: 'CREATED', createdAt: '2026-07-30T12:00:00Z' },
            userErrors: [],
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (query.includes('ShopifyAdvBulkStatus')) {
      return new Response(JSON.stringify({
        data: {
          bulkOperation: {
            id: 'gid://shopify/BulkOperation/123',
            status: 'COMPLETED',
            errorCode: null,
            objectCount: '10',
            rootObjectCount: '2',
            fileSize: '2000',
            url: 'https://storage.example.test/result.jsonl',
            partialDataUrl: null,
            createdAt: '2026-07-30T12:00:00Z',
            completedAt: '2026-07-30T12:01:00Z',
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

let response = await handleShopifyReportingRequest(new Request('https://worker.test/internal/shopify/health'), baseEnv());
assert(response?.status === 200, 'health should return 200');
let payload = await response.json();
assert(payload.ok === true && payload.capabilities.bulk_order_backfill === true, 'health should expose safe capabilities');
assert(!JSON.stringify(payload).includes('shpat_test_only'), 'health must never expose Shopify token');
assert(!JSON.stringify(payload).includes('report-secret'), 'health must never expose report token');

response = await handleShopifyReportingRequest(new Request('https://worker.test/internal/shopify/report?timeframe=yesterday'), baseEnv());
assert(response?.status === 401, 'report must require bearer authorization');

installFetchMock({ allOrders: true });
response = await handleShopifyReportingRequest(authorized('https://worker.test/internal/shopify/scopes'), baseEnv());
payload = await response.json();
assert(response.status === 200 && payload.requirements.historical_orders_over_60_days === true, 'scope endpoint should detect historical order capability');

const calls = installFetchMock({ allOrders: true });
response = await handleShopifyReportingRequest(authorized('https://worker.test/internal/shopify/report?timeframe=yesterday'), baseEnv());
payload = await response.json();
assert(response.status === 200 && payload.ok === true, 'normalized report should succeed');
assert(payload.tenant === 'devid_multibrand', 'report should keep tenant identifier separate from domain');
assert(payload.data_policy === 'commerce_reporting_no_customer_pii', 'report should declare no-PII policy');
assert(payload.metrics.valid_orders === 1, 'ecommerce metrics should count Online Store order');
assert(payload.channel_policy.ecommerce.included_source_names.includes('web'), 'channel policy should include Online Store source');
assert(payload.channel_policy.ecommerce.included_source_names.includes('3890849'), 'channel policy should include Shop source');
assert(payload.segments.ecommerce.metrics.valid_orders === 1, 'ecommerce segment should contain Online Store order');
assert(payload.segments.all_shopify.metrics.valid_orders === 1, 'all-Shopify context should include valid order');
assert(payload.metrics.current_total === 121, 'report should aggregate current total');
assert(payload.metrics.net_merchandise_revenue === 95, 'net merchandise revenue formula should exclude shipping and tax');
assert(payload.metrics.cogs_current_unit_cost === 40, 'report should join current unit cost');
assert(payload.metrics.contribution_margin_proxy_before_adv_and_fulfillment === 55, 'contribution proxy should subtract COGS');
assert(payload.metrics.cost_coverage === 1, 'cost coverage should be complete in fixture');
assert(payload.breakdowns.vendor[0].vendor === 'Devid Label', 'vendor breakdown should be produced');
assert(payload.breakdowns.vendor[0].contribution_proxy === 55, 'vendor contribution proxy should use current cost');
assert(payload.orders[0].order_key && !payload.orders[0].order_key.includes('999999999'), 'order should use irreversible short key instead of Shopify order ID');
const serialized = JSON.stringify(payload).toLowerCase();
for (const forbidden of ['customer@example.com', 'shipping_address', 'billing_address', 'phone', 'shpat_test_only', 'report-secret']) {
  assert(!serialized.includes(forbidden), `report leaked forbidden value/key: ${forbidden}`);
}
assert(calls.some((call) => call.query.includes('ShopifyAdvOrders')), 'report should query orders');
assert(calls.some((call) => call.query.includes('ShopifyAdvVariantCosts')), 'report should query current costs separately');

installFetchMock({ allOrders: false });
response = await handleShopifyReportingRequest(authorized('https://worker.test/internal/shopify/report?timeframe=custom&start=2026-03-17&end=2026-03-17'), baseEnv());
payload = await response.json();
assert(response.status === 403 && payload.error === 'read_all_orders_required', 'old report must fail explicitly without read_all_orders');

installFetchMock({ allOrders: true });
response = await handleShopifyReportingRequest(authorized('https://worker.test/internal/shopify/bulk/start?dataset=orders&start=2026-03-17&end=2026-07-29', 'POST'), baseEnv());
payload = await response.json();
assert(response.status === 202 && payload.bulk_operation.id === 'gid://shopify/BulkOperation/123', 'historical orders bulk operation should start');
assert(payload.data_policy === 'commerce_reporting_no_customer_pii', 'bulk contract should retain PII policy');

installFetchMock({ allOrders: true });
response = await handleShopifyReportingRequest(authorized('https://worker.test/internal/shopify/bulk/start?dataset=catalog', 'POST'), baseEnv());
payload = await response.json();
assert(response.status === 202 && payload.dataset === 'catalog', 'catalog bulk operation should start');

installFetchMock({ allOrders: true });
response = await handleShopifyReportingRequest(authorized('https://worker.test/internal/shopify/bulk/status?id=gid%3A%2F%2Fshopify%2FBulkOperation%2F123'), baseEnv());
payload = await response.json();
assert(response.status === 200 && payload.bulk_operation.status === 'COMPLETED', 'bulk status should return completed operation');
assert(payload.bulk_operation.url.endsWith('result.jsonl'), 'bulk status should expose Shopify temporary JSONL URL to authorized caller');


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
        id: 'gid://shopify/Order/' + id,
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
            id: 'gid://shopify/LineItem/' + id,
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

console.log('Shopify ADV reporting tests passed');
