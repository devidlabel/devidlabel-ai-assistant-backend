import fs from 'node:fs';

const source = fs.readFileSync('src/shopify-media-seo-bridge.ts', 'utf8');

const required = [
  'shopify_media_seo_request_v1',
  'optimize_product_image_metadata',
  'devid_image_seo_v1',
  'metafield(namespace: "xphub", key: "master_sku")',
  'onlineStoreUrl',
  'status:active',
  'fileUpdate(files: $files)',
  'alt: item.desired_alt, filename: item.desired_filename',
  'image_bytes_modified: false',
  'card_theme_modified: false',
  'published_only: true',
  'Master SKU',
];

for (const needle of required) {
  if (!source.includes(needle)) throw new Error(`Missing Shopify image SEO safety contract: ${needle}`);
}

const mutationMatch = source.match(/const FILE_UPDATE_MUTATION = `([\s\S]*?)`;/);
if (!mutationMatch) throw new Error('FILE_UPDATE_MUTATION not found');
const mutation = mutationMatch[1];
if (/originalSource|previewImageSource|referencesToAdd|referencesToRemove/.test(mutation)) {
  throw new Error('Metadata mutation must not change image bytes or product references');
}

const updateVariablesMatch = source.match(/files:\s*batch\.map\(\(item\) => \(\{([\s\S]*?)\}\)\),/);
if (!updateVariablesMatch) throw new Error('fileUpdate variable mapper not found');
const mapper = updateVariablesMatch[1];
for (const forbidden of ['originalSource', 'previewImageSource', 'referencesToAdd', 'referencesToRemove']) {
  if (mapper.includes(forbidden)) throw new Error(`Forbidden metadata write field: ${forbidden}`);
}

console.log('Shopify image SEO bridge safety contract validated.');
