import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

const checks = [
  ['debug endpoint exists', /url\.pathname === "\/debug\/shopify"/],
  ['admin token env is supported', /ASSISTANT_ADMIN_TOKEN\?: string/],
  ['debug endpoint uses admin header', /X-Assistant-Admin-Token/],
  ['unauthorized debug returns no details', /return json\(\{ ok: false, source: "shopify_debug", errors: \[\] \}, 404/],
  ['debug products query is minimal', /query DebugProducts \{ products\(first: 1\)/],
  ['debug orders query avoids customer fields', /query DebugOrders\(\$query: String!\).*lineItems\(first: 1\)/s],
  ['debug inventory query is minimal', /query DebugVariants \{ products\(first: 1\)/],
  ['mask function handles myshopify domains', /function maskShopDomain\(domain: string\): string[\s\S]*\.myshopify\.com/],
  ['sanitize function redacts bearer tokens', /Bearer \[redacted\]/],
];

for (const [name, pattern] of checks) {
  if (!pattern.test(source)) {
    console.error(`${name}: expected source pattern was not found`);
    process.exit(1);
  }
}

const forbiddenDebugFields = /customer|email|address|phone|displayAddress|billingAddress|shippingAddress|payment|name\s*}/i;
const debugQueries = source.match(/query Debug(?:Products|Orders|Variants)[^`]+/g) ?? [];
if (debugQueries.some((query) => forbiddenDebugFields.test(query))) {
  console.error('diagnostics test failed: debug GraphQL queries include forbidden customer/order fields');
  process.exit(1);
}

console.log('Shopify diagnostics source checks passed');
