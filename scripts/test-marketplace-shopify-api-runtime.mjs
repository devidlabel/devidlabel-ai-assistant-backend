import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare, Log, LogLevel} from "miniflare";
import {readFile} from "node:fs/promises";

// Synthetic credentials, shop, order and tracking only. The transport is
// replaced, while the shared Shopify client and actual Worker routes run.
let checks=0;
const equal=(a,b,label)=>{assert.equal(a,b,label);checks++;};
const deep=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
const truth=(value,label)=>{assert(value,label);checks++;};
async function bundleImport(path){
  const built=await build({entryPoints:[path],bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
  return import("data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));
}
const client=await bundleImport("src/index.ts");
const config=await bundleImport("src/shopify-app-config.ts");
const readiness=await bundleImport("src/marketplace-shopify-api-readiness.ts");
const existingScopes=["read_all_orders","read_customers","read_discounts","write_discounts","read_files","write_files",
  "read_inventory","write_inventory","read_locales","read_locations","read_markets","read_online_store_navigation",
  "write_online_store_navigation","read_online_store_pages","read_orders","read_products","write_products","read_reports",
  "read_returns","read_shopify_payments_payouts","read_content","write_content","read_metaobject_definitions",
  "write_metaobject_definitions","read_metaobjects","write_metaobjects","read_translations","write_translations","write_publications"];
const configuredScopes=config.SHOPIFY_OAUTH_SCOPES.split(",");
deep(configuredScopes.filter(x=>!existingScopes.includes(x)),["write_orders"],"Only the planned order scope is added");
deep(existingScopes.filter(x=>!configuredScopes.includes(x)),[],"Existing operational scopes are preserved");
equal(new Set(configuredScopes).size,configuredScopes.length);
equal(config.DEFAULT_SHOPIFY_API_VERSION,"2026-01");
truth((await readFile("wrangler.toml","utf8")).includes('SHOPIFY_API_VERSION = "'+config.DEFAULT_SHOPIFY_API_VERSION+'"'));

const kv=new Map();
let kvWrites=0,transportCalls=0;
const env={SHOPIFY_SHOP_DOMAIN:"synthetic.myshopify.com",SHOPIFY_CLIENT_ID:"SYNTHETIC_CLIENT",
  SHOPIFY_CLIENT_SECRET:"SYNTHETIC_SECRET",SHOPIFY_TOKEN_ENCRYPTION_KEY:Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
  SHOPIFY_ADMIN_ACCESS_TOKEN:"SYNTHETIC_LEGACY_TOKEN",SHOPIFY_TOKENS_KV:{
    get:async key=>kv.get(key)??null,put:async(key,value)=>{kvWrites++;kv.set(key,value);},delete:async key=>kv.delete(key)
  }};
await client.persistShopifyOAuthToken(env,env.SHOPIFY_SHOP_DOMAIN,"SYNTHETIC_OAUTH_TOKEN",config.SHOPIFY_OAUTH_SCOPES);
kvWrites=0;
const nativeFetch=globalThis.fetch;
let servedVersion="2026-01",httpStatus=200,payload={data:{currentAppInstallation:{id:"gid://shopify/AppInstallation/7001"}}};
try{
  globalThis.fetch=async(url,init)=>{
    transportCalls++;
    equal(String(url),"https://synthetic.myshopify.com/admin/api/2026-01/graphql.json");
    equal(init.method,"POST");
    equal(new Headers(init.headers).get("X-Shopify-Access-Token"),"SYNTHETIC_OAUTH_TOKEN","OAuth KV remains authoritative over the legacy token");
    deep(JSON.parse(init.body),{query:readiness.SHOPIFY_API_READINESS_QUERY,variables:{}});
    truth(init.signal instanceof AbortSignal);
    return new Response(JSON.stringify(payload),{status:httpStatus,headers:{"Content-Type":"application/json",
      ...(servedVersion===null?{}:{"X-Shopify-API-Version":servedVersion})}});
  };
  const observed=await client.shopifyGraphQLWithMetadata(env,readiness.SHOPIFY_API_READINESS_QUERY);
  deep(observed,{...payload,requested_api_version:"2026-01",served_api_version:"2026-01"});
  deep(await client.shopifyGraphQL(env,readiness.SHOPIFY_API_READINESS_QUERY),payload.data,"Existing callers still receive exactly data");
  servedVersion="2026-04";
  equal((await client.shopifyGraphQLWithMetadata(env,readiness.SHOPIFY_API_READINESS_QUERY)).served_api_version,"2026-04","Never substitute the configured version for an observed mismatch");
  servedVersion=null;
  equal((await client.shopifyGraphQLWithMetadata(env,readiness.SHOPIFY_API_READINESS_QUERY)).served_api_version,null);
  for(const [status,message] of [[401,"shopify_lookup_unauthorized"],[403,"shopify_lookup_forbidden"],[429,"shopify_lookup_rate_limited"],[503,"shopify_status_503"]]){
    httpStatus=status;
    await assert.rejects(()=>client.shopifyGraphQL(env,readiness.SHOPIFY_API_READINESS_QUERY),error=>error.message===message);checks++;
  }
  httpStatus=200;payload={data:null};
  await assert.rejects(()=>client.shopifyGraphQL(env,readiness.SHOPIFY_API_READINESS_QUERY),/shopify_empty_data/);checks++;
  payload={errors:[{message:"SYNTHETIC_PRIVATE_UPSTREAM_ERROR"}]};
  await assert.rejects(()=>client.shopifyGraphQLWithMetadata(env,readiness.SHOPIFY_API_READINESS_QUERY),/shopify_lookup_query_error/);checks++;
  equal(kvWrites,0,"Reads do not modify token storage");
  equal(transportCalls,10,"Exactly one provider request for each client call");
}finally{globalThis.fetch=nativeFetch;}

const fixture=`
 import worker from "./src/worker-v4.ts";
 const GID="gid://shopify/Order/9101",OID="123-1234567-1234567",LID="gid://shopify/LineItem/9102";
 const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json",...headers}});
 let mode="",metrics;
 globalThis.fetch=async(input,init)=>{
   const req=input instanceof Request?input:new Request(input,init),url=new URL(req.url);
   metrics.provider_calls++;
   if(url.hostname!=="synthetic.myshopify.com"||url.pathname!=="/admin/api/2026-01/graphql.json"||req.method!=="POST")
     throw Error("UNMOCKED_TRANSPORT_FORBIDDEN");
   if(req.headers.get("X-Shopify-Access-Token")!=="SYNTHETIC_WORKER_TOKEN")throw Error("WRONG_SYNTHETIC_TOKEN");
   const body=await req.json(),query=body.query||"";
   if(/\\bmutation\\b/i.test(query)){metrics.provider_mutations++;throw Error("MUTATION_FORBIDDEN");}
   let data;
   const order={id:GID,sourceName:"amazon",sourceIdentifier:OID,app:{name:"Channable"},customAttributes:[{key:"Amazon Order ID",value:OID}]};
   if(query.includes("MareMarketplaceShopifyApiReadiness"))data={currentAppInstallation:{id:"gid://shopify/AppInstallation/7001"}};
   else if(query.includes("MareMarketplaceCurrentAppScopes"))data={currentAppInstallation:{id:"gid://shopify/AppInstallation/7001",accessScopes:[{handle:"read_orders"}]}};
   else if(query.includes("MareChannableImportedAmazonOrder")){
     if(body.variables.id!==GID)throw Error("WRONG_ORDER_SELECTOR");
     data={order:{...order,lineItems:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[{id:LID,sku:"SYNTHETIC_SKU",quantity:1,currentQuantity:1,variant:{id:"gid://shopify/ProductVariant/9103"}}]}}};
   }else if(query.includes("MareChannableMarketplaceFulfillments")){
     if(body.variables.id!==GID)throw Error("WRONG_FULFILLMENT_SELECTOR");
     data={order:{...order,displayFulfillmentStatus:"FULFILLED",fulfillments:[{id:"gid://shopify/Fulfillment/9104",status:mode==="failed_shipment"?"FAILURE":"SUCCESS",displayStatus:"CONFIRMED",
       trackingInfo:[{company:"Synthetic carrier",number:mode==="missing_tracking"?null:"SYNTHETIC_TRACKING_CANARY"}],
       fulfillmentLineItems:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[{id:"gid://shopify/FulfillmentLineItem/9105",quantity:1,lineItem:{id:LID,sku:"SYNTHETIC_SKU"}}]}}]}};
   }else throw Error("UNEXPECTED_GRAPHQL_QUERY");
   if(mode==="upstream_error")return json({errors:[{message:"SYNTHETIC_PRIVATE_CANARY"}]});
   const version=mode==="version_mismatch"?"2026-04":mode==="invalid_header"?"SYNTHETIC_PRIVATE_CANARY":"2026-01";
   return json({data},200,mode==="missing_header"?{}:{"X-Shopify-API-Version":version});
 };
 export default {async fetch(req,env,ctx){
   mode=req.headers.get("x-fixture-mode")||"";metrics={provider_calls:0,provider_mutations:0,kv_puts:0,state_ttls:[]};
   const runtimeEnv={...env,SHOPIFY_TOKENS_KV:{get:async()=>null,put:async(key,value,options)=>{
     metrics.kv_puts++;if(!key.startsWith("shopify:oauth_state:"))throw Error("UNEXPECTED_KV_WRITE");
     const state=JSON.parse(value);if(state.shop!=="synthetic.myshopify.com")throw Error("WRONG_STATE_SHOP");
     metrics.state_ttls.push(options?.expirationTtl);
   },delete:async()=>{throw Error("UNEXPECTED_KV_DELETE");}}};
   const response=await worker.fetch(req,runtimeEnv,ctx);
   if(response.status>=300&&response.status<400)return json({status:response.status,location:response.headers.get("Location"),cache_control:response.headers.get("Cache-Control"),metrics});
   let result;try{result=await response.json();}catch{result={non_json:true};}
   return json({status:response.status,result,metrics},response.status);
 }};
`;
const built=await build({stdin:{contents:fixture,sourcefile:"shopify-api-runtime-fixture.ts",resolveDir:process.cwd(),loader:"ts"},
  bundle:true,write:false,format:"esm",platform:"browser",external:["cloudflare:workers"],logLevel:"silent"});
let escapes=0;
const token="SYNTHETIC_MARE_TOKEN";
const mf=new Miniflare({name:"shopify-api-runtime-test",modules:true,script:built.outputFiles[0].text,
  compatibilityDate:"2026-06-25",bindings:{MARE_BUSINESS_ACCESS_TOKEN:token,SHOPIFY_SHOP_DOMAIN:"synthetic.myshopify.com",
    SHOPIFY_API_VERSION:"2026-01",SHOPIFY_ADMIN_ACCESS_TOKEN:"SYNTHETIC_WORKER_TOKEN",SHOPIFY_CLIENT_ID:"SYNTHETIC_CLIENT",
    SHOPIFY_CLIENT_SECRET:"SYNTHETIC_SECRET",SHOPIFY_TOKEN_ENCRYPTION_KEY:"SYNTHETIC_ENCRYPTION_KEY"},
  outboundService:async()=>{escapes++;return new Response("NETWORK_FORBIDDEN",{status:503});},log:new Log(LogLevel.ERROR)});
async function rpc(name,id,request={},mode="",auth=true){
  const response=await mf.dispatchFetch("https://fixture/mcp-business",{method:"POST",headers:{"Content-Type":"application/json",
    "MCP-Protocol-Version":"2025-06-18","x-fixture-mode":mode,...(auth?{Authorization:"Bearer "+token}:{})},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:{capability_id:id,request}}})});
  const body=await response.json();
  return {...body,tool:body.result?.result,data:body.result?.result?.structuredContent};
}
function noWrites(result){equal(result.metrics.provider_mutations,0);equal(result.metrics.kv_puts,0);truth(!JSON.stringify(result).includes("CANARY"));}
try{
  const apiId="shopify.marketplace.api_readiness.readonly",reviewId="shopify.marketplace.amazon_fulfillment_review.readonly";
  for(const id of [apiId,reviewId]){
    const described=await rpc("mare_describe",id);
    equal(described.data.capability?.id??described.data.id,id);
    equal(described.metrics.provider_calls,0);noWrites(described);
    const denied=await rpc("mare_read",id,{},"",false);
    equal(denied.status,401);equal(denied.metrics.provider_calls,0);noWrites(denied);
  }
  const live=await rpc("mare_read",apiId);
  equal(live.data.status,"API_VERSION_VERIFIED_EXECUTION_STILL_LOCKED");
  equal(live.data.requested_api_version,"2026-01");equal(live.data.served_api_version,"2026-01");
  equal(live.data.api_version_alignment_verified,true);equal(live.data.ready_for_marketplace_writes,false);
  equal(live.metrics.provider_calls,1);noWrites(live);
  for(const [mode,status] of [["version_mismatch","API_VERSION_MISMATCH"],["missing_header","API_VERSION_HEADER_MISSING"],["invalid_header","API_VERSION_HEADER_INVALID"]]){
    const observed=await rpc("mare_read",apiId,{},mode);
    equal(observed.data.status,status);equal(observed.data.api_version_alignment_verified,false);noWrites(observed);
  }
  const invalid=await rpc("mare_read",apiId,{query:"SYNTHETIC_CALLER_QUERY"});
  equal(invalid.tool.isError,true);equal(invalid.metrics.provider_calls,0);noWrites(invalid);
  const failed=await rpc("mare_read",apiId,{},"upstream_error");
  equal(failed.tool.isError,true);noWrites(failed);
  const scopes=await rpc("mare_read","shopify.marketplace.scopes.readonly");
  equal(scopes.data.fulfillment_tracking_read_scope_present,true);
  equal(scopes.data.order_create_scope_present,false);noWrites(scopes);
  const selector={shopify_order_gid:"gid://shopify/Order/9101",amazon_order_id:"123-1234567-1234567"};
  const review=await rpc("mare_read",reviewId,selector);
  equal(review.data.source,"shopify_channable_amazon_fulfillment_review");
  equal(review.data.importer_ownership,"NOT_TRANSFERRED_FROM_CHANNABLE");
  equal(review.data.comparison.coverage,"SHOPIFY_FULFILLMENT_LINES_COMPLETE");
  equal(review.data.comparison.amazon_tracking_confirmation_proven,false);
  equal(review.metrics.provider_calls,2);noWrites(review);
  truth(!JSON.stringify(review.data).includes(selector.amazon_order_id));
  truth(!JSON.stringify(review.data).includes("gid://shopify/"));
  const failedShipment=await rpc("mare_read",reviewId,selector,"failed_shipment");
  equal(failedShipment.data.comparison.fulfillment_line_units,0);noWrites(failedShipment);
  const invalidReview=await rpc("mare_read",reviewId,{...selector,shipments:[]});
  equal(invalidReview.tool.isError,true);equal(invalidReview.metrics.provider_calls,0);noWrites(invalidReview);
  const install=await (await mf.dispatchFetch("https://fixture/install?scope=write_fulfillments&redirect_uri=https://untrusted.invalid/callback")).json();
  equal(install.status,302);equal(install.cache_control,"no-store");
  const authorization=new URL(install.location);
  equal(authorization.origin,"https://synthetic.myshopify.com");equal(authorization.pathname,"/admin/oauth/authorize");
  equal(authorization.searchParams.get("scope"),config.SHOPIFY_OAUTH_SCOPES);
  equal(authorization.searchParams.get("redirect_uri"),"https://devidlabel-ai-assistant-backend.devidlabel.workers.dev/auth/callback");
  equal(authorization.searchParams.has("grant_options[]"),false,"The authorization code flow remains offline");
  truth(/^[a-f0-9]{32}$/.test(authorization.searchParams.get("state")));
  equal(install.metrics.kv_puts,1);deep(install.metrics.state_ttls,[600]);equal(install.metrics.provider_calls,0);
  const otherShop=await (await mf.dispatchFetch("https://fixture/install?shop=other.myshopify.com")).json();
  equal(otherShop.status,403);equal(otherShop.metrics.kv_puts,0);equal(otherShop.metrics.provider_calls,0);
  const wrongMethod=await (await mf.dispatchFetch("https://fixture/install",{method:"POST"})).json();
  equal(wrongMethod.status,405);equal(wrongMethod.metrics.kv_puts,0);
  equal(escapes,0,"No live network is reachable from the fixture");
}finally{await mf.dispose();}
console.log(`PASS Shopify API runtime: ${checks} checks; shared token/metadata path, actual Worker OAuth and authenticated read routes, no provider writes`);
