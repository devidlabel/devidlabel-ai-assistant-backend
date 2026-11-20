# K-Way Amazon EU - checkpoint 2026-11-01

## Source and safety
- Shopify full catalog artifact: mba_1a024e5d-4d5a-4350-9a4b-8636a940c266 (generated 2026-10-31)
- 511 Shopify products, 1,254 variants; ACTIVE positive stock = 328 (326 valid EAN, 2 without barcode)
- Amazon IT exact EAN lookup repeated 2026-11-01: 170 EXACT_ONE and 156 NO_EXACT_MATCH.
- Amazon IT direct seller listings checked for all 328 positive-stock variants in batches <=8: 167 BUYABLE, 2 present non-BUYABLE, 158 VERIFIED_ABSENT under exact seller SKU, 1 PRESENT_ATTRIBUTES_UNKNOWN. All previously 43 rate-limited unknowns rechecked.
- The 170 exact matched EANs: 167 BUYABLE, 2 non-BUYABLE, 1 PRESENT_ATTRIBUTES_UNKNOWN, 0 VERIFIED_ABSENT. Do not create duplicate offers for them.
- KWAY_K8133EW_AL9_S (EAN 8051781376015, ASIN B0F8J8T8T3), KWAY_K2136FW_USY_M (EAN 8056072231943, ASIN B0FVMKZQGM): both non-BUYABLE, qualification code 100632, seller-support action required; no official application link returned.
- KWAY_K6116IW_WMR (EAN 8054936908130): PRESENT_ATTRIBUTES_UNKNOWN; do not treat as absent.
- Inactive report 258804020757 (2026-10-31) independently read; historical report alone does not establish current seller status.
- New ASIN previews: KWAY_K6133HW_USY_S SWEATSHIRT INVALID with 15 missing-attribute errors; KWAY_K7127JW_V15_L COAT INVALID with 18; KWAY_K1125BW_896_L SHIRT INVALID with 17. Preview-only, no creation.
- European sample: 8 high-priority SKUs BUYABLE in each IT/DE/FR/ES; KWAY_K8133EW_AL9_S BUYABLE FR but not IT and absent under exact SKU in DE, ES. DE/ES EAN exact lookup does not match; no automatic OFFER_ONLY approval. Other countries not fully audited.
- No Amazon listing, Shopify, pricing, inventory or Channable mutations performed in this audit.

## Files
- it-audit-001-080.csv: first 80 stock-descending ACTIVE-positive SKU direct seller observations. This file is a PARTIAL matrix; do not mistake it for a complete SKU-by-SKU export.

## Next operational batch
1. Persist remaining SKU-level matrix for 248 variants using same stable source ordering, including verification timestamp and issue codes.
2. Reconcile 158 seller-absent SKUs with the 156 no-match EANs and 2 without EAN; do not infer no historical SKU or ASIN from exact EAN absence alone.
3. Obtain source-backed K-Way PTD data (manufacturer, origin, composition, care, packaging, regulated claims, GPSR) and validate genuine new ASIN payloads. No guessed compliance data.
4. Contact Seller Support for the two 100632 qualification restrictions; do not mutate price or stock.
5. Expand same reconciliation independently to DE/FR/ES. New creation strictly quantity=0 after validation and fresh identity checks.

## Continued execution - 2026-11-01 (verified after checkpoint)
- Complete SKU-level matrix is now saved as `amazon-it-complete-328.csv`, plus five consecutive IT source batches covering all 328 stock-positive variants. Exact seller classification remained 167 BUYABLE / 2 PRESENT_NON_BUYABLE / 158 exact-SKU VERIFIED_ABSENT / 1 PRESENT_ATTRIBUTES_UNKNOWN.
- Three-market direct seller checks of the 170 IT EAN-exact ASIN candidates are saved as `eu-existing-asin-001-064.csv`, `065-128.csv`, and `129-170.csv`. Observed BUYABLE: DE 164, FR 167, ES 163. Their other market/SKU states are listed in the files; this is not a full EU audit of all 328.
- **All 156 IT no-exact-EAN candidates were searched by the SAME validated EAN on DE, FR and ES** in seven logged files `eu-no-it-ean-001-024.csv` through `eu-no-it-ean-145-156.csv`: 468 verified additional lookup results, all NO_EXACT_MATCH. No verified EAN exact offer-creation path was found for this cohort. This does not prove absolute ASIN absence or rule out historical seller SKUs with different identifiers.
- Direct Shopify Admin GraphQL queries for 156 corresponding variant inventory items found **countryCodeOfOrigin missing for all 156**. Source table: `new-asin-156-shopify-origin-source.csv`. Historical Drive workbook K-Way FW26 COMPLETO Matrixify FINAL ColorVariants (1).xlsx (August 2026) also contains zero populated Variant Country of Origin values; historical import not an alternative official origin proof.
- Direct Shopify Admin GraphQL metafield presence: all 156 have marketplace model, 150 have product color metaobject references, 156 have material metaobject references (the demonstrated reference is generic MIXED and **not a true percentage composition**), 156 have department references, 146 have variant age_group and gender, 0 have `custom.amazon_product_attributes`, 0 have `marketplace.fabric_composition`, 0 have `marketplace.bullet_points`. Source table: `new-asin-156-shopify-metafield-source.csv`.
- New-ASIN candidate pool grouped into **59 style/color model cohorts**, with product-type categories marked only as candidates: `new-asin-156-model-cohorts.csv`. Among them 115 jackets/coats, 24 fleeces/sweatshirts, 6 knitwear and 11 other variants.
- Specific official K-Way material layers and care instructions verified for **17 stock-positive variants** of Sixte 4.0 Orsetto (USY/B0A) and Le Vrai 4.0 Aurele Heavy Warm (USY/WMR). Exact authoritative official URLs and layer-specific details stored in `kway-official-product-evidence-selected.csv`. Do **not** collapse multi-layer composition into a fictitious single 100% fabric type; country of origin and manufacturer remain unverified.
- Seller Support escalation drafts prepared for 100632 failures: `seller-support-100632-kway.md`; no cases submitted.
- No Amazon live ASIN creations, Amazon/Shopify price or stock writes, or Channable changes were made in this continuation. Existing-ASIN OFFER_ONLY batch capability is configured but there are **zero** verified local exact-EAN + absent-seller candidates in the 170 IT cohort; EU missed-SKU candidates also lacked the required local EAN match.

## Next constrained execution
1. Obtain source-backed country of manufacture, manufacturer/operator evidence, package spec and hazard/safety attestation for 59 cohorts, prioritize Sixte and Aurele with official manufacturer-page technical facts already verified. Official product descriptions do **not** establish manufacturing country or account-level GPSR authorization.
2. Map each model to validated Amazon Product Type Definition and populate the approved structured evidence only when evidence supports the literal value; use Amazon VALIDATION_PREVIEW to close each error group before any live request.
3. On preview VALID and independent brand/catalog identity/Channable-writer checks, enable a K-Way-specific fail-closed new-ASIN live capability (the current Refrigiwear pilot is brand scoped) and submit zero stock only. Existing offer writer is not the generic creation route.
4. Open Seller Support cases with the prepared drafts in Seller Central (no connected case-submission API) and record case numbers/decision before changes.
5. Independently reconcile historical seller SKUs and alternative identifiers for the 156, because NO_EXACT_MATCH does not prove ASIN does not exist.
