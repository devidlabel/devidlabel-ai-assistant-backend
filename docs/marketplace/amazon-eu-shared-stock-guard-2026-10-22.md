# Amazon EU shared physical-stock pool guard — 22 October 2026

## Source and observed baseline

Read-only M.A.R.E. Amazon EU inventory shadow on seven Shopify ACTIVE SKUs across IT/DE/FR/ES showed 25 of 28 marketplace/SKU combinations with independently verified FBM quantities. All 25 verified Amazon quantities equalled the corresponding Shopify `available`. Three seller listings for MC2 Saint Barth `MC2_JUDE002 00311E_Taglia unica` were absent from Amazon DE/FR/ES — NOT stock zero, price zero or publication permit.

Sample:
- `MOU_MUFW531009A_ELGRY_41_EU`: 1 Shopify available, 1 FBM in IT/DE/FR/ES, only IT BUYABLE.
- `4B12_PLAYNEW_D2031_38_EU`: 3 Shopify available, 3 FBM per country, IT/DE/FR BUYABLE, ES not BUYABLE.
- `PUI_101_101_VINTAGE_OSSO_40_EU`: 1 Shopify available, 1 FBM per country, ES not BUYABLE.
- `FWM_2019510-05-1L11_37_EU`: 1 Shopify available, 1 FBM per country, ES not BUYABLE.
- `SPR_910B8298NSZ`: 1 Shopify available, 1 FBM per country, none BUYABLE.
- `RNS_15600_COAL`: 3 Shopify available, 3 FBM per country, none BUYABLE.
- `MC2_JUDE002 00311E_Taglia unica`: 1 Shopify available, IT seller present FBM 1, DE/FR/ES seller absent and FBM unknown.

These counts are **marketplace offer views of a shared physical inventory pool**, not independent quantities. **Never** sum 1+1+1+1 as four warehouse items or declare that Channable has proven oversell protection from quantity equality alone.

## New live read-only diagnostic

`amazon.inventory.eu.shared_stock_guard.readonly`, input `{"skus":["MOU_MUFW531009A_ELGRY_41_EU"]}`, max 8 SKUs. Calls the already existing M.A.R.E. `amazon.inventory.eu.shadow.readonly` reader internally. Only derived read-only report; no modifications.

Classifications:
- `MULTI_MARKET_BUYABLE_SHARED_POOL_UNPROVEN`: multiple marketplaces may sell the same Shopify inventory; not proof of active overselling, prompts atomic allocation/reconciliation gate before direct writer.
- `MARKET_QUANTITY_DIFFERENCE_REQUIRES_RULE_REVIEW`: verified Amazon quantity differs from Shopify, but it may be intentional — e.g. weekday Amazon IT zero for Sprayground and MC2 Saint Barth autumn/winter 2026-2027. DO NOT overwrite without verifying specific product season and Channable rule.
- `MARKETPLACE_EVIDENCE_INCOMPLETE`: unknown seller identity/quantity stays unknown, never zero.
- `SHOPIFY_IDENTITY_OR_STOCK_UNKNOWN`: no unique verified Shopify source.
- `QUANTITIES_ALIGNED_NO_WRITER_AUTHORITY`: no recognized stock difference, but does not permit writer.

Every output has `writer_ownership_proven=false`, `atomic_stock_reservation_proven=false`, `safe_for_direct_writer=false`, `provider_mutations=0`; no implied future direct API writer authorization.

## Operational gates

1. Verify existing Channable writer is sole active inventory writer for every SKU/market, including intended seasonal restrictions.
2. Define atomic reservation and stock-delta idempotency for a shared pool that can sell on several channels.
3. Confirm how zero FBM stock is interpreted by business rules before automatic correction; all country-specific exceptions must be explicit.
4. Before any API writer or cutover, prove event-driven inventory reduction, delayed order acknowledgment handling, rollback and drift reconciliation under concurrency.
5. Never change Shopify frontend, customer-facing product content or prices as part of this diagnostic.

Tests: `npm run test:amazon-eu-shared-stock-guard` plus full marketplace runtime CI, with synthetic aligned, drift, absent, unknown, invalid and provider failure cases.
