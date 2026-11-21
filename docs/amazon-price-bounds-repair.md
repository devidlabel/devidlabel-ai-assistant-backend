# Bounded EU maximum-price repair

Capability: `amazon.eu.price_bounds.repair.batch`.

The authenticated MARE `mare_prepare` / immutable stored plan / explicit `mare_execute` / existing coordinator path remains mandatory. There is no direct HTTP endpoint, workflow dispatch writer, autonomy-policy addition, or authorization bypass.

## Request and eligibility

```json
{"items":[{"marketplace":"IT","sku":"MC2_example_S","asin":"B0EXAMPLE1","ean":"8057338520504"}]}
```

At most 100 unique marketplace/SKU pairs across IT, DE, FR and ES. Only MC2 Saint Barth (`MC2_`) and Sprayground (`SPR_`). Each pair must have one unique Shopify variant for its SKU and EAN, an active product, positive Shopify inventory, and EUR store currency. The exact EAN must resolve to exactly one Amazon catalog ASIN and match the seller listing. Duplicate ASINs in the same marketplace and the three currently held PEA size identities are rejected.

Original Shopify `compareAtPrice` is converted to integer cents and multiplied by 1.10 once, rounded to cents. That target must already equal both the observed B2C/ALL EUR Amazon offer price and the seller's `our_price` and minimum. An explicit lower maximum and positive DEFAULT fulfillment quantity are required. Missing bounds, scheduled prices, duplicate offers, source drift or unknown identities fail closed. Shopify current price is recorded only as evidence and never used as the original list price.

## Mutation and evidence

Preparation reads all evidence server-side, previews the exact patch with `VALIDATION_PREVIEW`, and stores only sanitized identities, old/target cents and a SHA-256 fingerprint. Complete offer content stays server-side. Ineligible items are retained as `blocked_before_write` with safe reason codes; at least one eligible item is required to prepare a plan. Valid WARNING/INFO issues do not block an otherwise valid preview or accepted acknowledgement. ERROR, malformed or unknown-severity issues fail closed.

Execution re-reads evidence against the immutable fingerprint, previews again, and re-reads after preview. Drift or other failures before any mutation of an item block that item and preserve the rest of the queue. It deep-clones the complete `purchasable_offer` array and changes only the selected ALL/EUR marketplace maximum's `value_with_tax`. Other audiences, marketplaces, fields, minimum, prices and quantities are preserved. No Shopify or Channable mutations occur.

Before every live PATCH the existing private plan store receives a `WRITE_ATTEMPT_STARTED` checkpoint. Accepted submission references are saved before readback. Transport/ACK uncertainty, identity contradictions or unexpected mutations stop processing, retain prior receipts and require reconciliation; no automatic retry occurs. An accepted ACK with a valid submission reference and an unchanged or unavailable readback is pending propagation: the batch continues independent items and reports pending counts separately. It never resends that pair. The existing final coordinator blocks uncertain re-execution. The base router additionally refuses a plan with an existing write-attempt checkpoint.

Result counts distinguish submissions and maximum readbacks. Neither result is evidence that an offer is BUYABLE. `buyable_verified` always remains false. Readback may lag Amazon acceptance, so operators must reconcile pending effects before preparing any further action for the same pair. A concurrent external writer can still change the offer after the final read; compare-and-swap is not available from the Listings API. Channable rule alignment remains an operational prerequisite for a lasting correction.

All writes of this capability's stored plan (including initial executing state, checkpoints, final state and catch paths) share a per-key serialized persistence helper. It spaces writes by at least 1.1 seconds, waits a full interval in a fresh isolate and retries only idempotent KV persistence at most three times. It never retries the provider PATCH. This respects the [KV same-key limit](https://developers.cloudflare.com/kv/api/write-key-value-pairs/#limits-to-kv-writes-to-the-same-key) without changing persistence behavior for other capabilities.

The final execution router also refuses delegation for a completed price-bound plan or a coordinator ledger already marked completed, even if the KV record still says prepared. The durable completion record outranks stale KV; re-execution returns an idempotent completion indication and requests receipt refresh, with no provider access. Other capabilities keep their existing routing.

## Validation

`npm run test:amazon-price-bounds-repair` uses mock Shopify/SP-API transports; it never accesses live credentials. It is included in the existing business MCP test command and therefore existing PR CI. Tests cover four markets, full offer preservation, identity/stock/bounds rejection, drift before and after preview, durable receipts and ambiguous delivery. Production merge, deployment and live execution require separate review and the existing execution controls.
