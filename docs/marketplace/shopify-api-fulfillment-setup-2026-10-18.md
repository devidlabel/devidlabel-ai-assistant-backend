# Shopify API and fulfillment setup — 2026-10-18

## Purpose

The completed order-evidence path proves an existing Amazon order matches its
Channable-imported Shopify order. The next increment makes the API version
observable, prepares the missing order-creation permission, and reviews actual
Shopify fulfillments and tracking-number presence. Channable remains the
operational owner. This change adds no marketplace order, stock, offer or
shipment-confirmation writer.

## Version and OAuth configuration

`shopify-app-config.ts` is the shared source for the Admin API fallback version
and the scopes used by both OAuth entry points. The active Worker V3 `/install`
route previously maintained a larger scope list than the base handler. Both now
use the same existing list with exactly one additional scope, `write_orders`.
The callback's fallback scope metadata uses that same configuration. Scope
metadata is still diagnostic: actual permissions are observed through
`currentAppInstallation.accessScopes` using the M.A.R.E. token.

The explicit pin is `2026-01`, in both Wrangler and the shared fallback. The
media bridge's direct Admin request also uses the same fallback. This is the
oldest accessible stable version on 2026-10-18, matching Shopify's documented
fall-forward destination for the retired `2025-10` pin. The previous successful
reads alone did not identify their served version. The selected version's
published accessibility window ends on 2027-01-16 at 15:00 UTC; the new report
stops declaring its support verified after that instant.

`shopifyGraphQLWithMetadata` retains the existing token resolver, HTTPS request,
timeout and error handling. It additionally returns the requested version and
the actual `X-Shopify-API-Version` response header. Existing `shopifyGraphQL`
callers still receive exactly the original `data` shape.

The new authenticated read capability is:

```text
shopify.marketplace.api_readiness.readonly
request: {}
```

Its fixed query reads only the current app installation ID, validates it and
discards it. The report has separate states for an absent or malformed header,
a requested/served mismatch, an unexpected configured pin and an unverified
support window. `ok` means an observation was interpreted; use
`api_version_alignment_verified` to evaluate alignment. Raw invalid header
values and upstream exception text are not returned. All write-readiness flags
remain false even when the version is verified.

Changing the server-side scope list does not itself grant `write_orders`.
After this change is deployed, the merchant can reopen the configured backend
`/install` route and approve the updated Shopify consent screen. The route
retains its configured shop, fixed callback, server-generated state with a
600-second TTL, and offline authorization-code flow. It ignores caller-supplied
scope and redirect overrides. Tokens remain encrypted in the existing KV store.
The subsequent live scope read, rather than a successful callback page, is the
proof of the actual grant.

`read_orders` already permits reading existing Shopify fulfillments and their
tracking information. The scope report now distinguishes that read requirement
from `write_orders` for future order creation. No extra fulfillment write scopes
are requested in this increment.

## Fulfillment review

This increment incorporates the SUCCESS-only comparator from PR #210 and adds
tracking presence and strict line checks. The metadata reader requests
`trackingInfo { company number }`. Each number is checked only in memory and
reduced to present/missing counts. Numbers, URLs and number fingerprints are
never returned or persisted by the new review path.

Only `SUCCESS` fulfillment quantities contribute to shipped coverage. Cancelled
or failed fulfillments do not contribute, and `OPEN` or `PENDING` states require
review. The comparator verifies line IDs, exact SKU values, variant IDs,
quantities, source identity, complete pagination and aggregate counters.
Changed Shopify current quantities require a separate review. Every successful
shipment contributing to complete tracking presence must have nonempty tracking
entries and a number on every entry.

Fulfillment and tracking arrays are rejected at their cap of ten because those
arrays provide no pagination-completeness indicator. A line connection may
contain exactly fifty rows when `hasNextPage=false`; incomplete connections are
rejected. Unknown statuses, duplicate identities and over-shipped quantities are
also rejected.

The new authenticated capability is:

```text
shopify.marketplace.amazon_fulfillment_review.readonly
request: { shopify_order_gid, amazon_order_id }
```

Callers provide selectors only. Both order lines and fulfillment metadata are
fetched server-side using the existing authenticated Shopify client. The wrapper
returns aggregate quantities, carrier names and the review outcome, with no
order IDs, GIDs, SKUs, raw lines or raw tracking values. Provider errors are
replaced with fixed codes. The outcome distinguishes missing tracking, partial
coverage, pending work, changed quantities and complete SUCCESS coverage with
tracking presence.

Tracking presence does not prove validity of the number, carrier handover,
Amazon carrier-code mapping or Amazon's receipt of a shipment confirmation.
Those proof flags remain false. Importer ownership remains
`NOT_TRANSFERRED_FROM_CHANNABLE` and provider mutation count is zero.

## Verification and release readback

Both new GraphQL operations were validated against Shopify's actual `2026-01`
schema. Local verification includes the full marketplace runtime suite, the
existing OAuth token/callback tests, live-scope fixtures, 456 API-readiness
checks, 161 actual Worker/client checks and 210 fulfillment checks. All fixtures
are synthetic. The existing 248 journal, 334 durable evidence and 257
evidence-client checks continue to pass.

The new tests run through the existing `test:marketplace-runtime` CI step. The
existing workflow and production verification gates are unchanged. The OAuth
test's obsolete missing-token expectation was aligned with the pre-existing
`shopify_token_missing` error, and the MCP source checks now inspect the shared
scope configuration while retaining their existing permission assertions.

After deployment, describe and read the new API capability, check the live scope
capability, and read the new fulfillment review for the privately selected pilot
order. A production release receipt and a successful private readback are
separate evidence from the synthetic tests. Actual order selectors and derived
private receipt IDs must not be copied into this public repository.

Future order creation still needs an explicit inventory policy: Shopify's
`orderCreate` defaults to `BYPASS`, which does not commit inventory. Variant and
location mapping, single ownership, deduplication and stock effects must be
proved before a writer is enabled. Never create a second Shopify order for an
order already imported by Channable.

## Official references

- [API versioning and served-version header](https://shopify.dev/docs/api/usage/versioning)
- [Manage access scopes](https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes)
- [orderCreate, API 2026-01](https://shopify.dev/docs/api/admin-graphql/2026-01/mutations/orderCreate)
- [OrderCreateOptionsInput, API 2026-01](https://shopify.dev/docs/api/admin-graphql/2026-01/input-objects/OrderCreateOptionsInput)
- [Fulfillment, API 2026-01](https://shopify.dev/docs/api/admin-graphql/2026-01/objects/Fulfillment)
- [FulfillmentTrackingInfo, API 2026-01](https://shopify.dev/docs/api/admin-graphql/2026-01/objects/FulfillmentTrackingInfo)
