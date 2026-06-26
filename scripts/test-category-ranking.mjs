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
];
for (const [name, pattern] of checks) {
  if (!pattern.test(source)) {
    console.error(`${name}: expected source pattern was not found`);
    process.exit(1);
  }
}
console.log('Category-aware ranking source checks passed');
