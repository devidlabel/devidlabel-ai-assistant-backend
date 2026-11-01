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
