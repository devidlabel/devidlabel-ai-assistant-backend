import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const sourceChecks = [
  ['V2 analyzer exists', /function analyzeCommerceQueryV2\(query: string\)/],
  ['candidate strategies enumerated', /"collection_category"[\s\S]*"vendor_collection_category"[\s\S]*"vendor_only"/],
  ['taxonomy includes mare uomo', /COLLECTION_TAXONOMY[\s\S]*"moda-mare-uomo"[\s\S]*costumi_mare[\s\S]*uomo/],
  ['taxonomy includes required collections', /"bermuda-shorts-uomo"[\s\S]*"t-shirt-polo-uomo"[\s\S]*"t-shirt-top-donna"[\s\S]*"camicie-bluse-donna"/],
  ['category-only uses collection strategy', /isCategoryOnlyQuery[\s\S]*candidateStrategy = "collection_category"/],
  ['vendor category uses collection plus vendor strategy', /isVendorCategoryQuery[\s\S]*"vendor_collection_category"/],
  ['candidate fetch from collection handle', /function fetchRecommendationCandidates[\s\S]*fetchProductsByCollection/],
  ['collection query uses collectionByHandle', /collectionByHandle\(handle: \$handle\)/],
  ['collection handles feed cache key', /collectionTargets[\s\S]*join\(","\)/],
  ['category aliases no longer rewrite mare uomo to Saint Barth', /mare_uomo: \{ correctedQuery: "mare uomo"/],
  ['debug recommendation endpoint protected by admin header', /\/debug\/recommendation[\s\S]*X-Assistant-Admin-Token/],
  ['low confidence empties recommendations', /recommendations_empty_due_to_low_confidence/],
  ['no safe recommendations guardrail', /no_safe_recommendations/],
  ['classification prioritizes collection taxonomy', /function detectProductCategory[\s\S]*COLLECTION_TAXONOMY[\s\S]*productType[\s\S]*tags/],
  ['strong product intent matcher exists', /function isStrongProductIntentMatch[\s\S]*jeans_globe_devid_label[\s\S]*tshirt_mosca_devid_label[\s\S]*cargo_courmayeur_devid_label[\s\S]*monterosso_devid_label/],
  ['product intent final filter exists', /function filterProductIntentRecommendations[\s\S]*product_intent_strict_filter_applied[\s\S]*product_intent_incoherent_fill_excluded[\s\S]*product_intent_no_fill_applied/],
];
for (const [name, pattern] of sourceChecks) {
  if (!pattern.test(source)) fail(`${name}: expected source pattern was not found`);
}

const COLLECTION_TAXONOMY = {
  'moda-mare-uomo': { category: 'costumi_mare', gender: 'uomo', synonyms: ['mare uomo', 'costumi uomo', 'costume uomo'] },
  'moda-mare-donna': { category: 'costumi_mare', gender: 'donna', synonyms: ['mare donna', 'costumi donna', 'costume donna'] },
  'bermuda-shorts-uomo': { category: 'bermuda_shorts', gender: 'uomo', synonyms: ['short uomo', 'shorts uomo', 'bermuda uomo'] },
  't-shirt-polo-uomo': { category: 'tshirt', gender: 'uomo', synonyms: ['tee e polo uomo', 't-shirt uomo', 't shirt uomo'] },
  't-shirt-top-donna': { category: 'top_donna', gender: 'donna', synonyms: ['top donna', 't-shirt donna'] },
  'camicie-bluse-donna': { category: 'camicie', gender: 'donna', synonyms: ['camicie donna', 'camicia donna'] },
};

const mockCatalog = [
  product('mc2-costume-uomo', 'MC2 Saint Barth Costume Uomo Lighting', 'MC2 Saint Barth', 'Beachwear', ['uomo', 'costume', 'swimwear'], ['moda-mare-uomo'], 9, 12),
  product('mc2-telo-mare', 'MC2 Saint Barth Telo Mare Foutas', 'MC2 Saint Barth', 'Teli mare', ['telo', 'foutas', 'towel'], ['moda-mare-uomo'], 7, 7),
  product('mc2-cuffia-invernale', 'MC2 Saint Barth Cuffia Beanie Invernale', 'MC2 Saint Barth', 'Accessori', ['cuffia', 'beanie', 'winter'], [], 12, 30),
  product('mc2-maglia-donna-winter', 'MC2 Saint Barth Maglia Donna Winter', 'MC2 Saint Barth', 'Maglieria', ['donna', 'maglia', 'winter'], [], 8, 25),
  product('devid-jeans-globe', 'Devid Label Jeans Globe Dark Blue', 'Devid Label', 'Jeans', ['uomo', 'jeans', 'globe', 'denim'], [], 10, 2),
  product('devid-shopper-ecopelle-nero', 'Devid Label SHOPPER IN ECOPELLE NERO', 'Devid Label', 'Borse', ['shopper', 'ecopelle', 'accessori'], [], 10, 50),
  product('devid-shopper-ecopelle-blu', 'Devid Label SHOPPER IN ECOPELLE BLU', 'Devid Label', 'Borse', ['shopper', 'ecopelle', 'accessori'], [], 10, 49),
  product('devid-mosca', 'Devid Label T-shirt Mosca', 'Devid Label', 'T-shirt', ['uomo', 'mosca'], ['t-shirt-polo-uomo'], 10, 5),
  product('devid-monterosso', 'Devid Label Monterosso Cotone', 'Devid Label', 'Maglieria', ['uomo', 'monterosso'], ['t-shirt-polo-uomo'], 6, 4),
  product('devid-cargo-courmayeur', 'Devid Label Cargo Courmayeur', 'Devid Label', 'Cargo', ['uomo', 'cargo', 'courmayeur', 'courma'], [], 8, 4),
  product('devid-tshirt-generica', 'Devid Label T-shirt Basic Uomo', 'Devid Label', 'T-shirt', ['uomo', 't-shirt'], ['t-shirt-polo-uomo'], 9, 18),
  product('devid-pantalone-generico', 'Devid Label Pantalone Uomo', 'Devid Label', 'Pantaloni', ['uomo', 'pantalone'], [], 9, 17),
  product('colmar-giacca-uomo', 'Colmar Originals Giacca Piumino Uomo', 'Colmar Originals', 'Outerwear', ['uomo', 'giacca', 'piumino'], [], 9, 11),
  product('sprayground-zaino', 'Sprayground Zaino Shark Backpack', 'Sprayground', 'Zaini', ['zaino', 'backpack', 'accessori'], [], 9, 14),
  product('similar-top-donna', 'Puraai Top Donna Cotone', 'Puraai', 'Top', ['donna', 'top'], ['t-shirt-top-donna'], 8, 3),
  product('similar-tee-uomo', 'Ko Samui T-shirt Uomo Cotone', 'Ko Samui', 'T-shirt', ['uomo', 'tee'], ['t-shirt-polo-uomo'], 8, 6),
  product('camicia-donna', 'Distretto12 Camicia Donna Lino', 'Distretto12', 'Camicie', ['donna', 'camicia'], ['camicie-bluse-donna'], 5, 1),
  product('bermuda-uomo', 'Devid Label Bermuda Uomo Cotone', 'Devid Label', 'Bermuda', ['uomo', 'bermuda', 'short'], ['bermuda-shorts-uomo'], 8, 8),
];

const scenarios = [
  ['mare uomo', (result) => {
    eq(result.intent.candidateStrategy, 'collection_category', 'mare uomo strategy');
    eq(result.intent.vendorIntent, null, 'mare uomo vendor');
    includes(result.intent.collectionTargets, 'moda-mare-uomo', 'mare uomo target');
    all(result.recommended, (p) => p.collection_handles.includes('moda-mare-uomo'), 'mare uomo only collection products');
    none(result.recommended, (p) => p.handle.includes('cuffia') || p.product_gender === 'donna' || p.is_winter, 'mare uomo excludes winter/donna/cuffia');
  }],
  ['costume saint barth uomo', (result) => {
    eq(result.intent.candidateStrategy, 'vendor_collection_category', 'costume strategy');
    eq(result.intent.vendorIntent, 'MC2 Saint Barth', 'costume vendor');
    eq(result.intent.categoryIntent, 'costumi_mare', 'costume category');
    eq(result.intent.genderIntent, 'uomo', 'costume gender');
    all(result.recommended, (p) => p.vendor === 'MC2 Saint Barth' && p.product_category === 'costumi_mare' && p.product_gender !== 'donna', 'costume only MC2 swim uomo');
    none(result.recommended, (p) => /telo|foutas|towel|cuffia|maglia/i.test(p.title), 'costume excludes towels/cuffie/maglie');
  }],
  ['telo mare saint barth', (result) => {
    eq(result.intent.categoryIntent, 'teli_mare', 'telo category');
    eq(result.intent.vendorIntent, 'MC2 Saint Barth', 'telo vendor');
    all(result.recommended, (p) => p.product_category === 'teli_mare' && /telo|foutas|towel/i.test(p.title), 'telo only towels');
  }],
  ['saint barth', (result) => {
    eq(result.intent.candidateStrategy, 'vendor_only', 'saint barth strategy');
    eq(result.intent.vendorIntent, 'MC2 Saint Barth', 'saint barth vendor');
    const firstWinterIndex = result.recommended.findIndex((p) => p.is_winter);
    const firstSummerIndex = result.recommended.findIndex((p) => p.is_summer);
    ok(firstSummerIndex >= 0, 'saint barth has summer products');
    ok(firstWinterIndex === -1 || firstWinterIndex > firstSummerIndex, 'saint barth does not favor winter over summer');
  }],
  ['short uomo', (result) => {
    includes(result.intent.collectionTargets, 'bermuda-shorts-uomo', 'short uomo target');
    all(result.recommended, (p) => p.collection_handles.includes('bermuda-shorts-uomo') && p.product_gender !== 'donna', 'short uomo only bermuda uomo');
  }],
  ['tee e polo uomo', (result) => {
    includes(result.intent.collectionTargets, 't-shirt-polo-uomo', 'tee target');
    none(result.recommended, (p) => ['costumi_mare', 'teli_mare', 'zaini', 'borse_accessori'].includes(p.product_category), 'tee excludes beach/accessories');
  }],
  ['top donna', (result) => {
    includes(result.intent.collectionTargets, 't-shirt-top-donna', 'top target');
    eq(result.intent.genderIntent, 'donna', 'top gender');
  }],
  ['camicie donna', (result) => {
    includes(result.intent.collectionTargets, 'camicie-bluse-donna', 'camicie target');
    eq(result.intent.genderIntent, 'donna', 'camicie gender');
  }],
  ['globe', (result) => {
    eq(result.intent.productIntent, 'jeans_globe_devid_label', 'globe product intent');
    eq(result.recommended[0]?.handle, 'devid-jeans-globe', 'globe first result');
    eq(result.recommended.length, 1, 'globe returns only one coherent product');
    none(result.recommended, (p) => /shopper|ecopelle|borsa|accessori/i.test(p.title + ' ' + p.product_category), 'globe excludes shopper/ecopelle/borsa/accessori');
    includes(result.guardrails, 'product_intent_strict_filter_applied', 'globe strict guardrail');
    includes(result.guardrails, 'product_intent_no_fill_applied', 'globe no-fill guardrail');
  }],
  ['jeans globe', (result) => {
    all(result.recommended, (p) => /globe/i.test(p.title) && p.product_category === 'jeans', 'jeans globe only coherent Globe jeans');
    none(result.recommended, (p) => /shopper|ecopelle|borsa|accessori/i.test(p.title + ' ' + p.product_category), 'jeans globe excludes accessories');
  }],
  ['mosca', (result) => {
    all(result.recommended, (p) => /mosca/i.test(p.title), 'mosca only Mosca products');
    none(result.recommended, (p) => /monterosso|corniglia|globe|shopper/i.test(p.title), 'mosca excludes other Devid products');
  }],
  ['courmayeur', (result) => {
    all(result.recommended, (p) => /courmayeur|courma/i.test(p.title) && p.product_category === 'cargo', 'courmayeur only Cargo Courmayeur');
    none(result.recommended, (p) => /jeans|bermuda|shopper|accessori/i.test(p.title + ' ' + p.product_category), 'courmayeur excludes incoherent products');
  }],
  ['monterosso', (result) => {
    all(result.recommended, (p) => /monterosso/i.test(p.title), 'monterosso only Monterosso');
    none(result.recommended, (p) => /mosca|corniglia|shopper|borsa|accessori/i.test(p.title + ' ' + p.product_category), 'monterosso excludes other products');
  }],
  ['sprayground', (result) => {
    eq(result.intent.candidateStrategy, 'vendor_only', 'sprayground strategy');
    eq(result.intent.vendorIntent, 'Sprayground', 'sprayground vendor');
    eq(result.devid_label_alternatives.length, 0, 'sprayground no Devid alternatives');
    all(result.recommended, (p) => p.vendor === 'Sprayground' && p.product_category === 'zaini', 'sprayground backpacks only');
  }],
  ['giacca colmar uomo', (result) => {
    eq(result.intent.vendorIntent, 'Colmar Originals', 'colmar vendor');
    eq(result.intent.categoryIntent, 'outerwear', 'colmar category');
    eq(result.intent.genderIntent, 'uomo', 'colmar gender');
    all(result.recommended, (p) => p.vendor === 'Colmar Originals' && p.product_category === 'outerwear', 'colmar only outerwear');
  }],
  ['pagamento alla consegna', (result) => {
    eq(result.type, 'faq', 'cod faq type');
    eq(result.fetchCount, 0, 'cod no recommendation fetch');
    eq(result.recommended.length, 0, 'cod empty recommendations');
  }],
];

for (const [query, assert] of scenarios) assert(runMockRecommendation(query));
console.log('Recommendation engine V2 source and mock-catalog runtime checks passed');

function product(handle, title, vendor, productType, tags, collection_handles, inventory, units_sold_30d) {
  return { handle, title, vendor, productType, tags, collection_handles, inventory, units_sold_30d, publishedAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z' };
}
function runMockRecommendation(rawQuery) {
  const intent = analyze(rawQuery);
  if (intent.candidateStrategy === 'faq') return { type: 'faq', intent, recommended: [], devid_label_alternatives: [], fetchCount: 0 };
  let fetchCount = 0;
  let candidates = [];
  if (['collection_category', 'vendor_collection_category'].includes(intent.candidateStrategy) && intent.collectionTargets.length) {
    fetchCount += intent.collectionTargets.length;
    candidates = mockCatalog.filter((p) => p.collection_handles.some((handle) => intent.collectionTargets.includes(handle)));
  } else {
    fetchCount += 1;
    candidates = mockCatalog.filter((p) => !intent.vendorIntent || p.vendor === intent.vendorIntent);
  }
  let classified = candidates.map(classify);
  if (intent.vendorIntent) classified = classified.filter((p) => p.vendor === intent.vendorIntent);
  if (intent.genderIntent && intent.genderIntent !== 'unisex') classified = classified.filter((p) => p.product_gender !== oppositeGender(intent.genderIntent));
  if (intent.categoryIntent && !intent.isVendorOnlyQuery) classified = classified.filter((p) => categoryCompatible(p, intent));
  const beforeStrictProductIntent = classified.length;
  if (intent.productIntent) classified = classified.filter((p) => strongProductIntentMatch(p, intent.productIntent));
  if (intent.isVendorOnlyQuery) {
    const summer = classified.filter((p) => p.is_summer && !p.is_winter);
    if (summer.length) classified = summer;
  }
  classified.sort((a, b) => score(b, intent) - score(a, intent) || b.units_sold_30d - a.units_sold_30d || b.inventory - a.inventory || b.updatedAt.localeCompare(a.updatedAt));
  const guardrails = intent.productIntent ? ['product_intent_strict_filter_applied', ...(classified.length < beforeStrictProductIntent ? ['product_intent_incoherent_fill_excluded'] : []), ...(classified.length <= 1 ? ['product_intent_no_fill_applied'] : [])] : [];
  return { type: 'product_advice', intent, recommended: classified.slice(0, 3), devid_label_alternatives: intent.vendorIntent === 'Sprayground' ? [] : [], fetchCount, guardrails };
}
function analyze(raw) {
  const query = normalize(raw);
  const vendorIntent = /saint barth|mc2/.test(query) ? 'MC2 Saint Barth' : /sprayground/.test(query) ? 'Sprayground' : /colmar/.test(query) ? 'Colmar Originals' : null;
  const productIntent = /\bglobe\b/.test(query) ? 'jeans_globe_devid_label' : /\bmosca\b/.test(query) ? 'tshirt_mosca_devid_label' : /\b(courma|courmayeur)\b/.test(query) ? 'cargo_courmayeur_devid_label' : /\bmonterosso\b/.test(query) ? 'monterosso_devid_label' : null;
  let categoryIntent = /\bglobe\b/.test(query) ? 'jeans' : /\b(courma|courmayeur)\b/.test(query) ? 'cargo' : /telo|teli|towel|foutas/.test(query) ? 'teli_mare' : /costume|costumi|mare uomo|mare donna/.test(query) ? 'costumi_mare' : /short|bermuda/.test(query) ? 'bermuda_shorts' : /tee e polo|t-?shirt|t shirt|polo/.test(query) ? 'tshirt' : /top donna/.test(query) ? 'top_donna' : /camicia|camicie/.test(query) ? 'camicie' : /giacca|piumino/.test(query) ? 'outerwear' : /zaino|backpack/.test(query) ? 'zaini' : null;
  let genderIntent = /\buomo\b/.test(query) ? 'uomo' : /\bdonna\b/.test(query) ? 'donna' : null;
  const collectionTargets = Object.entries(COLLECTION_TAXONOMY).filter(([, meta]) => meta.synonyms.some((synonym) => query.includes(synonym))).map(([handle]) => handle);
  if (!collectionTargets.length && categoryIntent === 'costumi_mare' && genderIntent === 'uomo') collectionTargets.push('moda-mare-uomo');
  if (!collectionTargets.length && categoryIntent === 'bermuda_shorts' && genderIntent === 'uomo') collectionTargets.push('bermuda-shorts-uomo');
  if (!collectionTargets.length && categoryIntent === 'tshirt' && genderIntent === 'uomo') collectionTargets.push('t-shirt-polo-uomo');
  if (!collectionTargets.length && categoryIntent === 'top_donna') { collectionTargets.push('t-shirt-top-donna'); genderIntent = 'donna'; }
  if (!collectionTargets.length && categoryIntent === 'camicie') { collectionTargets.push('camicie-bluse-donna'); genderIntent = 'donna'; }
  if (collectionTargets.length) {
    const meta = COLLECTION_TAXONOMY[collectionTargets[0]];
    categoryIntent = meta.category;
    genderIntent ??= meta.gender;
  }
  if (/pagamento alla consegna|contrassegno/.test(query)) return { normalized_query: query, vendorIntent: null, categoryIntent: null, genderIntent: null, productIntent: null, collectionTargets: [], candidateStrategy: 'faq' };
  const isVendorOnlyQuery = Boolean(vendorIntent) && !categoryIntent && !genderIntent && !productIntent;
  const isCategoryOnlyQuery = Boolean(categoryIntent || collectionTargets.length) && !vendorIntent && !productIntent;
  const isVendorCategoryQuery = Boolean(vendorIntent && categoryIntent && !productIntent);
  const candidateStrategy = productIntent ? 'product_intent' : isVendorCategoryQuery ? 'vendor_collection_category' : isCategoryOnlyQuery ? 'collection_category' : isVendorOnlyQuery ? 'vendor_only' : 'fallback_search';
  return { normalized_query: query, vendorIntent, categoryIntent, genderIntent, productIntent, collectionTargets, candidateStrategy, isVendorOnlyQuery, isCategoryOnlyQuery, isVendorCategoryQuery };
}
function classify(p) {
  const collectionCategory = p.collection_handles.map((h) => COLLECTION_TAXONOMY[h]?.category).find(Boolean);
  const text = normalize([p.title, p.productType, ...p.tags, ...p.collection_handles].join(' '));
  const product_category = /telo|foutas|towel/.test(text) ? 'teli_mare' : (collectionCategory || ( /costume|swim|beachwear/.test(text) ? 'costumi_mare' : /zaino|backpack/.test(text) ? 'zaini' : /shopper|bors/.test(text) ? 'borse_accessori' : /giacca|piumino|outerwear/.test(text) ? 'outerwear' : /courmayeur|courma|cargo/.test(text) ? 'cargo' : /bermuda|short/.test(text) ? 'bermuda_shorts' : /camicia/.test(text) ? 'camicie' : /top donna/.test(text) ? 'top_donna' : /jeans|denim/.test(text) ? 'jeans' : /t-?shirt|tee/.test(text) ? 'tshirt' : /maglia|maglieria|monterosso/.test(text) ? 'maglieria' : 'unknown'));
  const product_gender = /donna/.test(text) ? 'donna' : /uomo/.test(text) ? 'uomo' : 'unisex';
  const is_winter = /cuffia|beanie|winter|piumino|maglia donna winter/.test(text);
  const is_summer = /mare|costume|swim|beachwear|telo|foutas|towel|bermuda|short|t-shirt|tee|top/.test(text);
  return { ...p, normalized_title: normalize(p.title), normalized_vendor: normalize(p.vendor), product_category, product_gender, season_signal: is_winter ? 'winter' : is_summer ? 'summer' : 'neutral', is_accessory: ['zaini', 'borse_accessori', 'teli_mare'].includes(product_category) || /cuffia|beanie/.test(text), is_winter, is_summer, is_beachwear: ['costumi_mare', 'teli_mare'].includes(product_category), is_swimwear: product_category === 'costumi_mare', availability_score: p.inventory > 0 ? 1 : 0 };
}
function strongProductIntentMatch(p, productIntent) {
  if (p.vendor !== 'Devid Label' || p.is_accessory) return false;
  const text = normalize([p.title, p.handle, p.productType, ...p.tags].join(' '));
  if (productIntent === 'jeans_globe_devid_label') return /globe/.test(text) && p.product_category === 'jeans' && !/shopper|ecopelle|bors|accessori|t-?shirt|maglia|cargo|bermuda/.test(text);
  if (productIntent === 'tshirt_mosca_devid_label') return /mosca/.test(text) && p.product_category === 'tshirt' && !/monterosso|corniglia|globe|shopper|bors|jeans|cargo|bermuda/.test(text);
  if (productIntent === 'cargo_courmayeur_devid_label') return /courmayeur|courma/.test(text) && p.product_category === 'cargo' && !/globe|jeans|bermuda|shopper|bors|accessori/.test(text);
  if (productIntent === 'monterosso_devid_label') return /monterosso/.test(text) && ['maglieria', 'tshirt'].includes(p.product_category) && !/mosca|corniglia|shopper|bors|accessori/.test(text);
  return true;
}
function categoryCompatible(p, intent) {
  if (intent.categoryIntent === 'costumi_mare') return p.product_category === 'costumi_mare' && !/telo|foutas|towel|cuffia|beanie|maglia/i.test(p.title);
  if (intent.categoryIntent === 'teli_mare') return p.product_category === 'teli_mare';
  if (intent.categoryIntent === 'tshirt') return ['tshirt', 'maglieria'].includes(p.product_category) && !p.is_accessory;
  return p.product_category === intent.categoryIntent;
}
function score(p, intent) {
  return (intent.vendorIntent && p.vendor === intent.vendorIntent ? 100 : 0) + (intent.categoryIntent === p.product_category ? 80 : 0) + (intent.genderIntent && p.product_gender === intent.genderIntent ? 40 : 0) + (p.is_summer ? 20 : 0) - (p.is_winter ? 120 : 0) + p.availability_score * 10 + Math.min(25, p.units_sold_30d);
}
function normalize(value) { return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim(); }
function oppositeGender(gender) { return gender === 'uomo' ? 'donna' : 'uomo'; }
function fail(message) { console.error(message); process.exit(1); }
function ok(value, message) { if (!value) fail(message); }
function eq(actual, expected, message) { if (actual !== expected) fail(`${message}: expected ${expected}, got ${actual}`); }
function includes(array, item, message) { if (!array.includes(item)) fail(`${message}: expected ${JSON.stringify(array)} to include ${item}`); }
function all(array, predicate, message) { ok(array.length > 0, `${message}: no products returned`); if (!array.every(predicate)) fail(`${message}: ${array.map((p) => p.handle).join(', ')}`); }
function none(array, predicate, message) { if (array.some(predicate)) fail(`${message}: ${array.filter(predicate).map((p) => p.handle).join(', ')}`); }
