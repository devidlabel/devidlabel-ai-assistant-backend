import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = mkdtempSync(join(tmpdir(), 'order-chat-response-'));
execFileSync('npx', ['tsc', '--outDir', out, '--noEmit', 'false', '--module', 'ESNext', '--target', 'ES2022', '--moduleResolution', 'Bundler'], { stdio: 'inherit' });
const { orderChatResponse } = await import(`file://${out}/worker-v2.js`);

const assert = (condition, message) => {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
};

const lookupResponse = new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
const shipped = orderChatResponse({
  status: 'found',
  next_step: 'none',
  message: 'Legacy status copy',
  order_lookup: {
    fulfillment_state: 'shipped',
    tracking_items: [{ company: 'BRT', number: '12345678901234', url: 'https://tracking.example/12345678901234' }],
  },
  guardrails: [],
}, { locale: 'it-IT', language: 'it' }, '92665', 'customer@example.com', lookupResponse);
const shippedBody = await shipped.json();

assert(shippedBody.type === 'order_help', 'tracking response must remain an order_help response');
assert(shippedBody.title === 'Stato ordine', 'tracking response must keep a clear customer title');
assert(shippedBody.message.includes('BRT'), 'tracking response must show the courier name');
assert(shippedBody.message.includes('12345678901234'), 'tracking response must show the tracking number');
assert(shippedBody.primary_cta?.label === 'Segui la spedizione', 'tracking response must provide a customer-facing tracking CTA');
assert(shippedBody.primary_cta?.url === 'https://tracking.example/12345678901234', 'tracking CTA must use the direct Shopify tracking URL');
assert(shippedBody.order_lookup?.details?.tracking_items?.[0]?.number === '12345678901234', 'safe tracking details must remain available to the storefront');
assert(!JSON.stringify(shippedBody).includes('Legacy status copy'), 'technical legacy copy must not override the customer-facing tracking summary');

const withoutTracking = orderChatResponse({
  status: 'found',
  next_step: 'none',
  message: 'Il tuo ordine è stato ricevuto, ma non è ancora stato spedito.',
  order_lookup: { fulfillment_state: 'not_shipped', tracking_items: [] },
  guardrails: [],
}, { locale: 'it-IT', language: 'it' }, '92666', 'customer@example.com', lookupResponse);
const withoutTrackingBody = await withoutTracking.json();
assert(withoutTrackingBody.primary_cta === null, 'orders without a tracking URL must not show a broken CTA');
assert(/non è ancora stato spedito/i.test(withoutTrackingBody.message), 'orders without tracking must retain the useful order status');

console.log('Order chat response tests passed');
