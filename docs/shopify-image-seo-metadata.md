# Shopify product image SEO metadata

This operation optimizes metadata on existing Shopify product `MediaImage` files without changing image bytes, dimensions, crop, focal point, product references, media order or storefront theme/card rendering.

## Policy `devid_image_seo_v1`

Scope:
- product status must be `ACTIVE`;
- product must currently expose an `onlineStoreUrl`;
- product must have the canonical `xphub.master_sku` metafield;
- media must be an existing `IMAGE` in `READY` state.

Filename:
`<vendor>-<product-title>-<master-sku>-foto-<NN>.<original-extension>`

ALT:
- first image: `<Vendor> <Product Title> – vista principale – Master SKU <MASTER SKU>`
- subsequent images: `<Vendor> <Product Title> – dettaglio prodotto <N> – Master SKU <MASTER SKU>`

The product title is the canonical Shopify title and therefore carries the color/variant wording when the catalog product title contains it. Master SKU is always read from `xphub.master_sku`; it is never inferred from a variant SKU.

## Safety

The bridge accepts only a request file committed under `ops/shopify-media-seo-requests/` on the repository `main` branch. It rejects arbitrary policies and scopes. The Shopify `fileUpdate` input is constructed only with `id`, `alt`, and `filename`.

The operation never sends `originalSource`, `previewImageSource`, `referencesToAdd`, or `referencesToRemove` and never modifies storefront theme files.

Use `mode: dry_run` before `mode: execute` to inspect counts and samples without any Shopify write.
