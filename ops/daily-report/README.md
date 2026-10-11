# Devid Label Daily Business Report — Cloudflare-first

Cloudflare MARE is the authoritative data collector and report composer. It uses the existing official Shopify/Meta/Google/TikTok/Klaviyo/GA4/Search Console APIs; Windsor.ai is not used.

**Every Europe/Rome morning** the existing Cloudflare five-minute cron attempts the Daily Report at 07:25 and 07:45, with later retries at 08:15, 08:45 and 09:15–12:15 if incomplete. The ADV collector continues independently at 07:05/07:20/07:35/07:50. If a provider fails, the report remains accessible as **partial**, never masquerades missing ad spend as zero, and missing sources are shown explicitly.

The full JSON and HTML/plain-text report are persisted into the existing private Cloudflare KV namespace as `mare/daily-report/v1/YYYY-MM-DD`, 45-day retention. Each report includes Shopify direct commerce 1D/3D/7D, human/bot ShopifyQL analytics 1D/3D/7D, Meta/Google/TikTok, Klaviyo, GA4, Search Console and source status. Sources with incomplete permissions are marked N/D. Always keep POS/Draft/marketplace separate from Online Store+Shop and never sum platform-attributed revenues.

The authenticated endpoints use the existing `DAILY_PULSE_ACCESS_TOKEN` Worker secret:
- `GET /internal/daily-report/report?date=YYYY-MM-DD`: JSON report with rendered email bodies, HTTP 200 complete / 206 partial / 404 missing.
- `POST /internal/daily-report/refresh?date=YYYY-MM-DD`: read-only provider refresh, internal KV write only.

The GitHub workflow `Daily Business Report Relay` is a **distribution/readback fallback**, not the source or scheduler of primary data. It fetches the protected Cloudflare report, uploads the full report as a 30-day Actions artifact for authorized report consumers, and publishes a pointer with date, completeness and missing source flags only (no sales figures or personal information). GitHub scheduled workflows may start late; Cloudflare cron does not depend on them.

**Email delivery** is handled by the existing connected Gmail automation, not by the Worker. A KV snapshot or Actions artifact is NOT evidence of an email being sent. The automation must call Gmail send and verify the exact `in:sent` subject, with retry/dedup. If the Gmail connection is unavailable, email status must be **FAILED** rather than "sent". Do not turn on a second sender without a single-sender idempotency policy.

**Security note:** The repository hosting this workflow is public; verify GitHub artifact access visibility for authorized users before treating uploaded business reports as confidential. Prefer moving commercial artifacts to a private repository/storage if access controls are insufficient. Cloudflare KV remains private and bearer-protected.

**Deployment verification:** Run CI, merge, verify Worker deploy, invoke an authenticated POST refresh once, fetch GET readback, verify complete or partial status, then confirm the next GitHub relay produced a usable artifact. Separately verify a real Gmail delivery readback. Never modify campaigns or budgets in this procedure.
