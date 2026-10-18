# Amazon package and Shopify fulfillment reconciliation

## Purpose and current ownership

PR214 established actual Shopify API version readback and tracking-number presence. After the owner completed OAuth, a live current-app scope read at 2026-10-18T19:47:08.771Z confirmed write_orders among 31 granted scopes. Requested and served Shopify versions remained 2026-01.

The next observation must compare the number and shipped items already recorded on both providers. A Shopify SUCCESS fulfillment with a tracking number alone does not establish that the same package is recorded on Amazon.

Channable remains the operational importer and shipment owner. This increment introduces a read capability and keeps all marketplace write flags disabled.

## Authenticated capability

**marketplace.amazon.shipment_reconciliation.readonly**

Required input, using synthetic identifiers here:

    {
      "marketplace": "DE",
      "shopify_order_gid": "gid://shopify/Order/9201",
      "amazon_order_id": "123-1234567-1234567"
    }

The schema and implementation accept exactly these three fields. Caller-supplied observations, packages, GraphQL, URLs and credentials are not accepted. The existing M.A.R.E. authorization, Amazon credentials and seller configuration, and installed Shopify token are required.

The service obtains all evidence server-side:

1. Read the selected Amazon order through Orders API 2026-01-01 getOrder, including FULFILLMENT and PACKAGES.
2. Read the existing Channable-imported Shopify order lines and fulfillment metadata through the established Shopify client.
3. Validate identity, completeness, line quantities, tracking associations and source status, then return aggregate evidence.

The Amazon request uses the fixed EU endpoint. Marketplace is a response identity guard: getOrder has no marketplace query parameter. Redirects are not followed. The existing LWA resolver is reused. There is no shipment-confirmation request.

## Decision scope

A positive **REGISTERED_SHIPMENT_DATA_MATCHED** observation requires matching order, seller and market context; complete quantities; Shopify SUCCESS fulfillment coverage; eligible observed Amazon package status; and an unambiguous one-to-one association with exactly equal tracking strings and package SKU/quantity vectors. Carrier labels must also be present and exactly equal for this overall status.

Tracking numbers and SKUs remain opaque. Case, punctuation, leading zeroes and whitespace are not normalized to manufacture equality. Duplicate or multiple tracking associations require review. A fulfillment with several tracking entries does not prove how its lines are allocated to individual packages.

Tracking/quantity agreement and carrier-label comparison are separate results. When the first is established but the labels differ or are unavailable, tracking_and_quantities_match can remain true while the overall status requires carrier review. Equal descriptive labels do not establish an Amazon carrierCode mapping.

Missing package datasets remain null; a returned empty array remains empty. Neither result authorizes a shipment confirmation. Missing package contents, incomplete quantities, changed Shopify current quantities, pending or unsuccessful source states, and ambiguous associations prevent the complete positive verdict.

The result describes values observed during the read interval. The providers are not read atomically and source stability is not reverified. It does not prove a new M.A.R.E. confirmation was submitted or acknowledged, independent carrier handover, delivery, inventory booking, reservation release or operational ownership transfer.

## Data boundaries and limits

The Amazon private projection and Shopify private tracking helper exist only inside the service. The established Shopify metadata capability preserves its existing result shape and discards the private tracking projection.

The new capability returns status, counts, booleans and observation times. It does not return order IDs, seller IDs, Shopify GIDs, SKUs, package references, carrier labels, raw tracking values, customer fields or deterministic fingerprints. It writes no provider data, journal, cache or evidence receipt.

FULFILLMENT and PACKAGES can include additional fields depending on Amazon's granted roles. The reader selects an explicit field allowlist and discards buyer, recipient, address, customization, gift-message and unrelated fields. It therefore states buyer_recipient_datasets_requested=false and customer_fields_returned=false instead of claiming the entire upstream dataset cannot contain personal data.

Amazon reads are bounded to 200 order items, 50 packages, 200 lines per package, 4 MB of actual response bytes and a 20-second GET/body deadline. The Shopify fulfillment reader preserves its existing bounded pagination guards. Missing or malformed source data is not repaired with guessed values.

## Validation and rollout

Synthetic tests exercise the Amazon reader, comparison service, existing Shopify metadata contract and actual Worker/MCP route. Runtime checks replace both provider transports, block any unmocked network, reject mutations, and detect private-data canaries in the complete response.

The new test aggregate runs inside the existing marketplace-runtime CI gate. Production bindings, workflows, cron, credentials, API pins, OAuth scopes and operational writers are unchanged by this increment.

Live package reconciliation is a post-deployment check. Local fixtures and a passing CI run alone are not evidence that the selected seller account returns complete PACKAGES data or that a real pilot matches. Record the actual result, or its concrete missing-data/error status, in the private session after release; public checkpoints contain only sanitized aggregates.

## Primary references

- [Amazon getOrder 2026-01-01](https://developer-docs.amazon/sp-api/reference/getorder-3)
- [Amazon Orders 2026-01-01 OpenAPI model](https://github.com/amzn/selling-partner-api-models/blob/main/models/orders-api-model/orders_2026-01-01.json)
- [Amazon operation role mappings](https://developer-docs.amazon/sp-api/docs/role-mappings)
- [Amazon Orders field access and personal data](https://developer-docs.amazon/sp-api/docs/access-orders-pii)
- [Shopify FulfillmentTrackingInfo 2026-01](https://shopify.dev/docs/api/admin-graphql/2026-01/objects/FulfillmentTrackingInfo)
- [Preceding Shopify API and OAuth setup](shopify-api-fulfillment-setup-2026-10-18.md)
