import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function classifyError(error) {
  const text = typeof error === 'string' ? error : '';
  if (/invalid_grant|expired or revoked/i.test(text)) return 'oauth_token_expired_or_revoked';
  if (/invalid_client|unauthorized_client/i.test(text)) return 'oauth_client_rejected';
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used.*project/i.test(text)) return 'google_api_disabled';
  if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(text)) return 'oauth_scope_insufficient';
  if (/quotaExceeded|rateLimitExceeded/i.test(text)) return 'google_quota_exceeded';
  if (/youtube_channel_not_found/i.test(text)) return 'channel_not_found';
  if (/youtube_not_authorized/i.test(text)) return 'authorization_missing';
  if (/youtube_api_http_400/i.test(text)) return 'google_query_rejected';
  if (/youtube_api_http_403/i.test(text)) return 'google_access_denied';
  return 'provider_read_failed';
}

export async function inspectYouTube(env, fetcher = fetch) {
  const report = { generated_at: new Date().toISOString(), read_only: true,
    http_status: null, report_ok: false, reason: 'not_checked', sections: [], raw_secret_values_exposed: false };
  if (!env.DAILY_PULSE_ACCESS_TOKEN) return { ...report, reason: 'existing_probe_credential_missing' };
  try {
    const result = await fetcher('https://devidlabel-ai-assistant-backend.devidlabel.workers.dev/internal/youtube/report?days=28', {
      method: 'GET', headers: { Authorization: `Bearer ${env.DAILY_PULSE_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(60_000), redirect: 'error',
    });
    report.http_status = result.status;
    const data = await result.json();
    report.report_ok = result.ok && data.ok === true;
    report.reason = report.report_ok ? 'report_read_success' : result.status === 401 ? 'probe_access_denied' : 'report_read_failed';
    for (const label of ['channel', 'summary', 'videos', 'traffic_sources', 'search_terms']) {
      const section = data.sections?.[label];
      if (section) report.sections.push({ label, ok: section.ok === true,
        reason: section.ok === true ? 'read_success' : classifyError(section.error) });
    }
    if (!report.sections.length && data.error) report.reason = classifyError(data.error);
    return report;
  } catch { return { ...report, reason: 'report_transport_or_payload_failed' }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await inspectYouTube(process.env);
  await writeFile(process.argv[2] ?? 'youtube-readiness.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
