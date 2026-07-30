# Shopify ADV Reporting API — Devid Label / MARE Commerce OS

## Purpose

This module turns the existing Shopify Admin GraphQL connection into a read-only commerce reporting source for the ADV/data platform.

It is deliberately separate from the customer-facing assistant contract even though it reuses the same encrypted Shopify OAuth token already stored in Cloudflare KV.

Primary uses:

- Shopify revenue as the commerce source of truth;
- orders and line items without customer PII;
- product / variant / vendor / product type joins;
- current inventory cost coverage for COGS analysis;
- source and status breakdowns;
- historical backfill through Shopify Bulk Operations;
- daily snapshots that can later be joined with Google Ads, Meta, TikTok, GA4 and Klaviyo.

## Security model

The reporting bridge is server-side only.

- Shopify Admin token remains resolved by the existing OAuth + encrypted KV implementation.
- `SHOPIFY_REPORT_ACCESS_TOKEN` protects every data-bearing reporting route.
- `/internal/shopify/health` is public but returns configuration booleans only.
- no customer name, email, phone, address, customer ID, order number, discount code or payment data is queried or returned;
- Shopify order GIDs are not returned; the report emits a short SHA-256 `order_key` instead;
- responses use `Cache-Control: no-store`.

## Cloudflare configuration

Required for reporting routes:

- existing `SHOPIFY_SHOP_DOMAIN`;
- existing Shopify OAuth/KV token configuration;
- `SHOPIFY_REPORT_ACCESS_TOKEN` — long random bearer token used only for internal Shopify reporting.

Optional:

- `COMMERCE_TENANT_ID` — stable tenant/store identifier for normalized output, e.g. a Commerce OS tenant ID. Do not use a domain as the platform-level primary key.

Never commit secret values to GitHub or `wrangler.toml`.

## Shopify scopes

Recent reporting requires the scopes already used by the assistant:

- `read_orders`
- `read_products`
- `read_inventory` (or product access sufficient for InventoryItem reads)

Historical order access beyond Shopify's default recent-order window additionally requires:

- `read_all_orders`

`read_all_orders` must first be approved for the app and then granted to the installed OAuth token. The reporting API checks granted scopes at runtime and refuses an older backfill with `read_all_orders_required` rather than silently returning an incomplete period.

`InventoryItem.unitCost` also depends on the staff/app context being allowed to view product costs. If unit cost is not available, order reporting remains usable and returns a cost-coverage warning instead of failing the full commerce report.

## Routes

### Health

`GET /internal/shopify/health`

No bearer required. Returns only configuration/capability booleans.

### Granted scopes

`GET /internal/shopify/scopes`

Requires:

`Authorization: Bearer <SHOPIFY_REPORT_ACCESS_TOKEN>`

Returns the actual OAuth scopes granted to the installed app and explicit capability checks for recent orders, historical orders, products and inventory.

### Normalized order report

`GET /internal/shopify/report`

Requires bearer auth.

Supported windows:

- `?timeframe=yesterday`
- `?timeframe=last_7_days`
- `?timeframe=last_14_days`
- `?timeframe=month_to_yesterday`
- `?timeframe=custom&start=YYYY-MM-DD&end=YYYY-MM-DD`

The synchronous normalized report is capped at 31 days. Larger/historical exports use Bulk Operations.

All date windows are based on `processedAt` and Europe/Rome boundaries.

### Start historical orders bulk export

`POST /internal/shopify/bulk/start?dataset=orders&start=2026-03-17&end=2026-07-29`

Requires bearer auth.

The order bulk query contains commerce/order/line-item fields only and intentionally excludes PII.

### Start current catalog/cost bulk export

`POST /internal/shopify/bulk/start?dataset=catalog`

Requires bearer auth.

Exports products, variants, current inventory quantity and `InventoryItem.unitCost` for downstream SKU/product cost joins.

### Bulk status

`GET /internal/shopify/bulk/status?id=gid://shopify/BulkOperation/...`

Requires bearer auth.

Once Shopify reports `COMPLETED`, `url` points to the PII-free JSONL result. Shopify bulk result URLs are temporary and must be ingested promptly by the private data pipeline.

## Normalized report contract

Top-level fields:

- `schema_version`
- `generated_at`
- `source`
- `tenant`
- `data_policy`
- `timeframe`
- `access`
- `methodology`
- `metrics`
- `breakdowns`
- `warnings`
- `orders`

### Revenue

The main merchandise KPI is:

`net_merchandise_revenue = current_total - current_shipping - current_tax`

Test orders and cancelled orders are excluded from KPI sums.

The report also keeps Shopify's current total, shipping, tax, discounts and total refunded values so downstream analytics can reconcile the numbers.

### Product/vendor revenue proxy

Line-item revenue uses:

`discountedUnitPriceAfterAllDiscountsSet × currentQuantity`

It is labelled as a proxy because Shopify's line-item discount semantics and later order edits/refunds can differ from a financial ledger allocation. The order-level Shopify totals remain the authoritative reconciliation layer.

### COGS

COGS uses:

`current InventoryItem.unitCost × currentQuantity`

This is explicitly a **current-cost proxy**, not a historical landed cost captured at the time of sale. Output includes `cost_coverage` and `costed_units` so margin analysis can reject or flag periods with incomplete costs.

### Contribution proxy

`contribution_margin_proxy_before_adv_and_fulfillment = net_merchandise_revenue - current COGS proxy`

Advertising, payment fees, shipping/fulfillment cost and other variable costs are not subtracted at Shopify-connector level. They belong in the Commerce OS normalized/decision layer.

## Backfill target

The initial SS26 commerce backfill is:

- start: `2026-03-17`
- end: latest completed day

Use the Bulk Operations orders export plus a catalog/cost export, then normalize/persist the output in the private reporting data layer. Daily operation should use completed-day snapshots, with a later webhook/incremental layer only where real-time use cases require it.
