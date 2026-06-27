import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = mkdtempSync(join(tmpdir(), 'order-lookup-'));
execFileSync('npx', ['tsc', '--outDir', out, '--noEmit', 'false', '--module', 'ESNext', '--target', 'ES2022', '--moduleResolution', 'Bundler'], { stdio: 'inherit' });
const mod = await import(`file://${out}/index.js`);
const { handleRequest, normalizeOrderNumber, isMarketplaceOrder, buildSafeOrderLookup, normalizeTrackingUrl } = mod;
const assert = (condition, message) => { if (!condition) { console.error(message); process.exit(1); } };
const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'));
const orderLookupQuery = source.match(/const gql = `query OrderLookup\([\s\S]*?`;/)?.[0] ?? '';
const forbiddenGraphqlFields = [/noteAttributes/, /billingAddress/, /shippingAddress/, /displayAddress/, /phone\b/, /customer\s*\{/, /lineItems\s*\(/, /totalPriceSet/, /currentTotalPriceSet/, /financialStatus|displayFinancialStatus/];
for (const pattern of forbiddenGraphqlFields) assert(!pattern.test(orderLookupQuery), `forbidden GraphQL field in order lookup query: ${pattern}`);
for (const required of ['customAttributes', 'sourceName', 'sourceIdentifier', 'paymentGatewayNames', 'shippingLines', 'fulfillments', 'trackingInfo', 'email', 'name', 'number', 'displayFulfillmentStatus', 'cancelledAt']) assert(orderLookupQuery.includes(required), `required safe GraphQL field missing: ${required}`);

assert(normalizeOrderNumber('91991') === '91991', 'normalizes bare order number');
assert(normalizeOrderNumber('#91991') === '91991', 'normalizes hash order number');
assert(normalizeOrderNumber('Ordine #91991') === '91991', 'normalizes query order number');
assert(normalizeTrackingUrl('https://track.test/[[trackingNumber]]', '123') === 'https://track.test/123', 'normalizes BRT placeholder');
assert(isMarketplaceOrder({ sourceName: 'amazon', tags: [] }), 'detects marketplace internally');

const makeOrder = (patch) => ({ name: '#91991', number: 91991, email: 'cliente@example.com', displayFulfillmentStatus: 'UNFULFILLED', fulfillments: [], tags: [], customAttributes: [], paymentGatewayNames: [], shippingLines: { edges: [] }, ...patch });
const cases = new Map([
  ['11111', makeOrder({ name: '#11111' })],
  ['22222', makeOrder({ name: '#22222', displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ status: 'SUCCESS', displayStatus: 'DELIVERED', trackingInfo: [{ company: 'BRT', number: '123456789', url: 'https://brt.test/[[trackingNumber]]' }] }] })],
  ['33333', makeOrder({ name: '#33333', displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ status: 'SUCCESS', displayStatus: '', trackingInfo: [{ company: 'InPost', number: 'IP123', url: 'https://inpost.test/[trackingNumber]' }] }] })],
  ['44444', makeOrder({ name: '#44444', displayFulfillmentStatus: 'FULFILLED', paymentGatewayNames: ['Contrassegno'], fulfillments: [{ status: 'SUCCESS', displayStatus: '', trackingInfo: [{ company: 'BRT', number: 'COD1', url: 'https://brt.test/{trackingNumber}' }] }] })],
  ['55555', makeOrder({ name: '#55555', displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ trackingInfo: [{ company: 'BRT', number: 'A', url: 'https://brt.test/A' }] }, { trackingInfo: [{ company: 'InPost', number: 'B', url: 'https://inpost.test/B' }] }] })],
  ['66666', makeOrder({ name: '#66666', sourceName: 'Marketplace', tags: ['amazon'], fulfillments: [{ trackingInfo: [{ company: 'BRT', number: 'SECRET', url: 'https://x.test' }] }] })],
  ['77777', makeOrder({ name: '#77777', displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ trackingInfo: [{ company: 'BRT', number: 'R1', url: 'https://brt.test/R1' }] }] })],
]);

let graphqlCalls = 0;
globalThis.fetch = async (_url, init) => {
  graphqlCalls += 1;
  const body = JSON.parse(init.body);
  const q = body.variables.query;
  const number = (q.match(/(\d+)/) || [])[1];
  const order = cases.get(number);
  return new Response(JSON.stringify({ data: { orders: { edges: order ? [{ node: order }] : [] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const env = { SHOPIFY_SHOP_DOMAIN: 'devidlabel.myshopify.com', SHOPIFY_ADMIN_ACCESS_TOKEN: 'shpat_test' };
async function lookup(payload) {
  const req = new Request('https://worker.test/order/lookup', { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json', origin: 'https://devidlabel.com' } });
  const res = await handleRequest(req, env);
  return res.json();
}

let r = await lookup({ order_number: '11111', email: 'cliente@example.com' });
assert(r.status === 'found' && r.order_lookup.fulfillment_state === 'not_shipped' && r.order_lookup.tracking_items.length === 0, 'web received/not shipped case failed');
assert(!/paid|pending|financial|pagamento non completato/i.test(JSON.stringify(r)), 'not shipped leaks payment terms');

r = await lookup({ query: 'ordine 22222', email: 'cliente@example.com' });
assert(r.order_lookup.fulfillment_state === 'delivered' && r.order_lookup.tracking_items[0].company === 'BRT' && r.order_lookup.tracking_items[0].url.includes('123456789'), 'BRT delivered placeholder case failed');

r = await lookup({ order_number: '#33333', email: 'cliente@example.com' });
assert(r.order_lookup.fulfillment_state === 'shipped' && r.order_lookup.tracking_items[0].company === 'InPost', 'InPost empty shipment status case failed');

r = await lookup({ order_number: '44444', email: 'cliente@example.com' });
assert(r.order_lookup.fulfillment_state === 'shipped' && r.order_lookup.cash_on_delivery_note === true && r.message.includes('Il pagamento è previsto alla consegna.') && !/pending|pagamento non completato/i.test(r.message), 'COD case failed');

r = await lookup({ order_number: '55555', email: 'cliente@example.com' });
assert(r.order_lookup.tracking_items.length > 1 && /più spedizioni/.test(r.message), 'multi tracking case failed');

r = await lookup({ order_number: '66666' });
assert(r.status === 'marketplace_unsupported' && r.next_step === 'none' && r.order_lookup === null && r.guardrails.includes('marketplace_order_blocked'), 'marketplace response failed');
assert(!/amazon|spartoo|tiktok|miinto|BRT|SECRET/i.test(JSON.stringify(r)), 'marketplace response leaks source/tracking');

r = await lookup({ order_number: '77777', email: 'wrong@example.com' });
assert(r.status === 'email_mismatch' && r.next_step === 'email' && r.order_lookup === null && r.guardrails.includes('email_mismatch_no_order_data_returned'), 'email mismatch failed');
assert(!/R1|BRT|cliente@example.com/i.test(JSON.stringify(r)), 'email mismatch leaks order data');
r = await lookup({ order_number: '77777', email: 'cliente@example.com' });
assert(r.status === 'found' && r.order_lookup.tracking_items[0].number === 'R1', 'retry correct email failed');

r = await lookup({ order_number: '99999' });
assert(r.status === 'not_found' && r.next_step === 'order_number' && r.order_lookup === null, 'not found failed');
const beforeInvalid = graphqlCalls;
r = await lookup({ query: '' });
assert(r.status === 'invalid_input' && graphqlCalls === beforeInvalid, 'invalid input should not call Shopify');

const safe = buildSafeOrderLookup(cases.get('22222'));
assert(!('email' in safe) && !('id' in safe) && !('tags' in safe), 'safe lookup includes raw/private fields');
console.log('Order lookup tests passed');
