import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = mkdtempSync(join(tmpdir(), 'google-ads-reporting-'));
execFileSync('npx', ['tsc', '--outDir', out, '--noEmit', 'false', '--module', 'ESNext', '--target', 'ES2022', '--moduleResolution', 'Bundler'], { stdio: 'inherit' });
const { handleGoogleAdsReportingRequest } = await import(`file://${join(out, 'google-ads-reporting.js')}`);

const assert = (condition, message) => {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
};

const env = () => ({
  GOOGLE_ADS_CLIENT_ID: 'client-id',
  GOOGLE_ADS_CLIENT_SECRET: 'client-secret',
  GOOGLE_ADS_REFRESH_TOKEN: 'refresh-token',
  GOOGLE_ADS_DEVELOPER_TOKEN: 'developer-token',
  GOOGLE_ADS_CUSTOMER_ID: '211-712-6418',
  GOOGLE_ADS_API_VERSION: 'v24',
  GOOGLE_ADS_REPORT_ACCESS_TOKEN: 'report-secret',
});

let calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  calls.push({ url, init });
  if (url === 'https://oauth2.googleapis.com/token') {
    return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600, token_type: 'Bearer' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.includes('/v24/customers/2117126418/googleAds:searchStream')) {
    return new Response(JSON.stringify([{
      results: [{
        segments: { date: '2026-07-30' },
        campaign: { id: '123', name: 'Search Brand', status: 'ENABLED', advertisingChannelType: 'SEARCH' },
        metrics: {
          costMicros: '100000000',
          impressions: '10000',
          clicks: '500',
          ctr: 0.05,
          averageCpc: '200000',
          conversions: 8,
          conversionsValue: 480,
          allConversions: 9,
          allConversionsValue: 510,
        },
      }],
    }]), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
};

const health = await handleGoogleAdsReportingRequest(new Request('https://worker.test/internal/google-ads/health'), env());
assert(health?.status === 200, 'Google Ads health should be safe/public');
const healthJson = await health.json();
assert(healthJson.api_version === 'v24', 'Google Ads bridge should use v24');
assert(JSON.stringify(healthJson).includes('refresh-token') === false, 'health must not leak OAuth secrets');

const denied = await handleGoogleAdsReportingRequest(new Request('https://worker.test/internal/google-ads/report'), env());
assert(denied?.status === 401, 'Google Ads report should require bearer');

const report = await handleGoogleAdsReportingRequest(new Request('https://worker.test/internal/google-ads/report?timeframe=yesterday', {
  headers: { Authorization: 'Bearer report-secret' },
}), env());
assert(report?.status === 200, 'Google Ads report should succeed');
const body = await report.json();
assert(body.customer_id === '2117126418', 'customer ID should normalize');
assert(body.totals.spend === 100, 'cost micros should normalize to EUR');
assert(body.totals.conversion_value === 480, 'conversion value should normalize');
assert(body.totals.conversion_roas === 4.8, 'ROAS should normalize');
assert(body.rows[0].campaign_name === 'Search Brand', 'campaign should be returned');

const oauthCall = calls.find((call) => call.url === 'https://oauth2.googleapis.com/token');
assert(oauthCall, 'OAuth refresh should be called');
const adsCall = calls.find((call) => call.url.includes('googleAds:searchStream'));
assert(adsCall, 'Google Ads searchStream should be called');
assert(adsCall.init.headers['developer-token'] === 'developer-token', 'developer token must be upstream only');
assert(adsCall.init.headers.Authorization === 'Bearer access-token', 'short-lived OAuth token must be upstream only');
assert(String(adsCall.init.body).includes("segments.date BETWEEN"), 'query should constrain requested dates');

console.log('Google Ads reporting bridge tests passed.');
