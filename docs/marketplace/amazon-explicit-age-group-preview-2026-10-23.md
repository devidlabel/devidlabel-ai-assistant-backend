# Amazon SHOES: explicit Shopify adult age metadata in validation preview — 23 October 2026

## Live evidence and scope
Shopify Admin read-only on Back70 SKU `BK70_108051-000016_38_EU` confirmed the `mm-google-shopping.age_group` variant metafield is an explicit `single_line_text_field` with value `adult`. The Shopify `mm-google-shopping.mpn` is the **full merchant SKU** and is therefore **not** promoted to manufacturer `model_number`.

A narrowly bounded change to existing merchant-private reader adds `googleAgeGroup` and returns `age_range_description: adult` **only** if the field type and value are exact. No assumptions for missing, kids, mixed or differently cased values. The preview assembler maps that merchant-declared value to IT `Adulto`, DE `Erwachsene`, FR `Adulte`, ES `Adulto`, with explicit marketplace and locale, in the existing Amazon SHOES `VALIDATION_PREVIEW` PUT only.

## Safety
- Merchandising evidence, NOT manufacturer verification, GPSR assurance, age restriction certification, seller authorization or publishing approval.
- Does not use or manufacture an MPN/model number; marketing descriptions are unchanged.
- Existing strict seller SKU absence, catalog EAN no-exact-match, title/vendor identity checks and PTD gating remain unchanged.
- Amazon API mode is permanently `VALIDATION_PREVIEW`; no live ASIN, stock, price, Channable writer ownership or Shopify storefront/theme mutation.
- Test strict adult positive, negative field values/types, rendered German value and privacy-only output. CI verification required.

## Baseline and expected check
Back70 `BK70_108051-000016_38_EU` generated 20 missing-attribute issues in **DE** and **ES** on 23 October before this patch. After deploying, re-run the same read-only cohort and compare issue codes. Do NOT claim the issue decreases until Amazon returns evidence; an invalid or linguistically unsupported age value must remain blocked. 4B12 PlayNew D-2026 remains 17 issues and Puraai Panther Caramel ES remains 20 in the same session.
