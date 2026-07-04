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
  ['OAuth KV token is resolved before legacy fallback', /const storedToken = await loadStoredShopifyOAuthToken\(env\)[\s\S]*if \(env\.SHOPIFY_ADMIN_ACCESS_TOKEN\)/],
  ['OAuth exchange endpoint is used', /\/admin\/oauth\/access_token/],
  ['OAuth exchange does not request per-user grant options', /authorizeUrl\.searchParams\.set\("scope", SHOPIFY_OAUTH_SCOPES\)/],
  ['GraphQL obtains token through helper', /const token = await getShopifyAdminAccessToken\(env\)/],
  ['missing Shopify auth has controlled guardrail', /shopify_admin_token_missing|shopify_recommendations_unavailable/],
  ['token cache tracks source without replacing persistent KV', /let shopifyTokenCache = \{ accessToken: "", expiresAt: 0, source: "none" as ShopifyAuthTokenSource \}/],
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


import { mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const outDir = ".tmp/recommendations-commerce-test";
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
try {
  await execFileAsync("./node_modules/.bin/tsc", ["src/index.ts", "--target", "ES2022", "--module", "ES2022", "--moduleResolution", "Bundler", "--outDir", outDir, "--skipLibCheck", "--noEmitOnError", "false"]);
} catch (error) {
  if (!String(error?.stdout || "").includes("error TS")) throw error;
}
const { handleRequest } = await import(`../${outDir}/index.js?cache=${Date.now()}`);

const productNode = (id, title, vendor, handle, tags = [], quantity = 5, amount = "100.00", compare = null) => ({
  id: `gid://shopify/Product/${id}`,
  title,
  handle,
  vendor,
  productType: tags[0] || "",
  tags,
  onlineStoreUrl: `https://devidlabel.com/products/${handle}`,
  status: "ACTIVE",
  publishedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  featuredImage: { url: `https://cdn.example/${handle}.jpg` },
  priceRangeV2: { minVariantPrice: { amount, currencyCode: "EUR" } },
  compareAtPriceRange: { minVariantCompareAtPrice: compare ? { amount: compare, currencyCode: "EUR" } : null },
  collections: { edges: [] },
  variants: { edges: [{ node: { id: `gid://shopify/ProductVariant/${id}`, title: "M", selectedOptions: [{ name: "Taglia", value: "M" }], inventoryQuantity: quantity, availableForSale: quantity > 0 } }] },
});

const cargoProducts = [
  productNode(1, "Cargo Courmayeur Devid Label Uomo", "Devid Label", "cargo-courmayeur-devid-label", ["cargo", "uomo"], 6, "129.00", "159.00"),
  productNode(2, "Cargo Uomo Brand A", "Brand A", "cargo-uomo-brand-a", ["cargo", "uomo"], 4, "119.00"),
  productNode(3, "Cargo Donna Brand B", "Brand B", "cargo-donna-brand-b", ["cargo", "donna"], 5, "109.00"),
];
const saintProducts = [
  productNode(10, "T-shirt MC2 Saint Barth Uomo", "MC2 Saint Barth", "t-shirt-mc2-saint-barth-uomo", ["t-shirt", "uomo"], 5, "89.00"),
  productNode(11, "T-shirt Mosca Devid Label Uomo", "Devid Label", "t-shirt-mosca-devid-label", ["t-shirt", "uomo"], 5, "49.00"),
];
const tshirts = Array.from({ length: 12 }, (_, index) => productNode(100 + index, `${index === 0 ? "T-shirt Mosca Devid Label Uomo" : `T-shirt Uomo Brand ${index}`}`, index === 0 ? "Devid Label" : `Brand ${index}`, `t-shirt-uomo-${index}`, ["t-shirt", "uomo"], 5, `${49 + index}.00`));
const maglie = [
  productNode(200, "Maglia Monterosso Devid Label Uomo", "Devid Label", "maglia-monterosso-devid-label-uomo", ["maglieria", "uomo", "cotone"], 5, "99.00"),
  productNode(201, "Maglia MC2 Saint Barth Donna Winter", "MC2 Saint Barth", "maglia-mc2-saint-barth-donna-winter", ["maglieria", "donna", "winter"], 5, "149.00"),
];
const pants = [
  productNode(300, "Pantalone Chino Devid Label Uomo", "Devid Label", "pantalone-chino-devid-label-uomo", ["pantaloni", "uomo", "chino"], 5, "119.00"),
  productNode(301, "Pantaloni da sci K-Way Uomo", "K-Way", "pantaloni-sci-k-way-uomo", ["pantaloni", "uomo", "sci", "winter"], 5, "199.00"),
  productNode(302, "Jeans Replay Uomo", "Replay", "jeans-replay-uomo", ["jeans", "uomo"], 5, "139.00"),
  productNode(303, "Pantalone Donna Brand", "Brand B", "pantalone-donna-brand", ["pantaloni", "donna"], 5, "109.00"),
];
const jackets = [
  productNode(400, "Giacca Uomo Devid Label", "Devid Label", "giacca-uomo-devid-label", ["giacca", "outerwear", "uomo"], 5, "189.00"),
  productNode(401, "Giacca Donna Brand", "Brand B", "giacca-donna-brand", ["giacca", "outerwear", "donna"], 5, "179.00"),
];

let lastQuery = "";
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init?.body || "{}");
  if (body.query.includes("orders")) return new Response(JSON.stringify({ data: { orders: { edges: [] } } }), { status: 200 });
  lastQuery = body.variables?.query || body.variables?.handle || "";
  const source = body.variables?.handle ? [...saintProducts, ...tshirts, ...maglie, ...pants, ...jackets, ...cargoProducts] : /MC2 Saint Barth/i.test(lastQuery) ? saintProducts : /cargo/i.test(lastQuery) ? cargoProducts : /maglia|maglieria/i.test(lastQuery) ? maglie : /pantaloni|pantalone|chino|pants/i.test(lastQuery) ? pants : /giacca|giacche|outerwear|jacket/i.test(lastQuery) ? jackets : tshirts;
  return new Response(JSON.stringify({ data: { products: { edges: source.map((node) => ({ node })) }, collectionByHandle: { products: { edges: source.map((node) => ({ node })) } } } }), { status: 200 });
};

async function chat(query, locale = "it") {
  const request = new Request("https://assistant.test/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, locale, language: locale }) });
  const response = await handleRequest(request, { SHOPIFY_SHOP_DOMAIN: "devid-label.myshopify.com", SHOPIFY_ADMIN_ACCESS_TOKEN: "shpat_test", SHOPIFY_RECOMMENDATION_CACHE_TTL_SECONDS: "1" }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  return response.json();
}

const support = await chat("cash on delivery", "en");
assert.equal(support.type, "faq", "support intent remains FAQ");
assert.equal((support.recommended_products || []).length, 0, "support intent does not return products");
const reso = await chat("reso facile");
assert.equal(reso.type, "faq", "return FAQ remains FAQ");
assert.equal((reso.recommended_products || []).length, 0, "return FAQ does not return products");

const maglia = await chat("maglia");
assert.equal(maglia.type, "product_advice", "maglia returns product_advice");
assert.equal(maglia.recommended_products[0].vendor, "Devid Label", "generic maglia favors coherent Devid Label");
const magliaUomo = await chat("maglia uomo");
assert(magliaUomo.recommended_products.every((item) => !/donna/i.test(`${item.title} ${item.handle}`)), "maglia uomo excludes women products");
const pantaloni = await chat("pantaloni");
assert.equal(pantaloni.recommended_products[0].vendor, "Devid Label", "generic pants favors Devid Label");
assert(pantaloni.recommended_products.every((item) => !/sci|ski|winter|inverno/i.test(`${item.title} ${item.handle}`)), "generic pants excludes ski/winter pants");
const pantaloniUomo = await chat("pantaloni uomo");
assert.equal(pantaloniUomo.recommended_products[0].vendor, "Devid Label", "men pants favors Devid Label");
assert(pantaloniUomo.recommended_products.every((item) => !/donna/i.test(`${item.title} ${item.handle}`)), "men pants excludes women products");
const giaccheUomo = await chat("giacche uomo");
assert(giaccheUomo.recommended_products.every((item) => !/donna/i.test(`${item.title} ${item.handle}`)), "men jackets excludes women products");
const giaccaSci = await chat("giacca da sci");
assert.equal(giaccaSci.type, "product_advice", "ski jacket is allowed as shopping intent");

const cargo = await chat("pantaloni cargo uomo");
assert.equal(cargo.type, "product_advice", "shopping intent returns product_advice");
assert(cargo.recommended_products.length > 0, "shopping intent returns structured products");
assert.equal(cargo.recommended_products[0].vendor, "Devid Label", "Devid Label is first for coherent cargo uomo");
assert.equal(cargo.recommended_products[0].badge, "Devid Label", "Devid Label badge is set");
assert(cargo.recommended_products.every((item) => !/donna/i.test(`${item.title} ${item.handle}`)), "men request does not show women products first/results after hard filter");
assert(cargo.recommended_products[0].price && cargo.recommended_products[0].availability, "structured product fields include price and availability");
assert(cargo.recommended_products.length <= 10, "maximum 10 products");

const saint = await chat("t-shirt saint barth uomo");
assert.equal(saint.type, "product_advice", "brand shopping intent returns product_advice");
assert.equal(saint.recommended_products[0].vendor, "MC2 Saint Barth", "requested brand is respected before Devid Label");
assert.notEqual(saint.recommended_products[0].vendor, "Devid Label", "Devid Label is not forced for requested external brand");
assert.equal(saint.commerce_intent?.vendor, "MC2 Saint Barth", "commerce intent records requested brand");

const many = await chat("t-shirt uomo");
assert(many.recommended_products.length <= 10, "generic product carousel is capped at 10");
assert.equal(many.recommended_products[0].vendor, "Devid Label", "coherent Devid Label item is favored for generic category");

const enPants = await chat("men pants", "en");
assert(enPants.recommended_products.every((item) => !/donna/i.test(`${item.title} ${item.handle}`)), "EN men pants excludes women products");
const enCargo = await chat("men cargo pants", "en");
assert.equal(enCargo.recommended_products[0].vendor, "Devid Label", "EN men cargo pants favors Devid Label");
const enJackets = await chat("men jackets", "en");
assert(enJackets.recommended_products.every((item) => !/donna/i.test(`${item.title} ${item.handle}`)), "EN men jackets excludes women products");
const enSaint = await chat("men Saint Barth t-shirt", "en");
assert.equal(enSaint.recommended_products[0].vendor, "MC2 Saint Barth", "EN Saint Barth t-shirt respects external brand");

const english = await chat("men t-shirt", "en");
assert.equal(english.type, "product_advice", "EN shopping intent returns product_advice");
assert.match(`${english.title} ${english.message}`, /T-shirts|products|collection|show/i, "EN response uses English commerce copy");
assert.doesNotMatch(`${english.title} ${english.message}`, /Ti mostro|Consigli prodotto/i, "EN response does not leak Italian commerce copy");

console.log("Commerce recommendation routing and ranking tests passed");
