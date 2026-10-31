import assert from "node:assert/strict";
import {build} from "esbuild";
const bundle=await build({entryPoints:["src/marketplace-amazon-refrigiwear-pilot.ts"],
 bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {createRefrigiwearNewAsinPilot:run}=await import("data:text/javascript;base64,"+
 Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const sku="RFR_B31908_MA9083_A00010_UN",ean="8058136861080";
const seller="A1234567891234",market="APJ6JRA9NG5V4";
const env={AMAZON_SP_API_SELLER_ID:seller,AMAZON_OFFER_PREVIEW_ENABLED:"true"};
const input={marketplace:"IT",sku,product_type:"HAT",allow_known_missing_attributes:true};
const previewAttributes={brand:[{value:"Refrigiwear",marketplace_id:market}],
 item_name:[{value:"Berretto Clark White",marketplace_id:market,language_tag:"it_IT"}],
 externally_assigned_product_identifier:[{value:ean,type:"ean",marketplace_id:market}]};
const pBody={productType:"HAT",requirements:"LISTING",attributes:previewAttributes};
const src={ok:true,status:"REQUIREMENTS_REVIEW_REQUIRED",marketplace:"IT",sku,
 product_type:"HAT",seller_listing_state:"VERIFIED_ABSENT",
 ean_match_state:"NO_EXACT_MATCH",read_only:true,provider_mutations:0,
 shopify:{amazon_listing_brand:"Refrigiwear",ean,product_title:"Berretto Clark White",shopify_available:3}};
function makeDeps(overrides={}){
 const calls={preview:0,exactPreview:0,live:0,markets:[],bodies:[]};
 const deps={
  preview:async(_req,_env,{fetch})=>{
    calls.preview++;
    await fetch("https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/"+seller+"/"+sku+
      "?marketplaceIds="+market+"&mode=VALIDATION_PREVIEW",{
      method:"PUT",body:JSON.stringify(pBody)});
    return {ok:true,status:"VALIDATION_ONLY_REVIEW_REQUIRED",
      marketplace:"IT",sku,product_type:"HAT",provider_validation_status:"INVALID",
      provider_validation_performed:true,preview_only:true,provider_mutations:0,product_created:false,
      issues:[{code:"90220",severity:"ERROR",attribute_names:["manufacturer"]}]};
  },
  research:async()=>src,
  seller:async({marketplace})=>{
    calls.markets.push(marketplace);
    return {ok:true,results:[{sku,state:"VERIFIED_ABSENT"}]};
  },
  token:async()=>"TOKEN_FOR_MOCKS",
  fetch:async(_url,init)=>{
    const u=new URL(_url);
    if(u.searchParams.get("mode")==="VALIDATION_PREVIEW"){
      const payload=JSON.parse(init.body);
      const exact=Array.isArray(payload.attributes.fulfillment_availability);
      if(exact){
        calls.exactPreview++;
        calls.bodies.push(payload);
      }
      return new Response(JSON.stringify({sku,status:exact?"VALID":"INVALID",issues:[]}),
        {status:200,headers:{"content-type":"application/json"}});
    }
    calls.live++;
    calls.bodies.push(JSON.parse(init.body));
    assert.equal(init.method,"PUT");
    assert.equal(u.searchParams.get("mode"),null);
    return new Response(JSON.stringify({sku,status:"ACCEPTED",submissionId:"sub-123"}),{
      status:200,headers:{"content-type":"application/json"}});
  },...overrides};
 return {deps,calls};
}
const first=makeDeps();
const ok=await run(input,env,first.deps);
assert.equal(ok.status,"NEW_ASIN_SUBMITTED_AWAITING_READBACK");
assert.equal(ok.submitted_quantity,0);
assert.equal(ok.buyable_verified,false);
assert.equal(first.calls.preview,1);
assert.equal(first.calls.live,1);
assert.equal(first.calls.exactPreview,1);
assert.deepEqual(first.calls.markets,["IT","DE","FR","ES","IT"]);
assert.deepEqual(first.calls.bodies[0].attributes.fulfillment_availability,
 [{fulfillment_channel_code:"DEFAULT",quantity:0,marketplace_id:market}]);
assert.equal(first.calls.bodies[0].attributes.purchasable_offer,undefined);
assert.deepEqual(first.calls.bodies[0].attributes.brand,previewAttributes.brand);
const zeroStock=makeDeps({research:async()=>({...src,
 shopify:{...src.shopify,shopify_available:0}})});
const zeroResult=await run(input,env,zeroStock.deps);
assert.equal(zeroResult.status,"NEW_ASIN_SUBMITTED_AWAITING_READBACK");
assert.equal(zeroStock.calls.live,1);
const negativeStock=makeDeps({research:async()=>({...src,
 shopify:{...src.shopify,shopify_available:-1}})});
const negativeResult=await run(input,env,negativeStock.deps);
assert.equal(negativeResult.status,"BLOCKED_REFRIGIWEAR_PILOT");
assert.equal(negativeStock.calls.live,0);
const invalidExact=makeDeps({fetch:async(url,init)=>{
  const mode=new URL(url).searchParams.get("mode");
  if(mode==="VALIDATION_PREVIEW")
    return new Response(JSON.stringify({sku,status:"INVALID",issues:[
      {code:"90220",severity:"ERROR",attributeNames:["fulfillment_availability"]}]}),
      {status:200,headers:{"content-type":"application/json"}});
  throw new Error("live_request_must_not_happen");
}});
const rejected=await run(input,env,invalidExact.deps);
assert.equal(rejected.status,"BLOCKED_REFRIGIWEAR_PILOT");
assert.equal(rejected.reason,"exact_zero_stock_preview_not_valid");
assert.equal(rejected.amazon_issues[0].attribute_names[0],"fulfillment_availability");
const blocked=makeDeps();
const noAllow=await run({...input,allow_known_missing_attributes:false},env,blocked.deps);
assert.equal(noAllow.status,"BLOCKED_REFRIGIWEAR_PILOT");
assert.equal(blocked.calls.live,0);
const missingSeller=makeDeps({seller:async({marketplace})=>({ok:true,
 results:[{sku,state:marketplace==="DE"?"PRESENT":"VERIFIED_ABSENT"}]})});
const conflict=await run(input,env,missingSeller.deps);
assert.equal(conflict.status,"BLOCKED_REFRIGIWEAR_PILOT");
assert.equal(missingSeller.calls.live,0);
const readback=makeDeps();
const originalSeller=readback.deps.seller;
let n=0;
readback.deps.seller=async(args)=>{
 n++;
 return n===5?{ok:true,results:[{sku,state:"PRESENT",identity_state:"VERIFIED",asin:"B0HPTCSTNL"}]}:
  originalSeller(args);
};
const verified=await run(input,env,readback.deps);
assert.equal(verified.status,"NEW_ASIN_SELLER_LISTING_VERIFIED");
assert.equal(verified.asin_created_verified,true);
assert.equal(verified.asin,"B0HPTCSTNL");
await assert.rejects(run({...input,sku:"!unsafe"},env),/invalid/);
console.log("Refrigiwear pilot tests passed");
