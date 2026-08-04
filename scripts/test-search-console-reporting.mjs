import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = mkdtempSync(join(tmpdir(), 'search-console-reporting-'));
execFileSync('npx', ['tsc', '--outDir', out, '--noEmit', 'false', '--module', 'ESNext', '--target', 'ES2022', '--moduleResolution', 'Bundler'], { stdio: 'inherit' });
const { handleSearchConsoleReportingRequest } = await import(`file://${join(out, 'search-console-reporting.js')}`);

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
  SEARCH_CONSOLE_SITE_URL: 'sc-domain:devidlabel.com',
  GOOGLE_ORGANIC_REPORT_ACCESS_TOKEN: 'report-secret',
});

const calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  calls.push({ url, init });
  if (url === 'https://oauth2.googleapis.com/token') {
    const params = new URLSearchParams(String(init.body));
    const assertion = params.get('assertion');
    const jwtPayload = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString('utf8'));
    assert(jwtPayload.scope === 'https://www.googleapis.com/auth/webmasters.readonly', 'Search Console OAuth scope should be readonly');
    return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.endsWith('/webmasters/v3/sites')) {
    return new Response(JSON.stringify({ siteEntry: [{ siteUrl: 'sc-domain:devidlabel.com', permissionLevel: 'siteFullUser' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('/searchAnalytics/query')) {
    const body = JSON.parse(String(init.body));
    const dimensions = body.dimensions || [];
    const keys = dimensions.map((name) => name === 'date' ? '2026-08-01' : name === 'query' ? 'sprayground zaini' : name === 'page' ? 'https://devidlabel.com/pages/test' : name === 'device' ? 'MOBILE' : 'ita');
    return new Response(JSON.stringify({
      rows: [{ keys, clicks: 10, impressions: 100, ctr: 0.1, position: 4.2 }],
      responseAggregationType: dimensions.includes('page') ? 'byPage' : 'byProperty',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
};

const health = await handleSearchConsoleReportingRequest(new Request('https://worker.test/internal/search-console/health'), env());
assert(health?.status === 200, 'Search Console health should be public');
const healthBody = await health.json();
assert(healthBody.configured === true, 'Search Console should be configured');
assert(JSON.stringify(healthBody).includes('report-secret') === false, 'Health must not leak bearer');

const denied = await handleSearchConsoleReportingRequest(new Request('https://worker.test/internal/search-console/report'), env());
assert(denied?.status === 401, 'Search Console report should require bearer');

const sites = await handleSearchConsoleReportingRequest(new Request('https://worker.test/internal/search-console/sites', { headers: { Authorization: 'Bearer report-secret' } }), env());
assert(sites?.status === 200, 'Search Console sites should succeed');
const sitesBody = await sites.json();
assert(sitesBody.sites[0].site_url === 'sc-domain:devidlabel.com', 'Configured property should be visible');

const report = await handleSearchConsoleReportingRequest(new Request('https://worker.test/internal/search-console/report?timeframe=last_28_days', { headers: { Authorization: 'Bearer report-secret' } }), env());
assert(report?.status === 200, 'Search Console report should succeed');
const reportBody = await report.json();
assert(reportBody.totals.clicks === 10, 'Totals should normalize clicks');
assert(reportBody.queries.rows[0].keys[0] === 'sprayground zaini', 'Query rows should be returned');
assert(calls.filter((call) => call.url.includes('/searchAnalytics/query')).length === 6, 'Bundle should request six Search Console views');
assert(calls.every((call) => call.url.includes('/searchAnalytics/query') ? call.init.headers.Authorization === 'Bearer access-token' : true), 'OAuth token must stay upstream');

console.log('Search Console reporting bridge tests passed.');
