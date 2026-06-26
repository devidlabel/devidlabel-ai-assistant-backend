import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const checks = [
  ['commerce query analyzer exists', /function analyzeCommerceQuery\(/],
  ['deterministic vendor aliases include Saint Barth typo', /san bat/],
  ['Sprayground typo supported', /sprygrund/],
  ['Colmar Originals supported', /Colmar Originals/],
  ['category keywords include towel category', /teli_mare[\s\S]*towel/],
  ['gender detection includes uomo', /uomo\|man\|male\|men\|maschile/],
  ['category compatibility denies beach towels for tshirt', /tshirt:[\s\S]*deny:[\s\S]*teli_mare/],
  ['coherence score sorts before sales', /sort\(\(a, b\) => b\.coherenceScore - a\.coherenceScore/],
  ['GraphQL fetches collections', /collections\(first: 10\)/],
  ['fallback guardrail for no sales remains', /shopify_recommendations_no_recent_sales_fallback/],
  ['commerce intent is exposed without sensitive fields', /commerce_intent/],
  ['hard category compatibility function exists', /function isProductCommerciallyCompatible\(/],
  ['hard category filter runs before final ranking', /hard_category_filter_applied[\s\S]*isProductCommerciallyCompatible/],
  ['incompatible products are excluded, not only penalized', /incompatible_category_excluded[\s\S]*filter\(\(product\) => isProductCommerciallyCompatible/],
  ['medium fallback is controlled', /medium_category_fallback_used/],
  ['no compatible products guardrail exists', /no_compatible_products_found/],
  ['accessory detection catches hats bags towels', /cuffia\|cappello\|cap\|hat\|beanie\|shopper\|borsa[\s\S]*telo\|towel\|foutas/],
  ['tshirt Saint Barth excludes accessories and beach categories', /tshirt:[\s\S]*deny:[\s\S]*costumi_mare[\s\S]*borse_accessori/],
  ['costume Saint Barth excludes accessories and upper apparel', /costumi_mare:[\s\S]*deny:[\s\S]*tshirt[\s\S]*polo[\s\S]*borse_accessori/],
  ['telo mare admits towel/foutas category', /teli_mare: \["telo", "teli", "towel", "foutas"/],
  ['vendor-only bypasses hard category filtering', /isVendorOnlyQuery\) return true/],
  ['forced product intent helper exists', /function getForcedProductForIntent\(/],
  ['forced product intent is applied as first result', /return \[forced, \.\.\.products\.filter/],
  ['globe forced matcher targets Devid Label product', /jeans_globe_devid_label:[\s\S]*jeans\\s\+globe\|globe/],
  ['mosca forced matcher targets t-shirt product', /tshirt_mosca_devid_label:[\s\S]*mosca/],
  ['colmar vendor-only intent remains supported', /colmar originals", aliases: \["colmar originals", "colmar"\]/i],
  ['strict swimwear guardrail exists', /strict_swimwear_filter_applied/],
  ['no strong swimwear guardrail exists', /no_strong_swimwear_products_found/],
  ['strict product intent guardrail exists', /strict_product_intent_filter_applied/],
  ['strict filters avoid filling incoherent recommendations', /recommendations_not_filled_due_to_strict_filter/],
  ['swimwear rejects upper apparel fallback', /function isExplicitlyDeniedSwimwearFallback[\s\S]*maglia[\s\S]*t-shirt[\s\S]*polo/],
  ['swimwear medium shorts require beach or swim signal', /function hasMediumSwimwearSignal[\s\S]*bermuda[\s\S]*mare[\s\S]*swim/],
  ['costume Saint Barth corrected query remains specific', /mare_uomo: \{ correctedQuery: "mc2 saint barth costume uomo"/],
  ['outerwear Colmar category remains supported', /outerwear: \["giacca", "giacche", "giubbino", "piumino", "smanicato", "jacket", "outerwear"\]/],
];
for (const [name, pattern] of checks) {
  if (!pattern.test(source)) {
    console.error(`${name}: expected source pattern was not found`);
    process.exit(1);
  }
}
console.log('Category-aware ranking source checks passed');
