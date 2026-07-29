# Klaviyo Reporting API — Devid Label

## Purpose

Read-only server-side reporting bridge for campaign and flow performance. The Klaviyo private key is never exposed to Shopify or client-side JavaScript.

## Klaviyo private key scopes

Create a **Custom** private API key with read-only scopes:

- `campaigns:read`
- `flows:read`
- `metrics:read`

`metrics:read` is used only to discover the Shopify `Placed Order` conversion metric automatically. If `KLAVIYO_CONVERSION_METRIC_ID` is configured explicitly, the worker no longer needs metric discovery during report requests, but keeping the read scope is harmless and useful for diagnostics.

Do not grant write scopes, profiles, lists, events, subscriptions or any customer-data scope for this reporting bridge.

## Cloudflare secrets

Required:

- `KLAVIYO_PRIVATE_API_KEY` — Klaviyo private API key (`pk_...`).
- `KLAVIYO_REPORT_ACCESS_TOKEN` — a long random token used only to authorize the internal reporting route.

Optional:

- `KLAVIYO_CONVERSION_METRIC_ID` — explicit metric ID for Shopify `Placed Order`; if omitted the worker discovers it automatically.

Never commit secret values to GitHub or `wrangler.toml`.

## Routes

### Health

`GET /internal/klaviyo/health`

Public but returns configuration booleans only; it never returns secret values or Klaviyo data.

### Report

`GET /internal/klaviyo/report`

Requires:

`Authorization: Bearer <KLAVIYO_REPORT_ACCESS_TOKEN>`

Default timeframe is `yesterday`.

Examples:

- `?timeframe=yesterday`
- `?timeframe=last_7_days`
- `?timeframe=this_month`
- `?timeframe=last_month`
- `?timeframe=custom&start=2026-03-17&end=2026-03-31`

Date-only custom ranges are converted to Europe/Rome day boundaries, including CET/CEST.

## Returned statistics

For both campaigns and flows:

- recipients
- delivered / delivery rate
- unique opens / open rate
- unique clicks / click rate
- conversions / unique conversions / conversion rate
- conversion value
- revenue per recipient
- average order value
- bounces / bounce rate
- unsubscribes / unsubscribe rate
- spam complaints / spam complaint rate

Conversion statistics use the Shopify `Placed Order` metric.

## Security model

- private key stored only as a Cloudflare secret;
- report route protected by a second independent bearer token;
- no profile endpoint;
- no email addresses, customer identities, event payloads, order numbers or other PII are returned;
- no write scopes;
- `Cache-Control: no-store` on all responses;
- assistant/chat routes remain delegated unchanged to worker-v2.
