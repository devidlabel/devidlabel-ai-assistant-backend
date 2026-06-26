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
