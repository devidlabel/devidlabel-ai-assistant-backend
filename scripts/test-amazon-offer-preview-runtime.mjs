import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,Log,LogLevel} from "miniflare";

let checks=0,escapes=0;
const equal=(actual,expected,label)=>{assert.equal(actual,expected,label);checks++;};
const deep=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const truth=(value,label)=>{assert(value,label);checks++;};
const built=await build({entryPoints:["scripts/fixtures/amazon-offer-preview-worker.ts"],bundle:true,
  write:false,format:"esm",platform:"browser",external:["cloudflare:workers"],logLevel:"silent"});
const token="SYNTHETIC_MARE_CANARY",id="amazon.offer.validation.preview";
const selector={marketplace:"IT",sku:"SYNTHETIC_PREVIEW_001",ean:"2000000001234",asin:"B0TEST0001"};
const mf=new Miniflare({name:"amazon-offer-preview-runtime",modules:true,script:built.outputFiles[0].text,
  compatibilityDate:"2026-06-25",bindings:{
    MARE_BUSINESS_ACCESS_TOKEN:token,SHOPIFY_SHOP_DOMAIN:"synthetic.myshopify.com",
    SHOPIFY_API_VERSION:"2026-01",SHOPIFY_ADMIN_ACCESS_TOKEN:"SYNTHETIC_SHOPIFY_CANARY",
    AMAZON_SP_API_CLIENT_ID:"SYNTHETIC_CLIENT",AMAZON_SP_API_CLIENT_SECRET:"SYNTHETIC_SECRET_CANARY",
    AMAZON_SP_API_REFRESH_TOKEN:"SYNTHETIC_REFRESH_CANARY",AMAZON_SP_API_SELLER_ID:"SYNTHETICSELLER01",
    AMAZON_OFFER_PREVIEW_ENABLED:"true"
  },outboundService:async()=>{escapes++;return new Response("NETWORK_FORBIDDEN",{status:503});},
  log:new Log(LogLevel.ERROR)});
async function rpc(name,request={},mode="",auth=true,args){
  const response=await mf.dispatchFetch("https://fixture/mcp-business",{method:"POST",headers:{
    "Content-Type":"application/json","MCP-Protocol-Version":"2025-06-18","x-fixture-mode":mode,
    ...(auth?{Authorization:"Bearer "+token}:{})
  },body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",
    params:{name,arguments:args??{capability_id:id,request}}})});
  const body=await response.json();
  return {...body,tool:body.result?.result,data:body.result?.result?.structuredContent};
}
function noMutationsOrLeaks(r){
  equal(r.metrics.provider_mutations,0);equal(r.metrics.storage_deletes,0);equal(r.metrics.unmocked_requests,0);
  equal(r.retained_private_data,false,"Raw provider errors, URLs and credentials never enter private plans");
  truth(!JSON.stringify(r).includes("CANARY"),"No credentials or arbitrary provider fields escape MCP");
}
function noReads(r){
  equal(r.metrics.amazon_reads,0);equal(r.metrics.shopify_reads,0);equal(r.metrics.token_requests,0);
  equal(r.metrics.preview_requests,0);equal(r.metrics.storage_writes,0);noMutationsOrLeaks(r);
}
function report(r){
  equal(r.tool.isError,false,JSON.stringify(r.tool));
  equal(r.data.plan.capability_id,id);equal(r.data.plan.status,"completed");
  equal(r.data.plan.risk,"artifact_only");equal(r.data.plan.approval,"none");
  equal(r.metrics.storage_writes,2,"Only prepared/completed records in private 24-hour plan store");
  const data=r.data.result;
  equal(data.preview_only,true);equal(data.provider_mutations,0);
  for(const key of ["offer_created","listing_write_enabled","can_publish","full_schema_validated",
    "gpsr_compliance_proven","channable_handoff_performed"])equal(data[key],false,key);
  noMutationsOrLeaks(r);
  return data;
}
try{
  const described=await rpc("mare_describe");
  const cap=described.data.capability;
  equal(cap.id,id);equal(cap.available,true);equal(cap.operation,"prepare");equal(cap.risk,"artifact_only");
  equal(cap.approval,"none");equal(cap.request_schema.additionalProperties,false);
  deep(cap.request_schema.required,["marketplace","sku","ean","asin"]);
  deep(Object.keys(cap.request_schema.properties),["marketplace","sku","ean","asin"]);noReads(described);
  const denied=await rpc("mare_prepare",selector,"",false);equal(denied.status,401);noReads(denied);
  const wrongRoute=await rpc("mare_read",selector);equal(wrongRoute.tool.isError,true);noReads(wrongRoute);
  for(const mode of ["disabled","unconfigured","unbound"]){
    const unavailable=await rpc("mare_prepare",selector,mode);
    equal(unavailable.tool.isError,true,mode);noReads(unavailable);
  }
  for(const invalid of [{}, {...selector,marketplace:"US"}, {...selector,sku:"../other"},
    {...selector,sku:selector.sku+" "}, {...selector,ean:"2000000001235"}, {...selector,asin:"other"},
    {...selector,quantity:1},{...selector,mode:"LIVE"},{...selector,url:"https://private.invalid"},
    {...selector,payload:{}},{...selector,preflight:{ok:true}},{...selector,approval_confirmation:"yes"}]){
    const rejected=await rpc("mare_prepare",invalid);equal(rejected.tool.isError,true);noReads(rejected);
  }
  let completedPlan;
  for(const marketplace of ["IT","DE","FR","ES"]){
    const result=await rpc("mare_prepare",{...selector,marketplace});
    const data=report(result);completedPlan=result.data.plan.plan_id;
    equal(data.status,"PREVIEW_REVIEW_REQUIRED");equal(data.amazon_preview_status,"VALID");
    equal(data.marketplace,marketplace);equal(data.provider_validation_performed,true);
    equal(data.validation_mode,"VALIDATION_PREVIEW");equal(data.offer_quantity_submitted,0);
    equal(data.issue_count,0);deep(data.preview_issues,[]);equal(data.issues_returned,true);
    equal(result.metrics.shopify_reads,2);equal(result.metrics.amazon_reads,6);
    equal(result.metrics.preview_requests,1,"Exactly one fixed nonpersisting preview PUT");
    truth(result.metrics.token_requests>0,"Real auth reader used against isolated provider");
  }
  const replay=await rpc("mare_execute",{},"",true,
    {plan_id:completedPlan,approval_confirmation:"EXECUTE MARE PLAN"});
  equal(replay.tool.isError,false);equal(replay.data.idempotent_replay,true);noReads(replay);
  for(const mode of ["invalid","warning"]){
    const result=await rpc("mare_prepare",selector,mode),data=report(result);
    equal(data.status,"PREVIEW_REVIEW_REQUIRED");equal(data.provider_validation_performed,true);
    equal(data.amazon_preview_status,mode==="invalid"?"INVALID":"VALID");equal(data.issue_count,1);
    deep(data.preview_issues,[{code:mode==="invalid"?"90220":"100708",
      severity:mode==="invalid"?"ERROR":"WARNING",attribute_names:["merchant_shipping_group"]}]);
    equal(result.metrics.preview_requests,1);
  }
  const blockers={
    existing_sku:"seller_sku_already_exists",existing_asin:"seller_has_asin_under_other_sku",
    restricted:"amazon_restrictions_present",zero_stock:"status_stock_price_inventory_or_ean_invalid",
    excluded_brand:"status_stock_price_inventory_or_ean_invalid"
  };
  for(const [mode,blocker] of Object.entries(blockers)){
    const result=await rpc("mare_prepare",selector,mode),data=report(result);
    equal(data.status,"BLOCKED_PREVIEW");equal(data.provider_validation_performed,false);
    equal(data.preflight_blocker,blocker);equal(result.metrics.preview_requests,0);
    equal(result.metrics.shopify_reads,2);
  }
  for(const mode of ["preview_http403","preview_redirect","accepted"]){
    const rejected=await rpc("mare_prepare",selector,mode);equal(rejected.tool.isError,true,mode);
    equal(rejected.metrics.preview_requests,1);equal(rejected.metrics.storage_writes,1);
    noMutationsOrLeaks(rejected);
    if(mode==="preview_http403")truth(JSON.stringify(rejected.tool).includes("amazon_offer_preview_http_403"));
  }
  equal(escapes,0,"No live provider network was reachable");
}finally{await mf.dispose();}
console.log("PASS Amazon offer preview Worker/MCP runtime: "+checks+
  " checks; auth, strict pre-store input, four markets, real preflight, fixed preview and private-plan privacy");
