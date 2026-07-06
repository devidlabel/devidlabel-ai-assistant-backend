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

const productNode = (id, title, vendor, handle, productTypeOrTags = [], tagsOrQuantity = 5, quantityOrAmount = "100.00", amountOrCompare = null, maybeCompare = null) => {
  const hasStructuredType = typeof productTypeOrTags === "string";
  const productType = hasStructuredType ? productTypeOrTags : productTypeOrTags[0] || "";
  const tags = hasStructuredType ? tagsOrQuantity : productTypeOrTags;
  const quantity = hasStructuredType ? quantityOrAmount : tagsOrQuantity;
  const amount = hasStructuredType ? amountOrCompare : quantityOrAmount;
  const compare = hasStructuredType ? maybeCompare : amountOrCompare;
  return ({
  id: `gid://shopify/Product/${id}`,
  title,
  handle,
  vendor,
  productType,
  tags,
  onlineStoreUrl: `https://devidlabel.com/products/${handle}`,
  status: "ACTIVE",
  publishedAt: "2026-01-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  totalInventory: quantity,
  featuredImage: { url: `https://cdn.example/${handle}.jpg` },
  priceRangeV2: { minVariantPrice: { amount, currencyCode: "EUR" } },
  compareAtPriceRange: { minVariantCompareAtPrice: compare ? { amount: compare, currencyCode: "EUR" } : null },
  collections: { edges: [] },
  variants: { edges: [{ node: { id: `gid://shopify/ProductVariant/${id}`, title: "M", selectedOptions: [{ name: "Taglia", value: "M" }], inventoryQuantity: quantity, availableForSale: quantity > 0 } }] },
})};

const catalogProducts = [
  productNode(100, "T-Shirt Pocket Fiamma Nero", "Devid Label", "t-shirt-pocket-fiamma-nero", "T-shirt e polo", ["COL:Tshirt_Polo", "COL:Uomo"], 8, "59.00"),
  productNode(101, "Granada - T-Shirt In Puro Lino Premium", "Devid Label", "granada-t-shirt-puro-lino-premium", "T-shirt e polo", ["COL:Tshirt_Polo", "COL:Uomo"], 7, "89.00"),
  productNode(102, "MC2 Saint Barth Polo Evonne Donna", "MC2 Saint Barth", "mc2-saint-barth-polo-evonne-donna", "T-shirt e top", ["COL:Donna", "COL:Tshirt_Polo"], 6, "99.00"),
  productNode(103, "T-shirt MC2 Saint Barth Uomo", "MC2 Saint Barth", "t-shirt-mc2-saint-barth-uomo", "T-shirt e top", ["COL:Uomo", "COL:Tshirt_Polo"], 5, "89.00"),
  productNode(500, "Devid Label Alassio Polo", "Devid Label", "devid-label-alassio-polo", "T-shirt e polo", ["COL:Tshirt_Polo", "COL:Uomo"], 5, "99.00"),
  productNode(501, "Devid Label Mima - Polo In Cotone Spugna Premium Soft Touch", "Devid Label", "devid-label-mima-polo-cotone-spugna", "T-shirt e polo", ["COL:Tshirt_Polo", "COL:Uomo"], 5, "89.00"),
  productNode(502, "Polo Ralph Lauren Holiday Bear Sock", "Polo Ralph Lauren", "polo-ralph-lauren-holiday-bear-sock", "Intimo", ["COL:Intimo_Calze", "COL:Uomo"], 5, "29.00"),
  productNode(200, "Maglia Cotone Devid Label Uomo SS26", "Devid Label", "maglia-cotone-devid-label-uomo-ss26", "Maglieria", ["COL:Maglieria_Felpe", "COL:Uomo", "cotone", "SS26", "PE2026"], 5, "99.00"),
  productNode(201, "Vision of Super Black Sweater With Star Hole Nero", "Vision of Super", "vision-of-super-black-sweater-star-hole-nero", "Maglieria", ["winter"], 5, "149.00"),
  productNode(203, "MC2 Saint Barth Maglia New queen Vacanze di Natale", "MC2 Saint Barth", "mc2-saint-barth-maglia-new-queen-vacanze-di-natale", "Maglieria", ["Natale", "winter"], 5, "129.00"),
  productNode(205, "Maglia Donna Brand", "Brand B", "maglia-donna-brand", "Maglieria", ["COL:Donna"], 5, "109.00"),
  productNode(300, "Pantalone Chino Devid Label Uomo", "Devid Label", "pantalone-chino-devid-label-uomo", "Pantaloni", ["COL:Pantaloni", "COL:Uomo", "chino"], 5, "119.00"),
  productNode(301, "K-Way Pantaloni da sci", "K-Way", "pantaloni-sci-k-way-uomo", "Pantaloni", ["sci", "ski", "winter", "COL:Uomo"], 5, "199.00"),
  productNode(303, "Pantalone Donna Brand", "Brand B", "pantalone-donna-brand", "Pantaloni", ["COL:Pantaloni", "COL:Donna"], 5, "109.00"),
  productNode(400, "Overshirt In Gabardina Sabbia", "Devid Label", "overshirt-in-gabardina-sabbia", "Giacche e cappotti", ["COL:Uomo"], 5, "189.00"),
  productNode(401, "Giacca In Jersey Sky", "Devid Label", "giacca-in-jersey-sky", "Giacche e cappotti", ["COL:Uomo"], 5, "179.00"),
  productNode(402, "Giacca In Jersey Verde Militare", "Devid Label", "giacca-in-jersey-verde-militare", "Giacche e cappotti", ["COL:Uomo"], 5, "179.00"),
  productNode(403, "Giacca Donna Brand", "Brand B", "giacca-donna-brand", "Giacche e cappotti", ["COL:Donna"], 5, "179.00"),
  productNode(1, "Devid Label Cargo Courmayeur Dark Navy", "Devid Label", "devid-label-cargo-courmayeur-dark-navy", "Pantaloni", ["COL:Pantaloni", "COL:Uomo"], 6, "129.00", "159.00"),
  productNode(2, "Cargo Donna Brand B", "Brand B", "cargo-donna-brand-b", "Pantaloni", ["COL:Pantaloni", "COL:Donna"], 5, "109.00"),
];

let lastQuery = "";
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init?.body || "{}");
  if (body.query.includes("orders")) return new Response(JSON.stringify({ data: { orders: { edges: [] } } }), { status: 200 });
  lastQuery = body.variables?.query || body.variables?.handle || "";
  const source = catalogProducts;
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
const pagamento = await chat("pagamento alla consegna");
assert.equal(pagamento.type, "faq", "cash payment FAQ remains FAQ");
assert.equal((pagamento.recommended_products || []).length, 0, "cash payment FAQ does not return products");
const reso = await chat("reso facile");
assert.equal(reso.type, "faq", "return FAQ remains FAQ");
assert.equal((reso.recommended_products || []).length, 0, "return FAQ does not return products");

const tshirt = await chat("t-shirt");
assert.equal(tshirt.type, "product_advice", "t-shirt returns product_advice");
assert.equal(tshirt.recommended_products[0].vendor, "Devid Label", "generic t-shirt starts with Devid Label");
assert.match(tshirt.recommended_products[0].title, /t-shirt/i, "first t-shirt result is a Devid Label t-shirt");
assert(!/Non ho trovato una proposta Devid Label|couldn.t find a perfectly coherent Devid Label/i.test(tshirt.message), "t-shirt must not claim no coherent Devid Label exists");
assert(tshirt.recommended_products.slice(0, 3).some((item) => item.vendor === "Devid Label"), "Devid Label appears in first 3 t-shirt recommendations");
assert.notEqual(tshirt.recommended_products[0].vendor, "MC2 Saint Barth", "MC2 women t-shirt must not outrank Devid Label for generic t-shirt");

const polo = await chat("polo");
assert.equal(polo.type, "product_advice", "polo returns product_advice");
assert.equal(polo.recommended_products[0].vendor, "Devid Label", "generic polo favors coherent Devid Label");
assert.match(polo.recommended_products[0].title, /polo/i, "first polo result is a real polo product");
assert(polo.recommended_products.every((item) => !/sock|calz|intimo/i.test(`${item.title} ${item.handle} ${item.vendor}`)), "polo excludes Polo Ralph Lauren socks/intimo false vendor match");
assert(!polo.message.includes("Parto dai prodotti Devid Label") || polo.recommended_products[0].vendor === "Devid Label", "polo copy promising Devid Label matches carousel order");

const maglia = await chat("maglia");
assert.equal(maglia.type, "product_advice", "maglia returns product_advice");
assert.equal(maglia.recommended_products[0].vendor, "Devid Label", "generic maglia favors coherent Devid Label");
assert(!/Vision of Super|Vacanze di Natale/i.test(`${maglia.recommended_products[0].title} ${maglia.recommended_products[0].vendor}`), "generic maglia does not start with Vision of Super or MC2 Natale");
assert(!maglia.message.includes("Parto dai prodotti Devid Label") || maglia.recommended_products[0].vendor === "Devid Label", "copy promising Devid Label matches carousel order");
assert(maglia.recommended_products.every((item) => !/sweater|winter|natale|christmas/i.test(`${item.title} ${item.handle}`)), "generic maglia excludes winter/Natale products when coherent Devid Label exists");
const magliaUomo = await chat("maglia uomo");
assert(magliaUomo.recommended_products.every((item) => !/donna/i.test(`${item.title} ${item.handle}`)), "maglia uomo excludes women products");
const pantaloni = await chat("pantaloni");
assert.equal(pantaloni.recommended_products[0].vendor, "Devid Label", "generic pants favors Devid Label");
assert.equal(pantaloni.recommended_products[0].product_type ?? pantaloni.recommended_products[0].productType ?? "Pantaloni", "Pantaloni", "first pants result is Devid Label Pantaloni");
assert(pantaloni.recommended_products.every((item) => !/sci|ski|winter|inverno/i.test(`${item.title} ${item.handle}`)), "generic pants excludes ski/winter pants");
const pantaloniUomo = await chat("pantaloni uomo");
assert.equal(pantaloniUomo.recommended_products[0].vendor, "Devid Label", "men pants favors Devid Label");
assert(pantaloniUomo.recommended_products.every((item) => !/donna/i.test(`${item.title} ${item.handle}`)), "men pants excludes women products");
const giaccheUomo = await chat("giacche uomo");
assert(giaccheUomo.recommended_products.length > 1, "men jackets returns multiple Devid Label jackets");
assert(giaccheUomo.recommended_products.filter((item) => item.vendor === "Devid Label").length > 1, "men jackets includes Devid Label jackets without COL:Giacche_Cappotti tag");
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
const cargoPlain = await chat("cargo");
assert(cargoPlain.recommended_products.length > 0, "plain cargo does not return zero products");
assert.equal(cargoPlain.recommended_products[0].vendor, "Devid Label", "plain cargo favors Devid Label cargo");
assert(cargoPlain.recommended_products.every((item) => /cargo|courma|courmayeur|portorico|rovic|culebra/i.test(`${item.title} ${item.handle}`)), "cargo results require cargo model signal");

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
const enPolo = await chat("men polo", "en");
assert.equal(enPolo.recommended_products[0].vendor, "Devid Label", "EN men polo favors coherent Devid Label");
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
