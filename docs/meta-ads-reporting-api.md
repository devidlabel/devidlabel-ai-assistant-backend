# Meta Ads Reporting API — Devid Label

## Purpose

Read-only server-side reporting bridge for the Devid Label Meta ad account. The Meta access token is stored only as a Cloudflare secret and is never exposed to Shopify/client-side JavaScript.

## Meta configuration

Use a dedicated Business app with the Marketing API product and a System User Access Token.

Minimum runtime permission:

- `ads_read`

Assign the system user only the Devid Label ad account asset required for reporting. Do not grant campaign-management/write permissions unless a separate future feature explicitly requires them.

## Cloudflare configuration

Required:

- `META_ADS_ACCESS_TOKEN` — System User Access Token with `ads_read`.
- `META_AD_ACCOUNT_ID` — numeric Meta ad account ID, with or without `act_` prefix.

Optional:

- `META_GRAPH_API_VERSION` — defaults to `v25.0`.
- `META_REPORT_ACCESS_TOKEN` — dedicated Bearer token for Meta internal reporting. If omitted during rollout, the existing `KLAVIYO_REPORT_ACCESS_TOKEN` is accepted as the shared internal reporting credential.

Never commit token values to GitHub or `wrangler.toml`.

## Routes

### Health

`GET /internal/meta/health`

Returns configuration booleans only. It never returns the Meta token.

### Report

`GET /internal/meta/report`

Requires:

`Authorization: Bearer <internal reporting token>`

Parameters:

- `timeframe=yesterday`
- `timeframe=last_7_days`
- `timeframe=last_14_days`
- `timeframe=month_to_yesterday`
- `timeframe=custom&start=YYYY-MM-DD&end=YYYY-MM-DD`
- `level=account|campaign|adset|ad` (default `campaign`)
- `daily=1` for one row per day within the requested period

Custom date-only values are intentionally passed to Meta so the ad account timezone remains authoritative.

## Returned metrics

Each row exposes normalized aggregate metrics including:

- spend
- impressions
- reach
- frequency
- clicks
- link clicks
- CTR / CPC / CPM
- ViewContent
- AddToCart
- InitiateCheckout
- purchases
- purchase value
- cost per purchase
- purchase ROAS
- video ThruPlays / average watch time when available

The aggregate `actions` and `action_values` arrays are retained for diagnostics because Meta action-type names can evolve over time. No user/customer-level records or PII are requested or returned.

## Attribution

The bridge requests:

- `action_report_time=conversion`
- `use_account_attribution_setting=true`

This keeps reporting aligned with the ad account's attribution configuration as closely as possible. Shopify/MER remains the commercial truth layer for cross-channel decisions.

## Security

- read-only Meta permission (`ads_read`)
- Meta token only in Cloudflare secrets
- internal report route protected by Bearer token
- no campaign mutations
- no audiences, leads, profiles or customer records
- no PII
- `Cache-Control: no-store`
