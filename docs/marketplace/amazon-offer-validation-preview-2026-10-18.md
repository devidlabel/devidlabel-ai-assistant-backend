# Amazon offer validation preview — 18 October 2026

## Purpose

Expose the existing Amazon offer-only preview through the authenticated MARE
capability router. This prepares a small, server-built offer and asks Amazon to
validate it without saving a listing. It does not create an offer, change stock
or prices, import orders, publish a feed, or transfer ownership from Channable.

The capability is `amazon.offer.validation.preview`, invoked with `mare_prepare`.
Its classification is `operation: prepare`, `risk: artifact_only`,
`approval: none`. The provider call is a remote PUT preparation, not an HTTP read.
Amazon's `mode=VALIDATION_PREVIEW` is fixed by the server and is the reason the
request has no persistent listing effect.

## Request and configuration

The request has exactly four fields: `marketplace`, `sku`, `ean`, and `asin`.
Marketplaces are IT, DE, FR, and ES. The EAN must have 13 digits and a valid
check digit. SKU and ASIN syntax is checked before any provider call or private
plan storage. Extra fields, observations, payloads, quantities, prices, modes,
endpoints, and approval claims are rejected.

The capability requires business authentication, Amazon credentials and seller
identity, the existing Shopify reader and private plan KV binding, and the
explicit `AMAZON_OFFER_PREVIEW_ENABLED="true"` setting. Disabling that setting
makes the capability unavailable. No autonomous writer allowlist is extended.

The existing generic prepare route retains the validated selector and sanitized
result in its private 24-hour plan record. The preview module itself creates no
public artifact, journal entry, log, or cache. Real pilot selectors and provider
references must stay out of the public repository, pull requests, and logs.

## Provider and evidence boundaries

Every execution runs the existing preflight against Shopify and Amazon again.
It requires a unique Shopify SKU and EAN, ACTIVE status, positive stock and price,
tracked and complete inventory, exact per-market EAN/ASIN matching, compatible
catalog attributes, a verified seller SKU absence, bounded seller-ASIN search,
no listing restrictions, and current offer-only definition metadata. P448 is
excluded. Incomplete observations and existing offers block the preview.

The preflight's metadata check is not validation of the complete JSON Schema or
proof of GPSR compliance. Seller-ASIN bounded search is also not a final proof
that no competing writer exists. These limits remain explicit in the response.

The only submitted operation is the EU Listings Items endpoint:

`PUT /listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=…&mode=VALIDATION_PREVIEW`

The server fixes `PRODUCT`, `LISTING_OFFER_ONLY`, condition `new_new`, fulfillment
channel `DEFAULT`, and submitted quantity zero. The ASIN comes from the verified
selector; EUR price comes from the fresh Shopify preflight. There is no caller
override and no fallback to a live submission. Redirects are not followed.

The PUT headers and response stream share a 20-second deadline. Response bytes
are capped at 1 MB even without Content-Length. HTTP failures, unexpected content
types, malformed or oversized results, and `ACCEPTED` responses fail closed with
sanitized error categories.

## How to interpret results

| Result | Meaning |
| --- | --- |
| `BLOCKED_PREVIEW` | Eligibility or evidence blocked execution; no provider validation PUT was sent. |
| `PREVIEW_REVIEW_REQUIRED` with Amazon `INVALID` | Amazon evaluated the preview and returned validation issues; no offer was saved. |
| `PREVIEW_REVIEW_REQUIRED` with Amazon `VALID` | Amazon returned a valid preview response; warnings or other issues may still be present and must be reviewed. |

Issue projection retains only bounded code, severity, and attribute-name fields.
Arbitrary provider messages, URLs, enforcement data, and extra fields are omitted.
The selected product identifiers and a bounded submission reference are private
operational evidence, not public release data.

All results retain `offer_created: false`, `listing_write_enabled: false`,
`can_publish: false`, `provider_mutations: 0`, `full_schema_validated: false`,
`gpsr_compliance_proven: false`, and `channable_handoff_performed: false`.
`VALID` never grants publication permission or establishes sellability.

## Verification

The focused module tests cover configuration, exact input, immutable selectors,
fresh preflight evidence, fixed request construction, authentication and transport
failures, streamed byte limits, response deadlines, and issue projection.

The actual Worker/MCP runtime fixture uses synthetic providers and rejects every
unrecognized network operation. It verifies authentication, capability discovery,
strict validation before KV writes, private plan TTL, completed-plan replay,
all four markets, the real preflight reader, existing-offer and eligibility
blocks, VALID-with-warning and INVALID responses, error redaction, and absence of
provider mutations. Its 541 assertions passed locally. It is part of the existing
`test:marketplace-runtime` CI gate. TypeScript and business MCP regression checks
also passed. The unchanged Shopify catalog and variant queries were validated
against Admin API 2026-01.

## Bounded pilot selection

On 18 October, read-only inspection checked 17 ACTIVE, positive-stock SKUs across
IT, DE, FR, and ES, including a final group of six recently added variants.
Ten already had seller listings. Seven did not obtain an exact EAN match to an
Amazon ASIN. No candidate in this sample met the new-offer preview requirements,
so no remote Amazon validation was claimed or forced by weakening a guard.
This is a bounded sample, not a conclusion about every catalog item.

The actionable follow-up is to establish a stock reconciliation pilot on verified
existing offers: read current marketplace quantities and offer details, reconcile
the exact SKU/ASIN mapping, define the stock budget, and isolate writer ownership
from Channable before enabling a real stock update. New-offer preview remains
available when a verified candidate exists.

## References

- [Amazon: Manage listings issues](https://developer-docs.amazon.com/sp-api/docs/manage-listings-issues)
- [Amazon: Listings Items API](https://developer-docs.amazon.com/sp-api/docs/listings-items-api)
- [Amazon: Preview errors before creating a listing](https://developer-docs.amazon.com/sp-api/docs/preview-errors-before-creating-a-listing)

Production deployment and observed live capability outcomes are recorded in the
release pull request after the required workflow gates complete.
