import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,Log,LogLevel} from "miniflare";

let checks=0,escapes=0;
const equal=(a,b,label)=>{assert.equal(a,b,label);checks++;};
const deep=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
const truth=(value,label)=>{assert(value,label);checks++;};
const built=await build({entryPoints:["scripts/fixtures/marketplace-shipment-worker.ts"],bundle:true,
  write:false,format:"esm",platform:"browser",external:["cloudflare:workers"],logLevel:"silent"});
const token="SYNTHETIC_MARE_CANARY",id="marketplace.amazon.shipment_reconciliation.readonly";
const selector={marketplace:"DE",shopify_order_gid:"gid://shopify/Order/9201",amazon_order_id:"123-1234567-1234567"};
const mf=new Miniflare({name:"marketplace-shipment-runtime",modules:true,script:built.outputFiles[0].text,
  compatibilityDate:"2026-06-25",bindings:{
    MARE_BUSINESS_ACCESS_TOKEN:token,SHOPIFY_SHOP_DOMAIN:"synthetic.myshopify.com",
    SHOPIFY_API_VERSION:"2026-01",SHOPIFY_ADMIN_ACCESS_TOKEN:"SYNTHETIC_SHOPIFY_CANARY",
    AMAZON_SP_API_CLIENT_ID:"SYNTHETIC_CLIENT",AMAZON_SP_API_CLIENT_SECRET:"SYNTHETIC_SECRET_CANARY",
    AMAZON_SP_API_REFRESH_TOKEN:"SYNTHETIC_REFRESH_CANARY",AMAZON_SP_API_SELLER_ID:"SYNTHETICSELLER01"
  },outboundService:async()=>{escapes++;return new Response("NETWORK_FORBIDDEN",{status:503});},
  log:new Log(LogLevel.ERROR)});
async function rpc(name,request={},mode="",auth=true,capabilityId=id){
  const response=await mf.dispatchFetch("https://fixture/mcp-business",{method:"POST",headers:{
    "Content-Type":"application/json","MCP-Protocol-Version":"2025-06-18","x-fixture-mode":mode,
    ...(auth?{Authorization:"Bearer "+token}:{})
  },body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",
    params:{name,arguments:{capability_id:capabilityId,request}}})});
  const body=await response.json();
  return {...body,tool:body.result?.result,data:body.result?.result?.structuredContent};
}
function noEffects(r){
  equal(r.metrics.provider_mutations,0);equal(r.metrics.storage_writes,0);equal(r.metrics.unmocked_requests,0);
  truth(!JSON.stringify(r).includes("CANARY"),"No credentials, tracking, customer fields or upstream error text escape");
}
function noReads(r){
  equal(r.metrics.amazon_reads,0);equal(r.metrics.shopify_reads,0);equal(r.metrics.token_requests,0);noEffects(r);
}
function privateReport(r){
  equal(r.tool.isError,false);
  const data=r.data;
  equal(data.source,"shopify_amazon_shipment_reconciliation");equal(data.read_only,true);equal(data.provider_mutations,0);
  equal(data.importer_ownership,"NOT_TRANSFERRED_FROM_CHANNABLE");
  for(const key of ["can_confirm_marketplace_shipment","can_change_shopify_fulfillment","can_release_stock_reservation",
    "can_change_inventory","carrier_mapping_proven","carrier_handover_proven","amazon_tracking_confirmation_proven"])
    equal(data[key],false,key);
  const serialized=JSON.stringify(data);
  for(const value of [selector.amazon_order_id,selector.shopify_order_gid,"gid://shopify/","SYNTHETIC_SKU","SYNTHETICSELLER01","SYNTHETIC_AMAZON_ITEM","SYNTHETIC_PACKAGE"])
    truth(!serialized.includes(value),"Private source identifiers are not returned");
  noEffects(r);
}
try{
  const described=await rpc("mare_describe");
  const cap=described.data.capability;
  equal(cap.id,id);equal(cap.available,true);equal(cap.operation,"read");equal(cap.risk,"read_only");equal(cap.approval,"none");
  equal(cap.request_schema.additionalProperties,false);
  deep(cap.request_schema.required,["marketplace","shopify_order_gid","amazon_order_id"]);noReads(described);
  const denied=await rpc("mare_read",selector,"",false);equal(denied.status,401);noReads(denied);
  const unavailable=await rpc("mare_read",selector,"unconfigured");equal(unavailable.tool.isError,true);noReads(unavailable);
  const prepare=await rpc("mare_prepare",selector);equal(prepare.tool.isError,true);noReads(prepare);
  for(const invalid of [{}, {...selector,marketplace:"US"}, {...selector,amazon_order_id:"../other"},
    {...selector,shopify_order_gid:"gid://shopify/Product/9201"},{...selector,observations:[]},{...selector,packages:[]}]){
    const rejected=await rpc("mare_read",invalid);equal(rejected.tool.isError,true);noReads(rejected);
  }
  const matched=await rpc("mare_read",selector);
  privateReport(matched);equal(matched.data.status,"REGISTERED_SHIPMENT_DATA_MATCHED");
  equal(matched.data.tracking_and_quantities_match,true);equal(matched.data.matched_package_count,1);
  equal(matched.data.amazon_package_count,1);equal(matched.data.shopify_successful_fulfillment_count,1);
  equal(matched.metrics.amazon_reads,1);equal(matched.metrics.shopify_reads,2);equal(matched.metrics.token_requests,1);
  for(const mode of ["missing_tracking","different_tracking","missing_packages","failed_shopify","multitracking"]){
    const review=await rpc("mare_read",selector,mode);privateReport(review);
    equal(review.data.tracking_and_quantities_match,false,mode);
    truth(review.data.status!=="REGISTERED_SHIPMENT_DATA_MATCHED",mode);
    if(mode==="missing_packages")equal(review.data.amazon_package_count,null);
  }
  for(const mode of ["amazon_http403","amazon_redirect","wrong_market","wrong_order"]){
    const rejected=await rpc("mare_read",selector,mode);equal(rejected.tool.isError,true);noEffects(rejected);
    equal(rejected.metrics.amazon_reads,1);
    if(mode==="amazon_http403")truth(JSON.stringify(rejected.tool).includes("http_403"),"Safe HTTP category survives the MCP boundary");
  }
  equal(escapes,0,"No live provider network was reachable");
}finally{await mf.dispose();}
console.log("PASS shipment Worker/MCP runtime: "+checks+" checks; authentication, exact provider reads, privacy and no writes");
