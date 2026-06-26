const isVariantAvailable = (variant) => (typeof variant.inventoryQuantity === 'number' && variant.inventoryQuantity > 0) || variant.availableForSale === true;

function computeAvailabilityScore(product) {
  const variants = product.variants.length ? product.variants : [];
  const isOneSize = variants.length <= 1 || variants.every((v) => /default title|taglia unica|unica|unico|one size/i.test(v.title) || v.selectedOptions.every((o) => /title|taglia|size|numero/i.test(o.name) && /default title|taglia unica|unica|unico|one size/i.test(o.value)));
  const sizeVariants = variants.filter((v) => v.selectedOptions.some((o) => /size|taglia|numero/i.test(o.name)));
  const relevant = isOneSize ? variants.slice(0, 1) : (sizeVariants.length ? sizeVariants : variants);
  const totalVariantCount = Math.max(1, relevant.length || variants.length);
  const availableVariantCount = (relevant.length ? relevant : variants).filter(isVariantAvailable).length;
  const availabilityRatio = Math.min(1, availableVariantCount / totalVariantCount);
  return { isAvailableForRecommendation: isOneSize ? availableVariantCount > 0 : availabilityRatio >= 0.5, availabilityRatio, availableVariantCount, totalVariantCount, isOneSize };
}

const sized = (quantities) => ({ variants: quantities.map((quantity, index) => ({ title: ['S', 'M', 'L', 'XL'][index], selectedOptions: [{ name: 'Taglia', value: ['S', 'M', 'L', 'XL'][index] }], inventoryQuantity: quantity, availableForSale: quantity > 0 })) });
const oneSize = (quantity) => ({ variants: [{ title: 'Default Title', selectedOptions: [{ name: 'Title', value: 'Default Title' }], inventoryQuantity: quantity, availableForSale: quantity > 0 }] });

const cases = [
  ['2/4 sized variants pass', sized([1, 0, 1, 0]), true],
  ['1/4 sized variants fail', sized([1, 0, 0, 0]), false],
  ['one-size stock > 0 passes', oneSize(1), true],
  ['one-size stock 0 fails', oneSize(0), false],
];

for (const [name, product, expected] of cases) {
  const actual = computeAvailabilityScore(product).isAvailableForRecommendation;
  if (actual !== expected) {
    console.error(`${name}: expected ${expected}, got ${actual}`);
    process.exit(1);
  }
}
console.log('Recommendation availability tests passed');


import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const sourceChecks = [
  ['static token remains first priority', /if \(env\.SHOPIFY_ADMIN_ACCESS_TOKEN\) return env\.SHOPIFY_ADMIN_ACCESS_TOKEN;/],
  ['client credentials endpoint is used', /\/admin\/oauth\/access_token/],
  ['client credentials grant is sent', /grant_type: "client_credentials"/],
  ['GraphQL obtains token through helper', /const token = await getShopifyAdminAccessToken\(env\)/],
  ['missing Shopify auth has controlled guardrail', /shopify_auth_unavailable|shopify_recommendations_unavailable/],
  ['token cache is in-memory and global', /let shopifyTokenCache = \{ accessToken: "", expiresAt: 0 \}/],
];

for (const [name, pattern] of sourceChecks) {
  if (!pattern.test(source)) {
    console.error(`${name}: expected source pattern was not found`);
    process.exit(1);
  }
}

const consoleLines = source.split('\n').filter((line) => /console\.(log|error|warn)/.test(line));
if (consoleLines.some((line) => /access_token|SHOPIFY_ADMIN_ACCESS_TOKEN|SHOPIFY_CLIENT_SECRET|client_secret|token/i.test(line))) {
  console.error('Shopify auth test failed: a console statement appears to include sensitive token or secret terms');
  process.exit(1);
}

console.log('Shopify auth source checks passed');
