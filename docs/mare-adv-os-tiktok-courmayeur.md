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

## Pre-merge read-only API evidence and limitations — 21 October 2026

- **Live TikTok GET verified via deployed M.A.R.E. Business OS:** `tiktok.campaign.read` for advertiser `7502001151039258640`, campaign `1879657422391810`, returned `code=0`, `operation_status=DISABLE`, `secondary_status=CAMPAIGN_STATUS_DISABLE`, `objective_type=WEB_CONVERSIONS`, `budget_mode=BUDGET_MODE_INFINITE` and campaign budget `0`. No writes occurred.
- **Not executable live through deployed MCP:** the PR's `tiktok.advertiser.info.read`, `tiktok.adgroup.quota.read`, `tiktok.pixel.existing.read`, `tiktok.pixel.event.stats.read`, `tiktok.adgroup.read`, `tiktok.ad.read`, `tiktok.creative.video.read`, `tiktok.creative.image.read`, `tiktok.reporting.read` are not yet deployed. Do not represent mocked or SDK-documented reads as verified real API calls.
- Added read-only `GET /advertiser/info/` for authorized advertiser currency/timezone, `GET /adgroup/quota/` for quota, and `GET /pixel/event/stats/` for scoped aggregate stats of the existing Shopify Pixel `D7SRMKRC77U8CRB30MM0`. Pixel event stats returns explicit `purchase_event_verified=false` until separately interpreted from authentic provider evidence. No pixel writes or events sent.
- **SDK v1.3 documentation references**: `MeasurementApi.md` (pixelList, pixelEventStats); `AccountManagementApi.md` (advertiser_info), `AdgroupApi.md` (adgroupGet and adgroupQuota), `ReportingApi.md` (reportIntegratedGet), `AdCreateBody.md` and `AdgroupCreateBody.md`.
- **Creative identity for future uploads:** `video_id` (from authorized creative asset metadata, `/file/video/ad/info/`), optional `image_ids` (from `/file/image/ad/info/`), `adgroup_id` and advertiser ID. The `creatives[]` element is scoped to an existing disabled ad group and must use `operation_status=DISABLE`. No uploads are in scope.
- **Budget:** the real advertiser account currency, account-specific minimum and max approval threshold have **not** been obtained from the live API. The historical reference floor >USD 20 is not a verified EUR equivalence; the pilot fails closed without approved currency, configured min/max, and per-advertiser readback.
- **Reporting:** the documented `/report/integrated/get/` accepts `report_type`, `data_level`, dimensions/metrics, dates and optional filters. Which Purchase metrics and filters this particular advertiser permits is not yet verified. Cross-account/campaign rows or incomplete pages must be rejected.
- **Idempotency/reconciliation:** tested with in-memory simulated API responses. Each immutable plan gets one idempotency marker; uncertain writes remain `reconciliation_required`, with read-only observations and no automatic replay or activation.
- **Merge gate:** a GitHub PR CI success is not a proof that the Pixel, events, advertiser currency or read-only report endpoints work upstream. Keep the PR Draft and all write capabilities gated until account evidence is collected using an authorized read-only deployment or connector. No production deploy authorized here.
