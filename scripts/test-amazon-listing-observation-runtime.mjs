import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,Log,LogLevel} from "miniflare";

let checks=0,escapes=0;
const equal=(actual,expected,label)=>{assert.equal(actual,expected,label);checks++;};
const truth=(value,label)=>{assert(value,label);checks++;};
const deep=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const built=await build({entryPoints:["scripts/fixtures/amazon-listing-observation-worker.ts"],bundle:true,
  write:false,format:"esm",platform:"browser",external:["cloudflare:workers"],logLevel:"silent"});
const token="SYNTHETIC_MARE_CANARY",id="amazon.seller.listings.direct";
const selector={marketplace:"IT",skus:["SYNTHETIC_STOCK_001"]};
const mf=new Miniflare({name:"amazon-listing-observation-runtime",modules:true,script:built.outputFiles[0].text,
  compatibilityDate:"2026-06-25",bindings:{
    MARE_BUSINESS_ACCESS_TOKEN:token,AMAZON_SP_API_CLIENT_ID:"SYNTHETIC_CLIENT",
    AMAZON_SP_API_CLIENT_SECRET:"SYNTHETIC_SECRET_CANARY",AMAZON_SP_API_REFRESH_TOKEN:"SYNTHETIC_REFRESH_CANARY",
    AMAZON_SP_API_SELLER_ID:"SYNTHETICSELLER01"
  },outboundService:async()=>{escapes++;return new Response("NETWORK_FORBIDDEN",{status:503});},
  log:new Log(LogLevel.ERROR)});
async function rpc(name,request={},mode="",auth=true){
  const response=await mf.dispatchFetch("https://fixture/mcp-business",{method:"POST",headers:{
    "Content-Type":"application/json","MCP-Protocol-Version":"2025-06-18","x-fixture-mode":mode,
    ...(auth?{Authorization:"Bearer "+token}:{})
  },body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",
    params:{name,arguments:{capability_id:id,request}}})});
  const body=await response.json();
  return {...body,tool:body.result?.result,data:body.result?.result?.structuredContent};
}
function safe(r){
  equal(r.metrics.provider_mutations,0);equal(r.metrics.storage_writes,0);equal(r.metrics.storage_deletes,0);
  equal(r.metrics.unmocked_requests,0);
  truth(!JSON.stringify(r).includes("CANARY"),"No credentials, raw messages, URLs or unexpected provider fields escape");
}
function noReads(r){equal(r.metrics.amazon_reads,0);equal(r.metrics.token_requests,0);safe(r);}
function report(r){
  equal(r.tool.isError,false,JSON.stringify(r.tool));equal(r.data.ok,true);
  equal(r.data.source,"amazon_sp_api_get_listings_item");equal(r.data.read_only,true);
  equal(r.data.has_created_or_updated_offer,false);equal(r.data.can_publish,false);
  equal(r.data.must_verify_channable_writer_ownership,true);
  truth(Number.isFinite(Date.parse(r.data.observed_at)),"Top-level observation time is explicit");
  equal(r.data.observation_complete,r.data.results.every(row=>row.observation_complete));
  safe(r);return r.data.results[0];
}
function unknownQuantity(row){equal(row.fulfillment_state,"UNKNOWN");equal(row.current_fbm_quantity,null);equal(row.observation_complete,false);}
function unknownPrice(row){equal(row.price_state,"UNKNOWN");equal(row.current_b2c_price,null);equal(row.observation_complete,false);}
try{
  const described=await rpc("mare_describe"),cap=described.data.capability;
  equal(cap.id,id);equal(cap.available,true);equal(cap.operation,"read");equal(cap.risk,"read_only");
  equal(cap.approval,"none");equal(cap.request_schema.additionalProperties,false);
  equal(cap.request_schema.properties.skus.maxItems,8);equal(cap.request_schema.properties.skus.uniqueItems,true);noReads(described);
  const denied=await rpc("mare_read",selector,"",false);equal(denied.status,401);noReads(denied);
  const prepare=await rpc("mare_prepare",selector);equal(prepare.tool.isError,true);noReads(prepare);
  for(const mode of ["unconfigured","missing_seller"]){
    const rejected=await rpc("mare_read",selector,mode);equal(rejected.tool.isError,true);noReads(rejected);
  }
  for(const invalid of [{}, {...selector,marketplace:"US"},{...selector,skus:[]},
    {...selector,skus:["SYNTHETIC_STOCK_001","SYNTHETIC_STOCK_001"]},
    {...selector,skus:["../other"]},{...selector,skus:["SYNTHETIC_STOCK_001 "]},
    {...selector,skus:Array.from({length:9},(_,i)=>"SYNTHETIC_"+i)},
    {...selector,quantity:1},{...selector,observations:[]},{...selector,url:"https://private.invalid"}]){
    const rejected=await rpc("mare_read",invalid);equal(rejected.tool.isError,true);noReads(rejected);
  }
  const quantities={IT:3,DE:2,FR:0,ES:1},prices={IT:"39.90",DE:"41.90",FR:"42.90",ES:"43.90"};
  for(const marketplace of ["IT","DE","FR","ES"]){
    const result=await rpc("mare_read",{...selector,marketplace}),row=report(result);
    equal(row.state,"PRESENT");equal(row.asin,"B0TEST0001");equal(row.identity_state,"VERIFIED");
    equal(row.fulfillment_state,"VERIFIED");equal(row.current_fbm_quantity,quantities[marketplace]);
    equal(row.price_state,"VERIFIED");deep(row.current_b2c_price,{amount:prices[marketplace],currency_code:"EUR"});
    equal(row.observation_complete,true);equal(result.data.observation_complete,true);
    equal(result.metrics.amazon_reads,1);equal(result.metrics.token_requests,1);
    truth(Number.isFinite(Date.parse(row.observed_at)));
    truth(row.current_fbm_quantity!==999,"Use current fulfillment data, never last-submitted attributes");
  }
  const multiple=await rpc("mare_read",{...selector,skus:["SYNTHETIC_STOCK_001","SYNTHETIC_STOCK_002"]});
  report(multiple);equal(multiple.data.results.length,2);equal(multiple.metrics.amazon_reads,2);equal(multiple.metrics.token_requests,1);
  for(const mode of ["missing_fulfillment","empty_fulfillment","fba_only","missing_quantity",
    "duplicate_quantity","string_quantity","negative_quantity","fractional_quantity"]){
    const row=report(await rpc("mare_read",selector,mode));unknownQuantity(row);
    equal(row.identity_state,"VERIFIED");equal(row.price_state,"VERIFIED");
  }
  for(const mode of ["missing_offers","empty_offers","b2b_only","segmented_only","missing_audience",
    "duplicate_b2c","wrong_currency","numeric_amount","negative_amount","foreign_offers"]){
    const row=report(await rpc("mare_read",selector,mode));unknownPrice(row);
    equal(row.identity_state,"VERIFIED");equal(row.fulfillment_state,"VERIFIED");
  }
  const mixed=report(await rpc("mare_read",selector,"mixed_offers"));
  equal(mixed.price_state,"VERIFIED");equal(mixed.current_b2c_price.amount,"39.90");
  equal(mixed.current_offers.length,3,"Retain distinct local B2C/B2B/audience prices, exclude other markets");
  const precise=report(await rpc("mare_read",selector,"decimal_precision"));
  equal(precise.current_b2c_price.amount,"39.9000","Decimal representation is preserved exactly");
  for(const mode of ["wrong_sku","invalid_asin","wrong_market","duplicate_summary"]){
    const result=await rpc("mare_read",selector,mode),row=report(result);
    equal(row.identity_state,"UNKNOWN");unknownQuantity(row);unknownPrice(row);deep(row.current_offers,[]);
    if(mode==="wrong_market"){
      equal(row.state,"PRESENT_ATTRIBUTES_UNKNOWN");equal(result.data.complete_evidence,true);
      equal(result.data.observation_complete,false,"Legacy presence completeness is not quantity/price proof");
    }
  }
  for(const mode of ["http403","redirect","not_found","ambiguous404","invalid_json","large_body"]){
    const result=await rpc("mare_read",selector,mode),row=report(result);
    equal(row.state,mode==="not_found"?"VERIFIED_ABSENT":"UNKNOWN");
    unknownQuantity(row);unknownPrice(row);equal(result.metrics.amazon_reads,1);
  }
  const tokenFailure=await rpc("mare_read",selector,"token_failure");
  equal(tokenFailure.tool.isError,true);equal(tokenFailure.metrics.amazon_reads,0);safe(tokenFailure);
  equal(escapes,0,"No live provider network was reachable");
}finally{await mf.dispose();}
console.log("PASS Amazon current listing observation Worker/MCP runtime: "+checks+
  " checks; current quantity/price, unknown vs zero, four markets, exact identity, auth, no mutations or storage");
