import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = mkdtempSync(join(tmpdir(), 'meta-reporting-'));
execFileSync('npx', ['tsc', '--outDir', out, '--noEmit', 'false', '--module', 'ESNext', '--target', 'ES2022', '--moduleResolution', 'Bundler'], { stdio: 'inherit' });
const { handleMetaReportingRequest } = await import(`file://${join(out, 'meta-reporting.js')}`);

const assert = (condition, message) => {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
};

const env = () => ({
  META_ADS_ACCESS_TOKEN: 'meta-system-user-token',
  META_AD_ACCOUNT_ID: '843613162004896',
  META_REPORT_ACCESS_TOKEN: 'read-secret',
  META_WRITE_ACCESS_TOKEN: 'write-secret',
  META_PIXEL_ID: '154718499430701',
});

const auth = (url, token = 'read-secret', init = {}) => new Request(url, {
  ...init,
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  },
});

let calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const body = init.body ? JSON.parse(String(init.body)) : null;
  calls.push({ url, init, body });

  if (url.pathname.endsWith('/insights')) {
    return new Response(JSON.stringify({
      data: [{
        date_start: '2026-07-30',
        date_stop: '2026-07-30',
        account_id: '843613162004896',
        account_name: 'Devid Label New2026',
        campaign_id: '1202456620346660012',
        campaign_name: 'BC_pur_ADV+',
        spend: '100',
        impressions: '10000',
        reach: '8000',
        frequency: '1.25',
        clicks: '250',
        inline_link_clicks: '200',
        ctr: '2.5',
        cpc: '0.4',
        cpm: '10',
        actions: [
          { action_type: 'offsite_conversion.fb_pixel_purchase', value: '5' },
          { action_type: 'offsite_conversion.fb_pixel_add_to_cart', value: '20' },
        ],
        action_values: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '420' }],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (url.pathname.endsWith('/campaigns') && init.method === 'POST') {
    return new Response(JSON.stringify({ id: '120255557071740012' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (url.pathname.endsWith('/campaigns')) {
    return new Response(JSON.stringify({ data: [{ id: '1', name: 'BC_pur_ADV+', status: 'ACTIVE' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (/\/v26\.0\/\d+$/.test(url.pathname) && init.method === 'POST') {
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const health = await handleMetaReportingRequest(new Request('https://worker.test/internal/meta/health'), env());
assert(health?.status === 200, 'health should be public and safe');
const healthJson = await health.json();
assert(healthJson.graph_api_version === 'v26.0', 'Meta bridge must default to Graph v26.0');
assert(healthJson.configured.access_token === true, 'health should expose booleans only');
assert(JSON.stringify(healthJson).includes('meta-system-user-token') === false, 'health must never leak Meta token');

const denied = await handleMetaReportingRequest(new Request('https://worker.test/internal/meta/campaigns'), env());
assert(denied?.status === 401, 'campaign list must require read bearer');

calls = [];
const campaigns = await handleMetaReportingRequest(auth('https://worker.test/internal/meta/campaigns'), env());
assert(campaigns?.status === 200, 'authorized campaigns list should succeed');
assert(calls[0].url.pathname === '/v26.0/act_843613162004896/campaigns', 'campaign list must target configured ad account');
assert(calls[0].init.headers.get('Authorization') === 'Bearer meta-system-user-token', 'upstream must use Meta System User token');

calls = [];
const report = await handleMetaReportingRequest(auth('https://worker.test/internal/meta/report?timeframe=yesterday&level=campaign'), env());
assert(report?.status === 200, 'report should succeed');
const reportJson = await report.json();
assert(reportJson.rows[0].metrics.spend === 100, 'spend should normalize to number');
assert(reportJson.rows[0].metrics.purchases === 5, 'purchases should normalize');
assert(reportJson.rows[0].metrics.purchase_value === 420, 'purchase value should normalize');
assert(reportJson.rows[0].metrics.purchase_roas === 4.2, 'ROAS should normalize');

const wrongWriteBearer = await handleMetaReportingRequest(auth(
  'https://worker.test/internal/meta/campaigns',
  'read-secret',
  { method: 'POST', body: JSON.stringify({ name: 'Nope', objective: 'OUTCOME_SALES' }) },
), env());
assert(wrongWriteBearer?.status === 401, 'read bearer must never authorize writes');

const activeWithoutConfirm = await handleMetaReportingRequest(auth(
  'https://worker.test/internal/meta/campaigns',
  'write-secret',
  { method: 'POST', body: JSON.stringify({ name: 'Unsafe', objective: 'OUTCOME_SALES', status: 'ACTIVE' }) },
), env());
assert(activeWithoutConfirm?.status === 400, 'ACTIVE creation must require explicit confirmation');

calls = [];
const created = await handleMetaReportingRequest(auth(
  'https://worker.test/internal/meta/campaigns',
  'write-secret',
  { method: 'POST', body: JSON.stringify({ name: 'API TEST', objective: 'OUTCOME_SALES' }) },
), env());
assert(created?.status === 201, 'campaign create should succeed');
assert(calls[0].body.status === 'PAUSED', 'new campaigns must default to PAUSED');
assert(calls[0].body.is_adset_budget_sharing_enabled === false, 'campaign create must include current v26 budget-sharing field');
assert(calls[0].body.special_ad_categories[0] === 'NONE', 'normal campaign must default to no special category');

calls = [];
const updated = await handleMetaReportingRequest(auth(
  'https://worker.test/internal/meta/campaigns/120255557071740012',
  'write-secret',
  { method: 'PATCH', body: JSON.stringify({ name: 'API TEST - UPDATE OK', status: 'PAUSED' }) },
), env());
assert(updated?.status === 200, 'campaign update should succeed');
assert(calls[0].url.pathname === '/v26.0/120255557071740012', 'campaign update must target object endpoint');
assert(calls[0].body.status === 'PAUSED', 'campaign update must preserve requested safe status');

console.log('Meta Marketing bridge tests passed.');
