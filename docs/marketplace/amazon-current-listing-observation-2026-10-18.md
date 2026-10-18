# Current Amazon quantity and price observations — 18 October 2026

## Purpose

Extend the existing `amazon.seller.listings.direct` read capability so an
existing-offer pilot can compare Shopify inventory with the quantity currently
available on Amazon. Previously the reader returned seller listing presence and
an offer count, without exposing current quantities or prices.

This increment uses the existing authentication, seller configuration, and
`mare_read` route. It introduces no provider mutation, private plan, storage,
inventory command, order import, listing creation, or Channable ownership change.

## Request and source

The input remains exactly `{ marketplace, skus }`, with one marketplace (IT, DE,
FR, or ES) and one to eight unique valid SKUs. The published request schema now
matches those runtime constraints and rejects additional fields. The server
copies validated selectors before any asynchronous operation.

For each SKU the reader calls the fixed EU Listings Items GET endpoint using:

`includedData=summaries,offers,issues,fulfillmentAvailability`

Each request contains a single `marketplaceIds` value. The Amazon fulfillment
availability rows do not carry a marketplace identifier, so the reader keeps
each quantity attached to the context of its individual marketplace request.
It verifies the response SKU, a single summary for the requested marketplace,
and a syntactically valid ASIN before attributing any quantity or price.

## Quantity and price semantics

Amazon distinguishes the latest submitted attributes from the current live
fulfillment availability. This reader uses only `fulfillmentAvailability` for
current quantity; an old `attributes.fulfillment_availability` value is ignored.

| Field | Meaning |
| --- | --- |
| `identity_state` | `VERIFIED` only after matching SKU, marketplace summary, and valid ASIN. It is not independent Shopify catalog matching. |
| `fulfillment_state` | `VERIFIED` only when exactly one `DEFAULT` row contains a safe, nonnegative integer quantity. |
| `current_fbm_quantity` | The observed merchant-fulfilled quantity, including a real zero; `null` when unverified. |
| `current_offers` | Bounded current offers for the requested marketplace, preserving offer type, audience, original decimal amount string, and currency. |
| `price_state` | `VERIFIED` only for exactly one valid `B2C` offer explicitly targeting `ALL` in EUR. |
| `current_b2c_price` | The selected current amount/currency pair, otherwise `null`. |
| `observed_at` | Observation timestamp on each entry and the aggregate response. |
| `observation_complete` | Identity, merchant-fulfilled quantity, and ordinary B2C price are all verified for the entry; at the top level all requested entries must qualify. |

Missing fulfillment data, absent quantity, FBA-only availability, malformed
quantity, or multiple DEFAULT rows are unknown, never inferred as zero.
The reader does not sum different fulfillment channels.

Amounts remain strings; they are not rounded through JavaScript floating point.
B2B and audience-specific prices stay distinct. Missing audience remains `null`
and is not promoted to `ALL`. Duplicate ordinary B2C offers are ambiguous even
when their prices match. Other valid currencies remain visible in the bounded
offer projection but are not selected as the verified EUR pilot price.

The new states carry fixed reason codes. The returned current price does not
prove buyability, Featured Offer eligibility, pricing policy compliance, or a
price that should be written elsewhere.

## Compatibility and boundaries

Existing presence states, counts, `reported_offer_count`, and `complete_evidence`
retain their meaning. In particular, `complete_evidence` describes the absence
of UNKNOWN presence outcomes and can still be true for
`PRESENT_ATTRIBUTES_UNKNOWN`. It is not quantity or price evidence.

Every result keeps provider mutation and stock-changing flags disabled, and
continues to require independent Channable writer ownership verification.
The read is not a shared-stock allocation, a reservation, or a permission to
change quantities. A difference between two observations is not itself a command.

The GET headers and body share a 20-second deadline. A 1 MB limit applies to
actual streamed bytes even when Content-Length is absent or misleading.
Redirects are not followed. Only a bounded, typed 404 body can establish the
existing verified-absence result; other HTTP error bodies stay unread.
Malformed, oversized, stalled, or mismatched responses become unknown with
fixed diagnostics. Raw messages, URLs, localized labels, and extra fields are
not returned.

Operational responses remain merchant-private and may contain the selected
SKU/ASIN and request reference. Public checkpoints and fixtures contain only
synthetic identifiers, aggregate counts, status, and timestamps.

## Verification and pilot

The actual Worker/MCP fixture uses only synthetic transports and rejects all
unrecognized network operations. Its 857 assertions passed locally, covering
authentication, request schema, four separate markets, real zero versus missing
quantity, current data versus last-submitted attributes, price precision,
B2B/audience distinctions, identity mismatch, unknown outcomes, errors, and no
provider mutations or storage. The suite is included in the existing
`test:marketplace-runtime` CI gate. Module tests cover parsing and bounded
transport details; TypeScript, business MCP, and shadow integration checks pass.

The private pilot baseline contains three ACTIVE, tracked Shopify variants with
complete stock observations. Exact EAN/ASIN matching was independently verified
for all three in each of the four marketplaces (12 successful identity checks).
Live quantity/price comparison and deployment outcomes are recorded in the
release pull request after the required gates complete.

The Shopify catalog reader currently returns a scalar selling price without a
shop currency observation. Its `cost_currency` belongs to unit cost, and the
older offer preflight's EUR literal is not a source observation. The pilot must
therefore keep Shopify selling-price currency unknown and avoid treating price
differences as verified monetary comparisons until the shop currency is read.
This does not prevent the quantity comparison.

## References

- [Amazon: Listings Items API — current fulfillment versus submitted attributes](https://developer-docs.amazon/sp-api/docs/listings-items-api)
- [Amazon: Retrieve details about a listing](https://developer-docs.amazon/sp-api/docs/retrieve-details-about-a-listing)
