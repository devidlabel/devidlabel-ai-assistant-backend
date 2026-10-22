# Amazon existing offers 100632 — live read-only triage

New capability: `amazon.existing_offers.qualification_triage.readonly`

## Inputs
```json
{"marketplace":"ES","items":[{"sku":"PUI_101_101_VINTAGE_OSSO_40_EU","ean":"8388780086400"}],"compare_marketplace":"IT"}
```

1–3 sku+EAN-13 pairs with check digit, seller marketplace IT/DE/FR/ES and optional comparison marketplace. Request input keys strictly whitelisted. Requires existing M.A.R.E. Business OS token, Amazon SP-API credentials and seller id; no new permissions.

## Operation

Connects four existing merchant-private **read-only** readers on each invocation:
- Seller Listings GET for presence, ASIN, BUYABLE and errors
- Listings Restrictions (empty array is NEVER approval)
- exact EAN-to-ASIN Catalog Items live match
- Catalog Items ASIN details
- optional comparison-country seller GET to detect same ASIN BUYABLE elsewhere

Does not create an offer or Seller Central application; never writes price, inventory, Shopify, Channable, orders or tracking. Explicit `can_publish:false`, `provider_mutations:0` and `brand_approval_proven:false` returned in all outcomes. Any provider partial result is unknown, not an inferred approval.

Outcome taxonomy:
- `SELLER_CENTRAL_APPROVAL_LINK`: explicit APPROVAL_REQUIRED and URL **strictly** equal to official Seller Central domain + requested ASIN.
- `CATALOG_IDENTITY_ESCALATION`: ASIN_NOT_FOUND, EAN exact lookup missing, or conflicting EAN-ASIN.
- `SELLER_SUPPORT_100632_NO_APPLICATION_LINK`: 100632 in seller GET but zero restrictions from Listings Restrictions, Catalog Items identities both valid.
- `EXISTING_OFFER_BUYABLE`: no duplicate creation or qualification request.
- `SELLER_IDENTITY_DIAGNOSTICS`: seller attributes missing/unverified.
- `NOT_100632_COHORT` and `RECHECK_REQUIRED`.

## Use on current cases

- Fessura ES: `FSA_TRAIL_SBL_07_BLACK-LAND_37_EU` EAN `8050000086452`, ASIN `B0FGQJWZDN`, expected official approval route; listing has separate 18299.
- Puraai ES: `PUI_101_101_VINTAGE_BAILEYS_41_EU` EAN `8056631940620`, seller ASIN `B0HMPHWHXG` but not found in ES catalog while IT catalog exists; expected Catalog Identity Escalation (18146 + 100632).
- Puraai Vintage Osso, 4B12 PlayNew D2031, Flower Mountain Yamabushi: expected Seller Support routing when restrictions empty and EAN/ASIN exact.
- Mou `MOU_MUFW531009A_ELGRY_41_EU`: IT BUYABLE, DE/FR/ES present with 100632 and empty restrictions, no implied approval.

This code is isolated from PR #263 (draft Amazon OFFER_ONLY writer). Merging this **read-only** PR does not merge or activate the writer and does not touch Channable. Production deployment can be independently verified by checking `mare_capabilities`, `mare_describe`, `mare_read`.

Synthetic mocked tests: `npm run test:amazon-existing-offer-qualification-triage`, added to existing marketplace runtime tests. Acceptance criteria: compile, mocked cases pass, CI green, no provider POST/PUT/PATCH/DELETE from new path.
