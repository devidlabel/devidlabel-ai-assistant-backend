# Cloudflare-first paid-media daily snapshots

The authoritative **Google Ads and Meta Ads** reporting reads use the existing MARE Cloudflare Worker and the official provider APIs. No Windsor.ai or third-party advertising relay is required.

## Scheduling

The Worker already has a five-minute Cloudflare cron trigger. The cron now runs the marketplace watchdog and ADV snapshot independently (settled in parallel). In `Europe/Rome`, the snapshot checks at **07:05, 07:20, 07:35 and 07:50**; if a fully successful record is not in KV, it retries at **HH:05** between 08:00 and 20:59. This also recovers after a delayed deployment. Successful records are not re-fetched automatically.

The target date is the previous **Europe/Rome** calendar day; it is never inferred from UTC midnight. The data is stored in existing `SHOPIFY_TOKENS_KV` as `mare/paid-media/v1/YYYY-MM-DD` for 45 days. No new provider token or external paid connector is introduced. The optional variable `MARE_PAID_MEDIA_CRON_ENABLED=false` disables scheduled snapshots without interrupting the marketplace watchdog or on-demand reads.

## Protected read and recovery

Requests require the existing `DAILY_PULSE_ACCESS_TOKEN` bearer (configured as a Worker secret; do not place a secret in source files, tickets, browser URLs or chat).

- `GET /internal/paid-media/snapshot?date=YYYY-MM-DD`: read stored date, **200** when both sources are complete, **206** when partial, **404** when missing.
- `POST /internal/paid-media/refresh?date=YYYY-MM-DD`: explicitly refetch an eligible historical date and replace the KV record; **read-only** at Google/Meta, the only write is MARE's internal KV snapshot.

The JSON includes `source_status`, per-provider metrics, campaign summaries, and `combined.complete`. If either provider fails, its `spend` is **null**, `combined.paid_media_spend_meta_google` is **null**, and the missing source is explicitly recorded. A real zero-spend day can only be represented after a successful source response. Provider IDs and exact report date are verified before storing a result as successful.

## Daily Pulse safety

Daily Pulse also marks missing paid-media inputs **null/N/D** and refuses to calculate MER or after-ADV contribution when required sources or Shopify revenue are unavailable. The TikTok enrichment follows the same rule. `ok=true` for the overall multi-source envelope **does not mean** all sub-sources are successful; always inspect each `source_status`.

## Operations and remaining integration

The Worker cron is the **primary collection mechanism**; GitHub Actions Daily Pulse is currently a separate archival/distribution workflow. A missing GitHub Actions run must not cause Google/Meta ingestion to stop. The next step for end-to-end ChatGPT Daily Report delivery is to expose/use the protected Cloudflare snapshot from the report runner, verify email readback and remove dependence on the GitHub pointer. Until that reporting-consumer connection is verified, do not claim that snapshot creation alone repairs email delivery.

Run `node scripts/test-paid-media-snapshot.mjs` and the deploy-worker CI before merging. After deployment, read the snapshot for yesterday and verify `complete=true`, account scope, report date, and positive or valid-zero provider spend. If a source remains partial, inspect its upstream provider status without altering campaigns or spend.
