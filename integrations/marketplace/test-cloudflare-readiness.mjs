import assert from 'node:assert/strict';
import { classifySubscriptions, inspectCloudflare } from './cloudflare-readiness.mjs';

const account = 'a'.repeat(32);
const fixture = { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: 'fixture-secret' };
const paid = { success: true, result: [{rate_plan:{id:'workers_paid',public_name:'Workers Paid'},current_period_end:'2099-01-01T00:00:00Z'}] };
assert.equal(classifySubscriptions(paid), 'paid_confirmed');
assert.equal(classifySubscriptions({success:true,result:[{rate_plan:{id:'workers_free'}}]}), 'free_confirmed');
assert.equal(classifySubscriptions({success:true,result:[{rate_plan:{id:'pro',public_name:'Pro Plan'}}]}), 'unverified');
assert.equal(classifySubscriptions({success:false,result:paid.result}), 'unverified');
assert.equal(classifySubscriptions({success:true,result:[{rate_plan:{id:'workers_paid'},current_period_end:'2020-01-01'}]}), 'unverified');
const denied = await inspectCloudflare(fixture, async () => new Response('{}', {status:403}));
assert.equal(denied.reason, 'billing_read_permission_unavailable');
assert.equal(denied.can_enable_full_catalog_scans, false);
const good = await inspectCloudflare(fixture, async (_url, options) => {
  assert.equal(options.method, 'GET');
  return Response.json(paid);
});
assert.equal(good.can_enable_full_catalog_scans, true);
assert.ok(!JSON.stringify(good).includes('fixture-secret'));
assert.ok(!JSON.stringify(good).includes(account));
assert.equal((await inspectCloudflare({}, async () => { throw Error('must not call'); })).reason, 'existing_deploy_credentials_missing');
console.log('PASS: paid/free/unknown/expired plans, denied access, existing credentials and safe report');
