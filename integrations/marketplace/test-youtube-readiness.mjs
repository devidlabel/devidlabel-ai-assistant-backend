import assert from 'node:assert/strict';
import { inspectYouTube, classifyError } from './youtube-readiness.mjs';
let calls = 0;
assert.equal((await inspectYouTube({}, () => { calls++; })).reason, 'existing_probe_credential_missing');
assert.equal(calls, 0);
const secret = 'SECRET_FIXTURE_NEVER_PRINT';
const report = await inspectYouTube({ DAILY_PULSE_ACCESS_TOKEN: secret }, async (url, args) => {
  assert.equal(args.method, 'GET');
  assert.equal(args.redirect, 'error');
  assert.equal(args.headers.Authorization, `Bearer ${secret}`);
  return new Response(JSON.stringify({ ok: false, sections: {
    channel: { ok: false, error: `Token has been expired or revoked. ${secret}` },
    summary: { ok: false, error: `youtube_api_http_403: accessNotConfigured ${secret}` },
    videos: { ok: true, data: { secret } },
  } }), { status: 502 });
});
assert.equal(report.http_status, 502);
assert.equal(report.sections[0].reason, 'oauth_token_expired_or_revoked');
assert.equal(report.sections[1].reason, 'google_api_disabled');
assert.equal(report.sections[2].ok, true);
assert.equal(JSON.stringify(report).includes(secret), false);
assert.equal(classifyError(`unexpected ${secret}`), 'provider_read_failed');
assert.equal((await inspectYouTube({ DAILY_PULSE_ACCESS_TOKEN: secret }, async () => { throw Error(secret); })).reason, 'report_transport_or_payload_failed');
const ok = await inspectYouTube({ DAILY_PULSE_ACCESS_TOKEN: secret }, async () => new Response(JSON.stringify({ok:true, sections:{channel:{ok:true}}})));
assert.equal(ok.report_ok, true);
console.log('PASS YouTube HTTP failure body classification, successful reads, transport errors, missing credential and secret redaction');
