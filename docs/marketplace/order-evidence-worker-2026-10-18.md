# Marketplace order evidence — Worker integration

## Result implemented

The private journal can retain a verified observation of an Amazon order already imported into Shopify by Channable. A separate receipt reader verifies the saved content without requesting either provider again. This is historical `SHADOW_ONLY` evidence; importer ownership remains with Channable.

The existing `amazon.orders.observe.readonly` capability keeps its original read-only behavior. The new explicit `marketplace.order.evidence.capture` preparation reads Amazon and Shopify on the server, compares one existing order, records local evidence, and performs an independent readback. `marketplace.order.evidence.read` accepts only the receipt identifier. Neither capability imports orders, changes inventory, publishes offers, sends tracking, advances a polling cursor, schedules work, or releases reservations.

## Trust and persistence boundaries

- Public capture input is limited to one Amazon order ID, marketplaces, two bounded time windows, and pagination limits. Extra observations, account identifiers, Shopify GIDs, domains, or URLs are rejected before a plan is stored.
- The Amazon reader must complete the whole selected scan. More than 20 orders requires a narrower window; the batch is never truncated for persistence.
- The Shopify index must be complete and unambiguous. The server derives the Shopify GID from the positive Channable reference and rechecks the reference through the line reader.
- Snapshot, SKU, line ID, variant GID, quantities, completeness, and non-operational flags are validated again before persistence. Matching quantities do not prove inventory allocation, a one-to-one variant mapping, or completed shipping.
- Tenant, configured Amazon seller, and normalized Shopify shop domain are part of the evidence manifest and fingerprint. A receipt from another scope is rejected.
- The actor authenticates each private binding request. The final evidence transaction rechecks the exact current Core snapshot before recording its manifest. Replay uses the same receipt identity and cannot create a second evidence record.
- Provider and transport errors are reduced to fixed diagnostic codes; provider response bodies are not copied into tool errors.

The original journal actor and client remain in their existing module. The new evidence controller is an additional server-read workflow and does not import `cloudflare:workers` into the Node MCP path. The separate runtime-only refactor described in the earlier checkpoint was not applied.

## Runtime configuration

`MareMarketplaceOrderJournal` is exported by the existing Worker entry point. The `MARE_ORDER_JOURNAL` binding and `v4_mare_order_evidence` SQLite migration provide private storage. `MARE_ORDER_JOURNAL_ENABLED=true` enables explicit capture and read requests only. No new cron or marketplace writer is installed.

## Verification

The journal suite covers correlated receipts, enrichment fingerprints, interruption recovery, concurrent capture, and SQLite restart. The evidence suite covers complete-source validation, exact references and quantities, scope isolation, corrupt receipts, transactional failures, replay, and restart. The controller suite exercises the real Worker and authenticated MCP chain, rejects injected snapshots before any plan write, tests provider and transport failures, and verifies capture/read/replay with no provider mutations. Existing Core, intake, adoption, and order-line regressions remain part of acceptance.

TypeScript compilation and the Wrangler deployment dry-run are required. The existing PR workflow runs the complete repository suite. These tests use synthetic identifiers only and do not constitute a production capture. Actual deployment and live receipt results must be recorded separately with their timestamps; never add real order IDs, Shopify order IDs, customer data, credentials, or tracking numbers to this public repository.

## Remaining operational milestones

This increment does not replace Channable. Creating Shopify orders still requires the appropriate Shopify permission and a verified importer handoff. Stock allocation by location, carrier mapping, shipment quantities, and tracking confirmation remain separate end-to-end milestones before any sellable-offer rollout.
