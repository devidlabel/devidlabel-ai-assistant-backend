import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = mkdtempSync(join(tmpdir(), 'klaviyo-reporting-'));
execFileSync('npx', ['tsc', '--outDir', out, '--noEmit', 'false', '--module', 'ESNext', '--target', 'ES2022', '--moduleResolution', 'Bundler'], { stdio: 'inherit' });
const compiled = join(out, 'klaviyo-reporting.js');
const { handleKlaviyoReportingRequest } = await import('file://' + compiled);

const assert = (condition, message) => {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
};

const env = {
  KLAVIYO_PRIVATE_API_KEY: 'pk_test',
  KLAVIYO_REPORT_ACCESS_TOKEN: 'report-secret',
};
const request = () => new Request('https://worker.test/internal/klaviyo/report?timeframe=last_7_days', {
  headers: { Authorization: 'Bearer report-secret' },
});
let metricsCalls = 0;
let campaignCalls = 0;
let flowCalls = 0;
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname;
  if (path === '/api/metrics') {
    metricsCalls += 1;
    return new Response(JSON.stringify({ data: [{
      id: 'metric-placed-order',
      attributes: { name: 'Placed Order', integration: { name: 'Shopify' } },
    }], links: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (path === '/api/campaign-values-reports/') {
    campaignCalls += 1;
    if (campaignCalls === 1) {
      return new Response(JSON.stringify({ errors: [{ detail: 'rate limited' }] }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'Retry-After': '0' },
      });
    }
    return new Response(JSON.stringify({ data: { attributes: { results: [{ statistics: { recipients: 10 } }] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (path === '/api/flow-values-reports/') {
    flowCalls += 1;
    return new Response(JSON.stringify({ data: { attributes: { results: [{ statistics: { recipients: 20 } }] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
};

let response = await handleKlaviyoReportingRequest(request(), env);
let payload = await response.json();
assert(response.status === 200 && payload.ok === true, 'Klaviyo report should recover from 429');
assert(campaignCalls === 2, 'Klaviyo campaign report should retry once after 429');
assert(flowCalls === 1, 'Klaviyo flow report should run sequentially once');
assert(metricsCalls === 1, 'Placed Order metric should resolve once');
assert(payload.cache.hit === false, 'first Klaviyo response should be uncached');

response = await handleKlaviyoReportingRequest(request(), env);
payload = await response.json();
assert(response.status === 200 && payload.cache.hit === true, 'second Klaviyo response should use cache');
assert(campaignCalls === 2 && flowCalls === 1 && metricsCalls === 1, 'cached report should avoid additional Klaviyo API calls');

console.log('Klaviyo reporting resilience tests passed');
