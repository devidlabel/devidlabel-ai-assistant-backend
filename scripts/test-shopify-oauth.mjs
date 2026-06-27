import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';

const out = mkdtempSync(join(tmpdir(), 'shopify-oauth-'));
execFileSync('npx', ['tsc', '--outDir', out, '--noEmit', 'false', '--module', 'ESNext', '--target', 'ES2022', '--moduleResolution', 'Bundler'], { stdio: 'inherit' });
const mod = await import(`file://${out}/index.js`);
const { handleRequest, getShopifyAdminAccessToken, persistShopifyOAuthToken, encryptShopifyToken, decryptShopifyToken } = mod;
const assert = (condition, message) => { if (!condition) { console.error(message); process.exit(1); } };

class MemoryKV {
  constructor() { this.map = new Map(); this.puts = []; this.deletes = []; }
  async get(key) { const item = this.map.get(key); if (!item) return null; if (item.expiresAt && item.expiresAt <= Date.now()) { this.map.delete(key); return null; } return item.value; }
  async put(key, value, options = {}) { this.puts.push({ key, value, options }); this.map.set(key, { value, expiresAt: options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : 0 }); }
  async delete(key) { this.deletes.push(key); this.map.delete(key); }
}

const key = randomBytes(32).toString('base64');
const baseEnv = () => ({ SHOPIFY_SHOP_DOMAIN: 'devid-label.myshopify.com', SHOPIFY_CLIENT_ID: 'cid', SHOPIFY_CLIENT_SECRET: 'secret', SHOPIFY_TOKEN_ENCRYPTION_KEY: key, SHOPIFY_TOKENS_KV: new MemoryKV(), ASSISTANT_ADMIN_TOKEN: 'admin' });
const install = (env) => handleRequest(new Request('https://worker.test/install?shop=devid-label.myshopify.com', { method: 'GET' }), env);

let env = baseEnv();
let res = await install(env);
assert(res.status === 302, 'install should redirect');
let redirect = new URL(res.headers.get('location'));
assert(redirect.searchParams.get('scope') === 'read_products,read_inventory,read_orders', 'install scope mismatch');
assert(!redirect.href.includes('grant_options'), 'install must not request per-user token');
let state = redirect.searchParams.get('state');
assert(state && env.SHOPIFY_TOKENS_KV.puts[0].key === `shopify:oauth_state:${state}` && env.SHOPIFY_TOKENS_KV.puts[0].options.expirationTtl === 600, 'install should save state with TTL');

env = baseEnv(); delete env.SHOPIFY_TOKENS_KV;
res = await install(env);
assert(res.status === 500 && !(res.headers.get('location')), 'install missing KV should not redirect');
env = baseEnv(); delete env.SHOPIFY_TOKEN_ENCRYPTION_KEY;
res = await install(env);
assert(res.status === 500 && !(res.headers.get('location')), 'install missing encryption key should not redirect');

function signedCallbackUrl(params, secret = 'secret') {
  const search = new URLSearchParams(params);
  const message = [...search.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('&');
  search.set('hmac', createHmac('sha256', secret).update(message).digest('hex'));
  return `https://worker.test/auth/callback?${search}`;
}

env = baseEnv();
await env.SHOPIFY_TOKENS_KV.put('shopify:oauth_state:valid', JSON.stringify({ shop: env.SHOPIFY_SHOP_DOMAIN }), { expirationTtl: 600 });
let fetchCalls = [];
globalThis.fetch = async (url, init) => { fetchCalls.push({ url: String(url), init }); return new Response(JSON.stringify({ access_token: 'shpat_oauth_secret', scope: 'read_orders,read_products,read_inventory' }), { status: 200, headers: { 'content-type': 'application/json' } }); };
res = await handleRequest(new Request(signedCallbackUrl({ shop: env.SHOPIFY_SHOP_DOMAIN, code: 'abc', state: 'valid', timestamp: '1' }), { method: 'GET' }), env);
assert(res.status === 200 && (await res.text()).includes('App installata correttamente'), 'callback valid should return success HTML');
assert(fetchCalls.length === 1 && fetchCalls[0].url.includes('/admin/oauth/access_token'), 'callback should exchange code');
assert(env.SHOPIFY_TOKENS_KV.deletes.includes('shopify:oauth_state:valid'), 'callback should delete state');
const stored = await env.SHOPIFY_TOKENS_KV.get(`shopify:offline_token:${env.SHOPIFY_SHOP_DOMAIN}`);
assert(stored && !stored.includes('shpat_oauth_secret'), 'stored token must be encrypted and not plaintext');

const badEnv = baseEnv();
res = await handleRequest(new Request(signedCallbackUrl({ shop: badEnv.SHOPIFY_SHOP_DOMAIN, code: 'abc', state: 'expired', timestamp: '1' }), { method: 'GET' }), badEnv);
assert(res.status === 403 && !(await badEnv.SHOPIFY_TOKENS_KV.get(`shopify:offline_token:${badEnv.SHOPIFY_SHOP_DOMAIN}`)), 'callback bad state should reject and not save token');
res = await handleRequest(new Request(signedCallbackUrl({ shop: 'other-shop.myshopify.com', code: 'abc', state: 'valid', timestamp: '1' }), { method: 'GET' }), baseEnv());
assert(res.status === 403, 'callback wrong shop should reject');

const tokenEnv = baseEnv();
await persistShopifyOAuthToken(tokenEnv, tokenEnv.SHOPIFY_SHOP_DOMAIN, 'shpat_kv_token', 'read_orders');
assert(await getShopifyAdminAccessToken(tokenEnv) === 'shpat_kv_token', 'get token should prefer OAuth KV');
const legacyEnv = baseEnv(); legacyEnv.SHOPIFY_TOKENS_KV = new MemoryKV(); legacyEnv.SHOPIFY_ADMIN_ACCESS_TOKEN = 'shpat_legacy';
assert(await getShopifyAdminAccessToken(legacyEnv) === 'shpat_legacy', 'get token should fallback to legacy secret');
let missingFailed = false;
try { await getShopifyAdminAccessToken({ SHOPIFY_SHOP_DOMAIN: 'devid-label.myshopify.com' }); } catch (e) { missingFailed = /shopify_admin_token_missing/.test(e.message); }
assert(missingFailed, 'get token should fail controlled when no token exists');

const encrypted = await encryptShopifyToken(baseEnv(), 'roundtrip_secret');
assert(await decryptShopifyToken(baseEnv(), encrypted.ciphertext, encrypted.iv) === 'roundtrip_secret', 'encryption roundtrip failed');
assert(!encrypted.ciphertext.includes('roundtrip_secret'), 'ciphertext must not contain plaintext token');

env = baseEnv();
await persistShopifyOAuthToken(env, env.SHOPIFY_SHOP_DOMAIN, 'shpat_debug_token', 'read_orders');
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  if (body.query.includes('products')) return new Response(JSON.stringify({ data: { products: { edges: [] } } }), { status: 200 });
  if (body.query.includes('orders')) return new Response(JSON.stringify({ data: { orders: { edges: [] } } }), { status: 200 });
  return new Response(JSON.stringify({ data: { products: { edges: [] } } }), { status: 200 });
};
res = await handleRequest(new Request('https://worker.test/debug/shopify', { method: 'POST', headers: { 'X-Assistant-Admin-Token': 'admin' } }), env);
const debug = await res.json();
assert(debug.auth_token_source === 'oauth_kv' && debug.checks.kv_token_store_configured && debug.checks.token_encryption_key_configured && debug.checks.stored_oauth_token_found, 'debug should report auth/token checks');
assert(!JSON.stringify(debug).includes('shpat_debug_token'), 'debug must not expose token');

const orderEnv = baseEnv();
await persistShopifyOAuthToken(orderEnv, orderEnv.SHOPIFY_SHOP_DOMAIN, 'shpat_order_token', 'read_orders');
let authHeader = '';
globalThis.fetch = async (_url, init) => {
  authHeader = init.headers['X-Shopify-Access-Token'];
  const order = { name: '#12345', number: 12345, email: 'c@example.com', displayFulfillmentStatus: 'UNFULFILLED', fulfillments: [], tags: [], customAttributes: [], paymentGatewayNames: [], shippingLines: { edges: [] } };
  return new Response(JSON.stringify({ data: { orders: { edges: [{ node: order }] } } }), { status: 200 });
};
res = await handleRequest(new Request('https://worker.test/order/lookup', { method: 'POST', body: JSON.stringify({ order_number: '12345', email: 'c@example.com' }) }), orderEnv);
assert((await res.json()).status === 'found' && authHeader === 'shpat_order_token', 'order lookup should use KV OAuth token for GraphQL');

console.log('Shopify OAuth token persistence tests passed');
