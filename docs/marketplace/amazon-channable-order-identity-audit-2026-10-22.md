# Amazon↔Channable Shopify order identity audit — 22 October 2026

## Observed production baseline

Period: Amazon lastUpdated 2026-10-19T00:00:00Z to 2026-10-21T23:59:00Z; Shopify order CREATED window same calendar boundaries. The two time dimensions are deliberately NOT interchangeable.

From live authenticated read-only M.A.R.E. OS:
- Amazon FBM Orders API: **19** unique account+order IDs, one complete page. **One zero-quantity order line** must not be interpreted as refund, cancellation or permission to restock.
- Shopify Channable signature: **15** Amazon-imported orders, one complete page, zero unverified.
- Join by **exact Amazon order ID**, never by SKU, value, market or timestamp: **11** positive identity matches.
- Amazon observed but not in selected Shopify create window: **8**. Every one of the eight has `created_at` BEFORE 19 Oct, although its lastUpdated timestamp was within the Amazon observation window. They are OUT-OF-WINDOW, NOT proven missing imports.
- Shopify observed but not in Amazon lastUpdated window: **4**. They are not evidence of unexpected import: Amazon could have last-updated outside the chosen period.

## New merchant-private read-only M.A.R.E. capability

`amazon.orders.channable_identity_audit.readonly` accepts:
```json
{
  "marketplaces":["IT","DE","FR","ES"],
  "amazon_updated_after":"2026-10-19T00:00:00Z",
  "amazon_updated_before":"2026-10-21T23:59:00Z",
  "shopify_created_after":"2026-10-19T00:00:00Z",
  "shopify_created_before":"2026-10-21T23:59:00Z",
  "amazon_max_pages":3,
  "shopify_max_pages":5
}
```

Uses the already connected Orders v2026-01-01 read-only reader and Channable-imported Shopify order signature read-only reader, with bounded pagination. Fails closed for duplicate/malformed Amazon or Shopify IDs and partial observations. **Returns aggregate counts ONLY** — no order IDs, buyer/address/payment details, tracking numbers, variant SKUs, customer attributes. The API response permanently states `current_importer_owner=CHANNABLE`, `missing_imports_proven=false`, `shopify_order_creation_authorized=false`, `provider_mutations=0`, `can_advance_order_import_cursor=false`.

A complete window cannot prove an order absent from every other time window, nor prove Channable has relinquished writer ownership. The API is for **diagnosis, not order creation**.

## Release gate

No provider writes in implementation or tests. Roll out separately from draft Amazon Offer Only PR #263; do not activate alternative order importer, shipment writer or stock mutations. Verification after deployment: `mare_describe` capability available, run live `mare_read` with exact windows above, compare aggregate 19/15/11/8/4, then expand windows and reconcile unverified without making negative absence claims.

This is an input to eventual Channable-to-direct-Amazon shadow handoff, not handoff authorization.
