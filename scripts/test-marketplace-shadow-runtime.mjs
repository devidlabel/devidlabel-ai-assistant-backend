import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// Local workerd test with a synthetic reader: no network, OAuth or customer data.
const built = await build({
  stdin: {
    contents: `import {MareMarketplaceShadow,handleMarketplaceShadowStatus} from './src/marketplace-shadow.ts';
      export {MareMarketplaceShadow};
      export default {async fetch(request,env) {
        if(new URL(request.url).pathname==='/tick') {
          return env.MARE_MARKETPLACE_SHADOW.get(env.MARE_MARKETPLACE_SHADOW.idFromName('devidlabel:catalog:v1'))
            .fetch(new Request('https://shadow/tick',{method:'POST'}));
        }
        return await handleMarketplaceShadowStatus(request,env) || new Response('missing',{status:404});
      }};`,
    resolveDir: process.cwd(), sourcefile: 'runtime-fixture.ts', loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'],
  plugins: [{ name: 'fixture-reader', setup(b) {
    b.onResolve({ filter: /mare-business-shopify-complete\.js$/ }, () => ({ path: 'reader', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export async function readShopifyCatalogComplete() {
      return {ok:true,product_count:1,variant_count:1,complete_variant_pagination:true,
        truncated:false,next_cursor:null,complete_related_pagination:true,
        products:[{id:'p1',variants:[{id:'v1',sku:'ABC-42',inventory_quantity:3}]}]};
    }` }));
  } }],
});
const persist = await mkdtemp(join(tmpdir(), 'mare-shadow-runtime-'));
const options = {
  name: 'shadow-fixture', modules: true, script: built.outputFiles[0].text,
  compatibilityDate: '2026-06-25',
  bindings: { MARE_MARKETPLACE_SHADOW_ENABLED: 'true', MARE_BUSINESS_ACCESS_TOKEN: 'fixture-token' },
  durableObjects: { MARE_MARKETPLACE_SHADOW: { className: 'MareMarketplaceShadow', useSQLite: true } },
  durableObjectsPersist: persist, log: new Log(LogLevel.ERROR),
};
let mf;
try {
  mf = new Miniflare(options);
  const url = 'https://fixture/internal/marketplace/status';
  const auth = { headers: { Authorization: 'Bearer fixture-token' } };
  assert.equal((await mf.dispatchFetch(url)).status, 401);
  assert.equal((await mf.dispatchFetch('https://fixture/tick', { method: 'POST' })).status, 200);
  let status;
  for (let i = 0; i < 50; i++) {
    status = await (await mf.dispatchFetch(url, auth)).json();
    if (status.last_completed_at) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(status.healthy, true, JSON.stringify(status));
  assert.equal(status.products, 1); assert.equal(status.ready_for_marketplace_writes, false);
  await mf.dispose(); mf = new Miniflare(options);
  const restored = await (await mf.dispatchFetch(url, auth)).json();
  assert.equal(restored.last_completed_at, status.last_completed_at);
  assert.equal(restored.variants, 1);
  console.log('PASS local workerd: bearer, SQLite transactions, durable alarm, snapshot, persistence after runtime restart');
} finally {
  await mf?.dispose(); await rm(persist, { recursive: true, force: true });
}
