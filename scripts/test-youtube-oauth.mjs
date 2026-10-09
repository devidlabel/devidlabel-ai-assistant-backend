import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = stripTypeScriptTypes(readFileSync('src/mare-business-youtube.ts', 'utf8').replace(/export /g, ''));
for (const [code, expected] of [['invalid_grant', 'invalid_grant'], ['invalid_client', 'invalid_client'], ['unexpected_SECRET_VALUE', 'token_exchange_failed']]) {
  let calls = 0, writes = 0;
  const ctx = { URL, URLSearchParams, Response, Date, crypto, fetch: async () => {
    calls++;
    return new Response(JSON.stringify({ error: code, error_description: 'Bad Request SECRET_VALUE' }), {status:400});
  }};
  vm.createContext(ctx);
  vm.runInContext(source+';globalThis.readChannel=readYouTubeChannel;',ctx);
  const env = { YOUTUBE_CLIENT_ID:'fixture-id', YOUTUBE_CLIENT_SECRET:'fixture-secret', SHOPIFY_TOKENS_KV:{
    get:async()=>JSON.stringify({refresh_token:'fixture-refresh',authorized_at:'2026-08-20T00:00:00Z'}),
    put:async()=>{writes++;},
  }};
  await assert.rejects(()=>ctx.readChannel({},env),error=>error.message===`youtube_oauth_${expected}:http_400` && !error.message.includes('SECRET_VALUE'));
  assert.equal(calls,1,'failed refresh must not call the Data API');
  assert.equal(writes,0,'failed refresh must preserve existing authorization');
}
console.log('PASS YouTube OAuth code survives vague description, secrets are excluded, failed refresh preserves credentials and does not call Data API');
