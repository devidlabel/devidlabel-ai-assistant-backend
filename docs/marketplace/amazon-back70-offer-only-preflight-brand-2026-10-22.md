# Amazon EU Offer Only — Brand display-name consistency, 22 October 2026

## Verified business requirement

Shopify vendor **Back70** must be represented in Amazon as **Back 70 Streetwear**, while Shopify vendor remains untouched. Similarly Amazon brand display name **County Of Milan** is the merchant-confirmed canonical name; these mappings were already implemented in `src/marketplace-amazon-listing-brand.ts`.

The separate `src/mare-business-amazon-offer-preflight.ts` previously compared the raw Shopify vendor directly with the Amazon Catalog Items brand. That rejected a valid `Back70` ↔ `Back 70 Streetwear` display-name mapping before all other guarded checks. The new patch reuses **the existing, narrowly confirmed brand resolver** and continues to require exact Amazon Catalog brand match to its canonical name. It does not invent or fuzzy-match new aliases.

## Safeguards

- A brand spelling reconciliation is **not** Amazon brand approval, distribution authorization, product authenticity, legal GPSR compliance or an instruction to publish.
- `brand_eligibility_proven=false`, `read_only=true`, `has_created_offer=false`, `live_listing_write_enabled=false`. A downstream absence of Listings Restrictions alone still does not establish seller approval.
- Unknown Shopify vendors continue to compare literally, under `SHOPIFY_VENDOR_UNVERIFIED`; an unrelated Amazon brand is always blocked.
- Exact EAN↔ASIN match, Shopify ACTIVE/stock/tracked inventory, complete duplicate SKU/barcode checks, seller-SKU absence, independent seller-ASIN alternate-SKU scan, restrictions, PTD schema and Channable writer isolation requirements remain intact.
- No Shopify vendor/frontend modification; no Amazon listing, quantity, price, shipment, Seller Central approval or support case mutation.
- Regression tests in `scripts/test-amazon-offer-preflight.mjs`: Back70 alias, County Of Milan canonical, unchanged vendor and unrelated-brand / wrong spelling rejection. These are synthetic mocks, not live authorization.

## Release

After merge, verify CI plus Cloudflare Worker deploy and retain PR #263 as DRAFT/OFF. This only removes a false brand-name incompatibility in the merchant-private **READ_ONLY preflight**, and does not authorize canary live PUT or Channable handoff.

For real-world Back70 scope: issue #255 contains 17 IT EAN-no-exact-match SKU needing supplier/brand catalog investigation, plus 3 BUYABLE; an offer-only preflight cannot create new ASIN for the 17.