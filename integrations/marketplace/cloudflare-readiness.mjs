import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function classifySubscriptions(body, now = Date.now()) {
  if (body?.success !== true || !Array.isArray(body.result)) return 'unverified';
  let free = false;
  for (const subscription of body.result) {
    const plan = subscription.rate_plan ?? {};
    const label = [plan.id, plan.name, plan.public_name].filter(x => typeof x === 'string').join(' ').toLowerCase();
    if (!label.includes('workers')) continue;
    const end = subscription.current_period_end;
    if (end && (!Number.isFinite(Date.parse(end)) || Date.parse(end) <= now)) continue;
    if (/paid|standard/.test(label) && !/free/.test(label)) return 'paid_confirmed';
    if (/free/.test(label)) free = true;
  }
  return free ? 'free_confirmed' : 'unverified';
}

export async function inspectCloudflare(env, fetcher = fetch) {
  const report = { generated_at: new Date().toISOString(), read_only: true,
    workers_plan: 'unverified', reason: 'not_checked', http_status: null,
    can_enable_full_catalog_scans: false, raw_secret_values_exposed: false };
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) return { ...report, reason: 'existing_deploy_credentials_missing' };
  if (!/^[a-f0-9]{32}$/i.test(account)) return { ...report, reason: 'account_id_invalid' };
  try {
    const result = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/subscriptions`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000),
    });
    report.http_status = result.status;
    if (result.status === 401 || result.status === 403) return { ...report, reason: 'billing_read_permission_unavailable' };
    if (!result.ok) return { ...report, reason: 'subscriptions_read_failed' };
    const body = await result.json();
    report.workers_plan = classifySubscriptions(body);
    report.can_enable_full_catalog_scans = report.workers_plan === 'paid_confirmed';
    report.reason = report.can_enable_full_catalog_scans ? 'paid_subscription_observed'
      : report.workers_plan === 'free_confirmed' ? 'free_plan_write_limit_insufficient' : 'workers_plan_not_identified';
    return report;
  } catch {
    return { ...report, reason: 'subscriptions_read_failed' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await inspectCloudflare(process.env);
  const filename = process.argv[2] ?? 'cloudflare-readiness.json';
  await writeFile(filename, JSON.stringify(report, null, 2) + '\n');
  // Only the allowlisted report is emitted. API responses and credentials are not logged.
  console.log(JSON.stringify(report, null, 2));
}
