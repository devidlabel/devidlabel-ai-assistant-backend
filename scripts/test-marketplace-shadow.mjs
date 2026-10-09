import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../src/marketplace-shadow.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/export /g, '');
const js = stripTypeScriptTypes(source);
const HOUR = 3_600_000;
const clone = x => x === undefined ? undefined : structuredClone(x);

function harness(reader) {
  let now = 1000, serial = 0, alarmAt = null, failWrites = false;
  let rows = new Map(), tail = Promise.resolve();
  const operations = data => ({
    get: async key => clone(data.get(key)),
    put: async (key, value) => { if (failWrites && key.startsWith('snapshot:')) throw Error('disk'); data.set(key, clone(value)); },
    delete: async keys => { for (const key of keys) data.delete(key); },
    list: async ({ prefix, limit }) => new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
    setAlarm: async n => { alarmAt = n; },
    deleteAlarm: async () => { alarmAt = null; },
  });
  const store = {
    get: async key => clone(rows.get(key)),
    list: async opts => operations(rows).list(opts),
    deleteAlarm: async () => { alarmAt = null; },
    transaction(fn) {
      const result = tail.then(async () => {
        const staged = new Map([...rows].map(([k, v]) => [k, clone(v)]));
        const priorAlarm = alarmAt;
        try { const value = await fn(operations(staged)); rows = staged; return value; }
        catch (error) { alarmAt = priorAlarm; throw error; }
      });
      tail = result.catch(() => {});
      return result;
    },
  };
  const env = { MARE_MARKETPLACE_SHADOW_ENABLED: 'true', MARE_BUSINESS_ACCESS_TOKEN: 'fixture-token' };
  const calls = [];
  const ctx = {
    Request, Response, URL, TextEncoder, Uint8Array,
    Date: class extends Date { static now() { return now; } },
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    crypto: { randomUUID: () => `id-${++serial}`, subtle: crypto.subtle },
    console: { error() {} },
    DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
    readShopifyCatalogComplete: async (args, env) => { calls.push(args); return reader(args, env); },
  };
  vm.createContext(ctx);
  vm.runInContext(js + ';globalThis.api={MareMarketplaceShadow,shadowHealth,handleMarketplaceShadowStatus,scheduleMarketplaceShadow};', ctx);
  let runner = new ctx.api.MareMarketplaceShadow({ storage: store }, env);
  return {
    env, calls, api: ctx.api, get runner() { return runner; },
    restart() { runner = new ctx.api.MareMarketplaceShadow({ storage: store }, env); },
    time(n) { now = n; }, due() { now = alarmAt; },
    failWrites(v) { failWrites = v; },
    state: () => store.get('runner:v1'), rows: () => rows,
    tick: () => runner.fetch(new Request('https://shadow/tick', { method: 'POST' })),
    health: async () => (await runner.fetch(new Request('https://shadow/status'))).json(),
  };
}
const page = (id = 'p1', cursor = null, truncated = false, complete = true) => ({
  ok: true, products: [{ id, title: 'fixture', variants: [{ id: 'v' + id, sku: 'ABC-42', inventory_quantity: 4 }] }],
  product_count: 1, variant_count: 1, complete_variant_pagination: true,
  next_cursor: cursor, truncated, complete_related_pagination: complete,
});
let count = 0;
async function test(name, fn) { await fn(); count++; console.log(`PASS ${name}`); }

await test('disabled runner and watchdog make no catalog calls', async () => {
  const h = harness(() => page()); h.env.MARE_MARKETPLACE_SHADOW_ENABLED = 'false';
  await h.tick(); await h.runner.alarm(); await h.api.scheduleMarketplaceShadow(h.env);
  assert.equal(h.calls.length, 0); assert.equal((await h.health()).healthy, false);
});
await test('checkpoint and snapshot commit together, quantity stays zero', async () => {
  const h = harness(() => page('p1', 'next', true)); await h.tick(); h.due(); await h.runner.alarm();
  assert.equal((await h.state()).scan.cursor, 'next');
  const variant = [...h.rows()].find(([k]) => k.includes(':v:'))[1];
  assert.equal(variant.proposed_marketplace_quantity, 0);
  assert.equal(h.calls[0].persist_artifacts, false); assert.equal(h.calls[0].stable_order, true);
});
await test('restart resumes persisted cursor and finishes scan', async () => {
  const h = harness(args => args.after ? page('p2') : page('p1', 'next', true));
  await h.tick(); h.due(); await h.runner.alarm(); h.restart(); h.due(); await h.runner.alarm();
  assert.equal(h.calls[1].after, 'next'); assert.equal((await h.state()).completed.products, 2);
  assert.equal((await h.health()).healthy, true);
});
await test('duplicate alarms do not run a future page early', async () => {
  const h = harness(() => page()); await h.tick(); h.due(); await h.runner.alarm();
  await h.runner.alarm(); assert.equal(h.calls.length, 1);
});
await test('transient error retains cursor and schedules retry', async () => {
  let first = true; const h = harness(() => { if (first) { first = false; throw Error('secret must not be logged'); } return page(); });
  await h.tick(); h.due(); await h.runner.alarm();
  assert.equal((await h.state()).scan.cursor, null); assert.equal((await h.state()).failures, 1);
  assert.equal((await h.state()).last_error, 'catalog_read_or_storage_failed');
  assert.equal((await h.health()).healthy, false);
  h.due(); await h.runner.alarm(); assert.equal((await h.state()).failures, 0);
});
await test('malformed pagination is blocked instead of completed', async () => {
  const h = harness(() => page('p1', null, true)); await h.tick(); h.due(); await h.runner.alarm();
  assert.equal((await h.state()).last_error, 'invalid_page'); assert.equal((await h.state()).completed, undefined);
});
await test('partial payload cannot become a completed scan', async () => {
  const h = harness(() => ({ ...page(), product_count: 2 })); await h.tick(); h.due(); await h.runner.alarm();
  assert.equal((await h.state()).last_error, 'invalid_page');
});
await test('storage error rolls back snapshots and cursor', async () => {
  const h = harness(() => page()); await h.tick(); h.due(); h.failWrites(true); await h.runner.alarm();
  assert.equal((await h.state()).scan.pages, 0); assert.equal(h.rows().size, 1);
  h.failWrites(false); h.due(); await h.runner.alarm(); assert.equal((await h.state()).completed.products, 1);
});
await test('expired worker cannot commit after reassignment', async () => {
  let release; let calls = 0;
  const h = harness(() => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : page('new'));
  await h.tick(); h.due(); const old = h.runner.alarm();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  h.time(200_000); h.restart(); await h.runner.alarm(); release(page('old')); await old;
  assert.equal((await h.state()).completed.products, 1);
  assert.equal([...h.rows().keys()].some(k => k.endsWith(':p:old')), false);
});
await test('cleanup retains latest snapshot and deletes prior one', async () => {
  let id = 0; const h = harness(() => page('p' + ++id));
  await h.tick(); h.due(); await h.runner.alarm(); const first = (await h.state()).completed.id;
  h.due(); await h.runner.alarm(); const second = (await h.state()).completed.id;
  h.due(); await h.runner.alarm();
  assert.equal([...h.rows().keys()].some(k => k.startsWith(`snapshot:${first}:`)), false);
  assert.equal([...h.rows().keys()].some(k => k.startsWith(`snapshot:${second}:`)), true);
});
await test('staleness uses scan start and incomplete data is unhealthy', async () => {
  const h = harness(() => page('p1', null, false, false)); await h.tick(); h.due(); await h.runner.alarm();
  assert.equal((await h.health()).healthy, false);
  h.time(HOUR + 3000); assert.equal((await h.health()).stock_fresh, false);
  assert.equal((await h.health()).ready_for_marketplace_writes, false);
});
await test('numeric SKU stays zero and digit-leading brand quarantines', async () => {
  const h = harness(() => { const p = page(); p.products[0].variants = [{id:'v1',sku:'123'}, {id:'v2',sku:'4B12-42'}]; p.variant_count = 2; return p; });
  await h.tick(); h.due(); await h.runner.alarm();
  const variants = [...h.rows()].filter(([k]) => k.includes(':v:')).map(([, v]) => v);
  assert.equal(variants[0].sku_policy, 'legacy_zero'); assert.equal(variants[1].sku_policy, 'quarantine');
  assert.ok(variants.every(v => v.proposed_marketplace_quantity === 0));
});
await test('status requires bearer and a missing binding returns unavailable', async () => {
  const h = harness(() => page());
  const url = 'https://worker/internal/marketplace/status';
  assert.equal((await h.api.handleMarketplaceShadowStatus(new Request(url), h.env)).status, 401);
  assert.equal((await h.api.handleMarketplaceShadowStatus(new Request(url, { headers: { Authorization: 'Bearer fixture-token' } }), h.env)).status, 503);
});
await test('watchdog fails observably for a missing binding', async () => {
  const h = harness(() => page()); await assert.rejects(h.api.scheduleMarketplaceShadow(h.env), /binding_missing/);
});
console.log(`${count} marketplace shadow recovery checks passed`);
