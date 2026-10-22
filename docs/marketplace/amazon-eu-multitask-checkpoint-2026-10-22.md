# Multi-workstream marketplace checkpoint — 2026-10-22

READ-ONLY Amazon SP-API and VALIDATION_PREVIEW only. Channable remains owner. No Shopify frontend or stock changes. No live offers or support requests.

## Workstream A: 4B12 new-ASIN PTD
Eleven remote VALIDATION_PREVIEW calls on six representative models:
- Hyper D-4006 size 38: 20 issues in IT, DE, FR, ES (same set).
- PlayNew D-2026 size 38: 17 IT.
- PlayNew D-2045 size 38: 17 IT.
- PlayNewSky D-2041 size 38: 17 IT and 17 ES.
- Hyper U-3027 size 41: 17 IT.
- Hyper U-3012 size 41: 17 IT and 17 ES.
All INVALID, can_publish false. The 17 common missing fields:
manufacturer, country_of_origin, sole_material, shaft, strap_type, water_resistance_level, batteries_required, item_package_weight, outer, leather_type, height_map, inner, age_range_description, lifestyle, list_price, item_package_dimensions, style.
D-4006 additionally: closure, model_number, bullet_point. Unlike other samples, D-4006 only submits product_description, not these three; never invent them. Obtain model-level signed supplier evidence for materials, origin, construction, manufacturer, GPSR and compliance; per-size package measurements and by-market signed MSRP. Shopify features.material remains an unresolved reference, not a manufacturer's spec. PTD readiness is documentation- and schema-gated; do not infer readiness from missing count.

## Workstream B: Pro-Keds Italy
25 SKU enumerated in issue #254 and freshly checked via Amazon seller listings and exact EAN Catalog Items in four batches. 25 PRESENT_ATTRIBUTES_UNKNOWN, 25 issue 8566 and 25 issue 8572; 25 NO_EXACT_MATCH EAN. 39 units were Shopify snapshot as of 20 October, not a new stock count. Need manufacturer GTIN-to-brand proof, GS1 data or official letters/photos and Seller Support diagnosis. No SKU or EAN overwrites.

## Workstream C: Back70 Italy
20 SKU from issue #255 independently re-read: 3 exact EAN match and seller BUYABLE; 17 NO_EXACT_MATCH with seller PRESENT_ATTRIBUTES_UNKNOWN. Of the 20 listing GETs, 13 have 101067 and 7 have 5665. The 3 BUYABLE listings also include 5665, so do NOT mark all 5665 as non-buyable. Amazon brand mapping is Back 70 Streetwear; verify brand category and product identity, do not duplicate.

## Workstream D: Mou cross-country 100632
MOU_MUFW531009A_ELGRY_41_EU EAN 8057277369851, ASIN B0FZKLG86S:
IT listing PRESENT, BUYABLE, FBM qty 1, EUR 184.00; DE/FR/ES same SKU/ASIN PRESENT, DISCOVERABLE non-BUYABLE, qty 1, EUR 184.00, 100632 ERROR and 100527 or 100530 warnings.
Listings Restrictions DE/FR/ES: NO_RESTRICTIONS_RETURNED_NOT_APPROVAL_PROOF, no application link. Require account-specific Seller Central support or authorized review, not automatic approval claim. Adjacent sizes 38/39/40 missing verified EAN in Shopify, excluded from creation.

## Release gates
PR #263 remains draft. Never merge/deploy/activate Amazon Offer Only based on these diagnostics. Must have verified Seller Central brand/ASIN approval, manufacturer/GPSR, verified seller SKU state, Channable UI isolation and Amazon readback, durable idempotency, explicit pilot approval.

## Practical next actions
1. Supplier pack for 4B12: nine model technical sheets, 15 missing EAN mappings, signed materials/origin/manufacturer/GPSR, packaging by size, MSRP by country.
2. Seller Central: Fessura ES official approval request (issue #259); Puraai Baileys 41 ES Catalog Items mismatch (issue #256); ask cause of 100632 for 70 other ES existing offers; Mou DE/FR/ES.
3. Pro-Keds IT issue #254 and Back70 IT issue #255: attach provenance evidence through Seller Central, keep invoices out of GitHub.
4. Rerun exact seller GET only after case resolution, close based on verified BUYABLE not API restriction count.
