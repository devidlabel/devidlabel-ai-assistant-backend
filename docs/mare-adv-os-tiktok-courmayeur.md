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
