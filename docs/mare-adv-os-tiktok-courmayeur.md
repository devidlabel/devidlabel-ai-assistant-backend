# M.A.R.E. ADV OS — TikTok Courmayeur Pilot (Draft)

## Scope
The Cloudflare Worker reuses the existing `mare_business_os_mcp` stable tools (`mare_capabilities`, `mare_describe`, `mare_read`, `mare_prepare`, `mare_validate`, `mare_execute`). No new MCP tools or OAuth tokens are introduced.

Pilot allowlist: advertiser `7502001151039258640` and existing **disabled** campaign `1879657422391810`.

## New dynamic capabilities
- `tiktok.adgroup.read/create/update`
- `tiktok.ad.read/create/update`
- `tiktok.creative.video.read` and `tiktok.creative.image.read`: existing asset metadata only, no uploads.
- `tiktok.reporting.read`: date-bounded BASIC reporting with `level=campaign|adgroup|ad`.

Read request includes `advertiser_id`; reporting also accepts `start_date`, `end_date` and `level`. Ad reads require `adgroup_id`. Asset metadata reads require `file_id`.

Writes are never direct: they require `mare_prepare` (immutable plan), `mare_validate`, and `mare_execute` with **EXECUTE MARE LIVE PLAN**. The existing Durable Object claim and reconciliation state remain authoritative. No automatic retries after uncertain TikTok errors.

## Safety
- New ad groups and ads are forced `DISABLE`. Updates reject any status besides `DISABLE`.
- Allowlisted advertiser/campaign is rechecked against TikTok before writes. Ad-group ownership and disabled state is verified.
- Ad-group creation requires an explicit positive daily budget, but this PR does not create an ad group or commit any spend. No implicit budgeting and no CBO update.
- Ad-group updates do not accept budget changes. Pixels cannot be created or configured. Creative uploads are not supported.
- Creative payloads are intentionally restricted; schema and ownership must be reviewed before production pilot authorization.
- The global `mare_system_status.permissions_audit.providers.tiktok_ads` snapshot is reconciled with the KV-backed authorization status; the legacy operations-level audit itself remains unchanged.

## Verification and limitations
`npm run test:tiktok-courmayeur` is a static contract test, not a real TikTok API test. CI typecheck is required. The TikTok API v1.3 ad-group/ad creation payload variants, metrics, existing media-info endpoints, and report filters must be confirmed with sandbox/provider responses before any live write approval. Never treat `mare_validate` as upstream TikTok validation.

There is no Shopify margin attribution in this PR: future mapping must join TikTok platform-attributed performance to separate Shopify order/margin/inventory datasets without summing platform conversions into Shopify revenue.

No existing campaign, ad group, creative, Pixel, marketplace project, credential or budget is modified by this branch. No merge or production deployment is authorized.


## Technical review (2026-10-21, PR #262)
- Corrected advertiser regex from matching a literal backslash to matching decimal digits; mocked end-to-end tests ensure 7502001151039258640 is accepted and malformed IDs fail before API calls.
- Existing Shopify Purchase Pixel: **D7SRMKRC77U8CRB30MM0** is never created/altered. \`tiktok.pixel.existing.read\` uses read-only \`/pixel/list/\` scoped to the authorized advertiser. Ad group creation requires this Pixel plus \`optimization_event=COMPLETE_PAYMENT\`, and verifies ownership again just before a write.
- **Purchase event delivery/attribution is not yet proven**: the Pixel may exist without recent COMPLETE_PAYMENT events. A read-only provider event health check and Shopify–TikTok event mapping review must precede production activation.
- TikTok documents an ad-group daily minimum **greater than USD 20** (or equivalent local-currency policy). The pilot requires \`BUDGET_MODE_DAY\`, budget strictly >20, and explicit backend env controls \`TIKTOK_PILOT_MIN_DAILY_BUDGET\`, \`TIKTOK_PILOT_MAX_DAILY_BUDGET\`, \`TIKTOK_PILOT_ADVERTISER_CURRENCY\` matching \`/advertiser/info/\`. No budgets are filled in or changed automatically. EUR/USD conversion and advertiser-specific minimums remain provider-verification gates; the configured minimum must be confirmed against account currency.
- Ad group/ad creates fail closed unless backend env gates \`TIKTOK_PILOT_ADGROUP_SCHEMA_VERIFIED=true\` / \`TIKTOK_PILOT_AD_SCHEMA_VERIFIED=true\` are configured following upstream v1.3 payload verification. Neither gate has been configured in production.
- The pilot campaign \`1879657422391810\` is explicitly excluded from the legacy campaign update route; other pilot endpoints refuse ENABLE and only use DISABLE. There is no activation path until an independent review and budget controls are in place.
- New write plans use the immutable plan ID as an idempotency marker on created entity names; a complete preflight read checks for an existing disabled entity. API errors, missing receipts and unverified readbacks never auto-retry: the M.A.R.E. plan remains \`reconciliation_required\`. \`tiktok.pilot.reconcile\` is a read-only observation and does not replay or automatically close the plan.
- Reporting and reads verify records belong to Courmayeur. Incomplete pagination, wrong account/campaign ownership or ambiguous dimension scope is rejected rather than mixing data across campaigns. Ad creative video/image endpoints only inspect existing asset IDs and never upload assets.

## Tests
- \`npm run typecheck\`
- \`npm run test:tiktok-courmayeur\` (static assertions + bundled TypeScript functional tests against synthetic mocked TikTok API responses)
- \`npm run test:mare-business-mcp\` (existing contract + CRM + TikTok)
- GitHub Actions PR workflow also runs a production-safe Wrangler dry-run, never a production deployment.

## Merge blockers
1. Obtain passing full CI results on the **latest commit** and complete code review.
2. Confirm live v1.3 API schema for ad group/ad create+update and asset fields against authorized advertiser in read-only preflight or TikTok sandbox, with no live mutations.
3. Verify Pixel ownership and that the existing Shopify event actually emits and is mapped to \`COMPLETE_PAYMENT\` (read-only evidence).
4. Verify EUR minimum thresholds, optional TikTok dynamic quotas, time zone/scheduling and spend-control policy before configuring server-side gates.
5. Compare \`main\` for conflicts; do not merge or deploy without explicit owner approval.

## v1.3 SDK schema findings
- Official AdgroupCreateBody requires billing_event, optimization_goal, pacing, schedule_start_time, schedule_type, campaign_id, advertiser_id, adgroup_name, budget and budget_mode. Missing mandatory caller fields are rejected; no values are invented.
- Official AdCreateBody requires advertiser_id, adgroup_id and creatives[]. A creative uses its own operation_status; the adapter forces DISABLE inside every creative, not merely at the top level.
- AdUpdateBody also uses advertiser_id, adgroup_id and creatives[]. The pilot strips operation_status from update bodies but verifies disabled status before and after modification. All writes remain gated behind upstream schema confirmation.
- The pilot validates existing video_id against the advertiser asset library, allows only a configured HTTPS landing host, and never uploads creative assets.
- The official SDK establishes endpoint names and model fields; success on this advertiser, Purchase event health, account-specific spend minima and response field variants still require provider read-only evidence. Mock API tests are not live provider validation.
