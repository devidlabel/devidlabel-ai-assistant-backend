# Grace & Mila — 17 Amazon IT existing offers with GPSR 100632 + catalog mismatch 8541

**Evidence date:** 24 October 2026. **Scope:** 17 matched exact seller SKU/ASIN Shopify ACTIVE stock positive, all Amazon non-BUYABLE. **Do not create or relink ASIN without official GTIN proof.** None of these 17 is a GPSR-only offer.

## Specific source-backed inconsistencies

1. **FW2617049 AUBE — 8 sizes across ECRU and NOIR.** Shopify model name is `Aube`, and the brand's [official FW26 lookbook](https://book.graceandmila.com/) calls this `FW2617049 - AUBE`, while Amazon Catalog Items titles read `Alba` for these ASINs. Official lookbook confirms product is a long-sleeve stretch-lace top. The listing's `8541` wording signals catalog identity but does **not** identify the exact offending attribute; AUBE/ALBA is a documented discrepancy requiring catalog clarification.
2. **FW2617008 SALVADOR — 6 SKUs, CHOCOLAT/SABLE.** Shopify models use sizes `0,1,2`; the official [Grace & Mila size guide](https://www.graceandmila.com/en/pages/size-guide) defines the size equivalents `0=XS/S`, `1=S/M`, `2=M/L`, `3=L/XL`. Amazon Catalog titles currently show `3XS` for size `0` and `XS` for both `1` and `2`: misleading or collapsed labels. Compare underlying size attributes in Seller Central, not just the title string, and correct via authoritative product facts.
3. **FW2617021 AIMOND — 3 SKUs MARINE.** Shopify model name is `Aimond`, Amazon titles use `Amond`. Official product naming should be reconfirmed from brand seasonal line sheet/label. Here too numerical sizes `0/1/2` are shown as `3XS/XS/XS` in Amazon titles, conflicting with the official numeric size equivalents above.

## Exact SKU-level worklist

[CSV: 17 Shopify seller SKUs / Amazon ASIN / EAN / current product titles / size display / issues](grace-mila-17-8541-catalog-reconciliation.csv).

The live seller listing and catalog ASIN were read for every one of these SKUs. Sample exact EAN→ASIN lookups on EAN 3701147455094, 3701147459696 and 3701147459702 also matched current seller ASINs. **Do not generalize these three exact EAN lookup confirmations to the other fourteen without new Catalog API checks.**

## Execution order

- **Step A, avoid false availability:** Keep current offers intact and respect existing Channable owner for price, quantity and orders.
- **Step B, correct catalog identity before activating:** For each EAN/ASIN, verify label GTIN, official FW26 lookbook model and brand numeric size chart. Open a grouped Amazon Catalog Support case explaining erroneous model text and size conversion; provide exact affected ASINs/EANs. Do not amend Shopify's already-correct SKU or size to match incorrect Amazon titles.
- **Step C, compliance:** Resolve `100632` GPSR against verified manufacturer/responsible-person documentation and account approvals (not guessed values); it may be independent of `8541`.
- **Step D, confirmation:** After Amazon fixes or accepts attribute corrections, read back the seller listing: `8541` and `100632` absent, each SKU BUYABLE with the correct ASIN and stock. No completion without buyability.

**No listing, catalog, Shopify, Channable, GPSR contact or price mutation performed in this dossier.** The documentation establishes discrepancies, not definitive root-cause attribution for Amazon error 8541. Kangol and the two unrelated Sprayground catalog mismatches are excluded.
