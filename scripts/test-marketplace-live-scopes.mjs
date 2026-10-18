import assert from "node:assert/strict";
import {build} from "esbuild";

// Only synthetic responses. No live OAuth credentials or provider mutation.
const built=await build({entryPoints:["src/marketplace-shopify-scope-readiness.ts"],
  bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {readMarketplaceShopifyPermissionReadiness:readScopes,
  readMarketplaceShopifyCachedScopes:readCached}=await import(
  "data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));
const installationId="gid://shopify/AppInstallation/7001";
const scopeData=handles=>({currentAppInstallation:{
  id:installationId,accessScopes:handles.map(handle=>({handle}))
}});
let cacheReads=0;
const env={SHOPIFY_SHOP_DOMAIN:"synthetic-store.myshopify.com",
  SHOPIFY_API_VERSION:"2026-07",SHOPIFY_ADMIN_ACCESS_TOKEN:"SYNTHETIC_TOKEN_CANARY",
  SHOPIFY_TOKENS_KV:{get:async()=>{cacheReads++;return JSON.stringify({
    shop:"synthetic-store.myshopify.com",scope:"write_orders,write_inventory",
    encrypted_access_token:"PRIVATE_CIPHERTEXT_CANARY",iv:"PRIVATE_IV_CANARY",
    created_at:"2026-01-01T00:00:00Z"
  });},put:async()=>{throw new Error("A scope probe must not write KV");}}
};
const calls=[];
const reader=async(observedEnv,query,variables)=>{
  assert.equal(observedEnv,env,"The configured MARE client environment is preserved");
  assert(query.includes("currentAppInstallation { id accessScopes { handle } }"));
  assert(!query.includes("mutation"));
  assert.deepEqual(variables,{});
  calls.push(query);
  return scopeData(["read_orders","write_inventory"]);
};
const live=await readScopes(env,reader);
assert.equal(live.source,"shopify_current_app_installation");
assert.equal(live.scope_authority,"LIVE_CURRENT_AUTHENTICATED_APP");
assert.equal(live.live_scope_observation,true);
assert.equal(live.installation_id,installationId);
assert.deepEqual(live.required_scope_gaps.stock_read,[]);
assert.deepEqual(live.implied_read_scopes,["read_inventory"]);
assert.deepEqual(live.required_scope_gaps.order_create,["write_orders"]);
assert.equal(live.order_create_scope_present,false,"Cached write_orders must not become live permission");
assert.equal(cacheReads,0);
assert.equal(calls.length,1);
for(const name of ["can_import_orders","can_update_tracking","can_change_inventory","can_publish_offers"])
  assert.equal(live[name],false);
assert(!JSON.stringify(live).includes("CANARY"));
const cached=await readCached(env);
assert.equal(cached.scope_authority,"CACHED_NOT_LIVE");
assert.equal(cached.live_scope_observation,false);
assert.equal(cached.order_create_scope_present,true);
assert.deepEqual(cached.required_scope_gaps.stock_read,[]);
assert.equal(cached.can_import_orders,false);
assert(!JSON.stringify(cached).includes("CANARY"));

const write=await readScopes(env,async()=>scopeData(["write_orders","write_inventory"]));
assert.deepEqual(write.required_scope_gaps.order_read,[]);
assert.deepEqual(write.required_scope_gaps.order_create,[]);
assert.deepEqual(write.required_scope_gaps.stock_read,[]);
assert.equal(write.can_import_orders,false,"Granted scope never authorizes execution");
for(const handles of [["read_all_orders"],["write_marketplace_orders"],["read_marketplace_orders"],[]]){
  const row=await readScopes(env,async()=>scopeData(handles));
  assert.deepEqual(row.required_scope_gaps.order_read,["read_orders"]);
  assert.deepEqual(row.required_scope_gaps.order_create,["write_orders"]);
}
for(const malformed of [
  {},{currentAppInstallation:null},
  {currentAppInstallation:{id:"WRONG",accessScopes:[]}},
  {currentAppInstallation:{id:installationId,accessScopes:null}},
  scopeData(["read_orders","read_orders"]),
  scopeData(["read_orders\nPRIVATE_VALUE"]),
  scopeData([true]),
  {currentAppInstallation:{id:installationId,accessScopes:[null]}}
])await assert.rejects(()=>readScopes(env,async()=>malformed),/marketplace_shopify_scope_(live_response|metadata)_invalid/);
const previousCacheReads=cacheReads;
await assert.rejects(()=>readScopes(env,async()=>{
  throw new Error("PRIVATE_PROVIDER_BODY_AND_TOKEN_CANARY");
}),error=>error.message==="marketplace_shopify_scope_live_probe_failed");
assert.equal(cacheReads,previousCacheReads,"Failed live probe cannot fall back to cached scopes");
await assert.rejects(()=>readScopes({...env,SHOPIFY_SHOP_DOMAIN:"wrong-host.example"},reader),/live_config_invalid/);

// Use the production Shopify client, replacing only its HTTPS transport.
const originalFetch=globalThis.fetch;
let transportCalls=0;
try{
  globalThis.fetch=async(url,init={})=>{
    const u=new URL(String(url));
    assert.equal(u.host,"synthetic-store.myshopify.com");
    assert.equal(u.pathname,"/admin/api/2026-07/graphql.json");
    assert.equal(init.method,"POST");
    assert.equal(new Headers(init.headers).get("X-Shopify-Access-Token"),"SYNTHETIC_TOKEN_CANARY");
    const body=JSON.parse(init.body);
    assert(body.query.includes("MareMarketplaceCurrentAppScopes"));
    assert(!body.query.includes("mutation"));
    transportCalls++;
    return new Response(JSON.stringify({data:scopeData(["read_orders","write_inventory"])}),{
      status:200,headers:{"Content-Type":"application/json"}
    });
  };
  const throughClient=await readScopes({...env,SHOPIFY_TOKENS_KV:{get:async()=>null,put:async()=>{throw new Error("unexpected write");}}});
  assert.equal(throughClient.live_scope_observation,true);
  assert.equal(throughClient.inventory_write_scope_present,true);
  assert.deepEqual(throughClient.required_scope_gaps.stock_read,[]);
  assert.equal(transportCalls,1);
  assert(!JSON.stringify(throughClient).includes("SYNTHETIC_TOKEN_CANARY"));
}finally{globalThis.fetch=originalFetch;}
console.log("PASS live Shopify scope evidence: current app, write-to-read implication, no cache fallback, no secret output and no write authorization");
