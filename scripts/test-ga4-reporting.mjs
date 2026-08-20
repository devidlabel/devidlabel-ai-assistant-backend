import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = mkdtempSync(join(tmpdir(), 'ga4-reporting-'));
execFileSync('npx', ['tsc', '--outDir', out, '--noEmit', 'false', '--module', 'ESNext', '--target', 'ES2022', '--moduleResolution', 'Bundler'], { stdio: 'inherit' });
const { handleGa4ReportingRequest } = await import(`file://${join(out, 'ga4-reporting.js')}`);

const assert = (condition, message) => {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
};

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = JSON.stringify({
  client_email: 'devid-label-adv-agent@example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  token_uri: 'https://oauth2.googleapis.com/token',
});
const env = () => ({
  GOOGLE_ADS_SERVICE_ACCOUNT_JSON: serviceAccount,
  GA4_PROPERTY_ID: '345407658',
  GOOGLE_ORGANIC_REPORT_ACCESS_TOKEN: 'report-secret',
});

const reportPayload = (body) => {
  const dimensionHeaders = (body.dimensions || []).map(({ name }) => ({ name }));
  const metricHeaders = (body.metrics || []).map(({ name }) => ({ name, type: 'TYPE_INTEGER' }));
  const dimensionValues = dimensionHeaders.map(({ name }) => ({ value: name === 'date' ? '20260801' : name === 'eventName' ? 'purchase' : name === 'country' ? 'Italy' : '/collections/test' }));
  const metricValues = metricHeaders.map(({ name }, index) => ({ value: name.toLowerCase().includes('revenue') ? '500.25' : String(index + 10) }));
  return {
    dimensionHeaders,
    metricHeaders,
    rows: [{ dimensionValues, metricValues }],
    totals: [{ metricValues }],
    rowCount: 1,
    propertyQuota: { tokensPerDay: { remaining: 1000 } },
  };
};

const calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  calls.push({ url, init });
  if (url === 'https://oauth2.googleapis.com/token') {
    const params = new URLSearchParams(String(init.body));
    const assertion = params.get('assertion');
    const jwtPayload = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString('utf8'));
    assert(jwtPayload.scope === 'https://www.googleapis.com/auth/analytics.readonly', 'GA4 OAuth scope should be readonly');
    return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes(':batchRunReports')) {
    const body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ reports: body.requests.map(reportPayload) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes(':runRealtimeReport')) {
    return new Response(JSON.stringify(reportPayload(JSON.parse(String(init.body)))), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
};

const health = await handleGa4ReportingRequest(new Request('https://worker.test/internal/ga4/health'), env());
assert(health?.status === 200, 'GA4 health should be public');
const healthBody = await health.json();
assert(healthBody.property_id === '345407658', 'GA4 property ID should normalize');
assert(JSON.stringify(healthBody).includes('report-secret') === false, 'Health must not leak bearer');
const denied = await handleGa4ReportingRequest(new Request('https://worker.test/internal/ga4/report'), env());
assert(denied?.status === 401, 'GA4 report should require bearer');
const report = await handleGa4ReportingRequest(new Request('https://worker.test/internal/ga4/report?timeframe=last_7_days', { headers: { Authorization: 'Bearer report-secret' } }), env());
assert(report?.status === 200, 'GA4 report should succeed');
const reportBody = await report.json();
assert(reportBody.property_id === '345407658', 'GA4 report should expose property ID');
assert(reportBody.overview.metrics.includes('sessions'), 'Overview should include sessions');
assert(reportBody.ecommerce_funnel.rows[0].eventName === 'purchase', 'Funnel should normalize event rows');
const batchCalls = calls.filter((call) => call.url.includes(':batchRunReports'));
assert(batchCalls.length === 2, 'GA4 bundle should use two batch requests');
assert(JSON.stringify(batchCalls.map((call) => JSON.parse(String(call.init.body)).requests.length)) === JSON.stringify([5, 3]), 'GA4 batches should contain five and three reports');
assert(calls.filter((call) => call.url.includes(':runReport')).length === 0, 'GA4 bundle should not use individual standard report requests');
assert(calls.every((call) => call.url.includes('analyticsdata.googleapis.com') ? call.init.headers.Authorization === 'Bearer access-token' : true), 'OAuth token must stay upstream');
const realtime = await handleGa4ReportingRequest(new Request('https://worker.test/internal/ga4/realtime', { headers: { Authorization: 'Bearer report-secret' } }), env());
assert(realtime?.status === 200, 'GA4 realtime should succeed');
const realtimeBody = await realtime.json();
assert(realtimeBody.realtime.rows[0].country === 'Italy', 'Realtime rows should normalize');

console.log('GA4 reporting bridge tests passed.');
