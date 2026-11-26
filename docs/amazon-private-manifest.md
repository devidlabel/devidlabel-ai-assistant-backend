# Private Shopify/Amazon operational manifest

The existing audit keeps the raw SKU reconciliation only in memory and publishes aggregate counts.
An explicit local export can now retain the same complete scan for subsequent work without repeating Shopify or Amazon reads.

## Run in an authenticated private executor

Set the existing DAILY_PULSE_ACCESS_TOKEN through the executor's secret mechanism.
Set AMAZON_SHOPIFY_PRIVATE_MANIFEST_OUTPUT to an absolute private path outside this repository checkout, then run:

    node scripts/run-amazon-shopify-audit.mjs

The ordinary aggregate receipt and console output remain aggregate-only.
The optional detailed file contains SKU, product/variant IDs, vendor, product type, observed stock, original barcode, optional prices and IT/DE/FR/ES report classifications.
Missing prices remain null; the existing Shopify page endpoint currently does not request those fields.
Duplicate SKU variant rows are retained, never silently collapsed.
Report ACTIVE classifications do not establish current BUYABLE status.

The exporter requires a complete, reconciled snapshot, writes atomically with mode 0600 and rejects destinations that resolve inside the checkout.
No detailed data is written when the option is absent.

## Persistence limitation

This repository is public. Do not commit the detailed file or upload it as a public workflow artifact.
No workflow, trigger, permission, secret, remote destination or deployment is changed by this patch.
A separately authorized private destination is required for durable retention.
The existing public workflow continues to persist only ops/amazon/shopify-audit-latest.json.

## Offline verification

    node scripts/test-amazon-shopify-live-audit.mjs
    node scripts/test-amazon-shopify-private-manifest.mjs

Tests use synthetic data only, including a complete 4,549-row fixture, and make no network requests.

