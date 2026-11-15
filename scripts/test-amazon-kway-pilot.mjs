import assert from "node:assert/strict";
import {build} from "esbuild";
const bundle=await build({entryPoints:["src/marketplace-amazon-kway-pilot.ts"],
 bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {createKwayNewAsinPilot:run}=await import("data:text/javascript;base64,"+
 Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const sku="KWAY_K6127ZW_K89_M",ean="8056761061912";
const seller="A1234567891234",market="APJ6JRA9NG5V4";
const env={AMAZON_SP_API_SELLER_ID:seller,AMAZON_OFFER_PREVIEW_ENABLED:"true"};
const input={marketplace:"IT",sku,product_type:"COAT"};
const previewAttributes={brand:[{value:"K-Way",marketplace_id:market}],
 item_name:[{value:"Giacca Benoit ST Warm Blue Depth",marketplace_id:market,language_tag:"it_IT"}],
 externally_assigned_product_identifier:[{value:ean,type:"ean",marketplace_id:market}]};
const pBody={productType:"COAT",requirements:"LISTING",attributes:previewAttributes};
const src={ok:true,status:"REQUIREMENTS_REVIEW_REQUIRED",marketplace:"IT",sku,
 product_type:"COAT",seller_listing_state:"VERIFIED_ABSENT",
 ean_match_state:"NO_EXACT_MATCH",read_only:true,provider_mutations:0,
 shopify:{amazon_listing_brand:"K-Way",ean,product_title:"Giacca Benoit ST Warm Blue Depth",shopify_available:3}};
function makeDeps(overrides={}){
 const calls={preview:0,exactPreview:0,live:0,markets:[],bodies:[]};
 const deps={
  preview:async(_req,_env,{fetch})=>{
    calls.preview++;
    await fetch("https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/"+seller+"/"+sku+
      "?marketplaceIds="+market+"&mode=VALIDATION_PREVIEW",{
      method:"PUT",body:JSON.stringify(pBody)});
    return {ok:true,status:"VALIDATION_ONLY_REVIEW_REQUIRED",
      marketplace:"IT",sku,product_type:"COAT",provider_validation_status:"VALID",
      provider_validation_performed:true,preview_only:true,provider_mutations:0,product_created:false,
      issues:[]};
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
assert.equal(zeroResult.submitted_quantity,0);
assert.equal(zeroStock.calls.live,1);
const negativeStock=makeDeps({research:async()=>({...src,
 shopify:{...src.shopify,shopify_available:-1}})});
const negativeResult=await run(input,env,negativeStock.deps);
assert.equal(negativeResult.status,"BLOCKED_KWAY_PILOT");
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
assert.equal(rejected.status,"BLOCKED_KWAY_PILOT");
assert.equal(rejected.reason,"exact_zero_stock_preview_not_valid");
assert.equal(rejected.amazon_issues[0].attribute_names[0],"fulfillment_availability");
const missingSeller=makeDeps({seller:async({marketplace})=>({ok:true,
 results:[{sku,state:marketplace==="DE"?"PRESENT":"VERIFIED_ABSENT"}]})});
const conflict=await run(input,env,missingSeller.deps);
assert.equal(conflict.status,"BLOCKED_KWAY_PILOT");
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
const invalid=makeDeps({preview:async()=>({ok:true,status:"VALIDATION_ONLY_REVIEW_REQUIRED",marketplace:"IT",sku,product_type:"COAT",provider_validation_status:"INVALID",issues:[{code:"90220",severity:"ERROR",attribute_names:["manufacturer"]}],provider_validation_performed:true,preview_only:true,provider_mutations:0,product_created:false})});
const invalidRes=await run(input,env,invalid.deps);
assert.equal(invalidRes.status,"BLOCKED_KWAY_PILOT");
assert.deepEqual(invalidRes.amazon_preview_issues,[{
  code:"90220",attribute_names:["manufacturer"]
}]);
assert.equal(invalidRes.amazon_preview_status,"INVALID");
assert.equal(invalid.calls.live,0);
// Source-recommended Amazon product types must use the same strict controls
// as COAT: distinct exact preview, verified EU absence and zero-stock live PUT.
for (const category of ["TOTE_BAG","DUFFEL_BAG","WAIST_PACK"]) {
  const categoryRun=makeDeps({
    preview:async(_request,_env,{fetch})=>{
      await fetch("https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/"+
        seller+"/"+sku+"?marketplaceIds="+market+"&mode=VALIDATION_PREVIEW",{
        method:"PUT",body:JSON.stringify({...pBody,productType:category})});
      return {ok:true,status:"VALIDATION_ONLY_REVIEW_REQUIRED",
        marketplace:"IT",sku,product_type:category,provider_validation_status:"VALID",
        provider_validation_performed:true,preview_only:true,provider_mutations:0,
        product_created:false,issues:[]};
    },
    research:async()=>({...src,product_type:category})
  });
  const accepted=await run({...input,product_type:category},env,categoryRun.deps);
  assert.equal(accepted.status,"NEW_ASIN_SUBMITTED_AWAITING_READBACK");
  assert.equal(categoryRun.calls.exactPreview,1);
  assert.equal(categoryRun.calls.live,1);
  assert.equal(accepted.submitted_quantity,0);
  assert.equal(categoryRun.calls.bodies[0].productType,category);
  assert.equal(categoryRun.calls.bodies[0].attributes.purchasable_offer,undefined);
}
// Explicit expansion is a separate, ASIN-bound path. A source can have zero
// stock / no BUYABLE status: those are not product-identity failures.
const sourceAsin="B0HPTCSTNL";
const expansionInput={...input,source_marketplace:"DE",source_asin:sourceAsin};
const sourceListing={sku,state:"PRESENT",identity_state:"VERIFIED",asin:sourceAsin,
 product_type:"COAT",statuses:["DISCOVERABLE"],current_fbm_quantity:0,
 listing_issues_count:0,issue_signals:[],issue_signals_truncated:false};
const sourceCatalog={read_only:true,complete:true,marketplace:"DE",marketplace_id:"A1PA6795UKMFR9",
 identifiers_count:1,identifiers:[{ean,state:"EXACT_ONE",exact_match_count:1,asins:[sourceAsin]}]};
const sourceDetails={ok:true,read_only:true,marketplace:"DE",results:[{
 asin:sourceAsin,state:"READ_ONLY_DETAILS_COMPLETE",brand:"K-Way",product_types:["COAT"]}]};
const targetAbsence={ok:true,read_only:true,marketplace:"IT",complete_evidence:true,results:[{
 asin:sourceAsin,state:"NO_SELLER_ASIN_IN_BOUNDED_SEARCH",query_complete:true,skus:[]}]};
function makeExpansion(options={}) {
 const base=makeDeps();
 const originalFetch=base.deps.fetch;
 let reads=0;
 base.deps={...base.deps,
  research:async()=>({...src,available_schema_attribute_names:["merchant_suggested_asin"]}),
  seller:async({marketplace})=>{
   reads++;
   return {ok:true,marketplace,results:[reads===5?{...sourceListing,...options.readback}:
    marketplace==="DE"?{...sourceListing,...options.source}:
    marketplace==="IT"&&options.target?options.target:
    {sku,state:"VERIFIED_ABSENT"}]};
  },
  catalog:async(_env,source,identifiers)=>{
   assert.equal(source,"DE");assert.deepEqual(identifiers,[ean]);
   return options.catalog??sourceCatalog;
  },
  details:async(request)=>{
   assert.deepEqual(request,{marketplace:"DE",asins:[sourceAsin]});
   return options.details??sourceDetails;
  },
  sellerAsin:async(request)=>{
   assert.deepEqual(request,{marketplace:"IT",asins:[sourceAsin]});
   return options.targetAbsence??targetAbsence;
  },
  fetch:async(url,init)=>{
   const u=new URL(url);
   if(u.pathname.endsWith("/restrictions")) {
    assert.equal(init.method,"GET");
    assert.equal(u.searchParams.get("asin"),sourceAsin);
    assert.equal(u.searchParams.get("marketplaceIds"),market);
    assert.equal(u.searchParams.get("sellerId"),seller);
    return new Response(JSON.stringify(options.restrictions??{restrictions:[]}),{
     status:options.restrictionStatus??200,headers:{"content-type":"application/json"}});
   }
   return originalFetch(url,init);
  }
 };
 return base;
}
const expanded=makeExpansion();
const expansionResult=await run(expansionInput,env,expanded.deps);
assert.equal(expansionResult.status,"MARKETPLACE_EXPANSION_VERIFIED");
assert.equal(expansionResult.marketplace_expansion_verified,true);
assert.equal(expansionResult.asin_created_verified,false);
assert.equal(expansionResult.buyable_verified,false);
assert.equal(expanded.calls.live,1);
assert.equal(expanded.calls.exactPreview,1);
assert.deepEqual(expanded.calls.bodies[0],expanded.calls.bodies[1]);
assert.deepEqual(expanded.calls.bodies[1].attributes.merchant_suggested_asin,
 [{value:sourceAsin,marketplace_id:market}]);
assert.equal(expanded.calls.bodies[1].attributes.fulfillment_availability[0].quantity,0);
assert.equal(expanded.calls.bodies[1].attributes.purchasable_offer,undefined);
assert.equal(first.calls.bodies[0].attributes.merchant_suggested_asin,undefined);
for (const [options,reason] of [
 [{source:{asin:"B0WRONG123"}},"expansion_source_or_eu_identity_mismatch"],
 [{source:{identity_state:"UNKNOWN"}},"expansion_source_or_eu_identity_mismatch"],
 [{source:{state:"VERIFIED_ABSENT"}},"expansion_source_or_eu_identity_mismatch"],
 [{source:{issue_signals_truncated:true}},"expansion_source_qualification_unknown"],
 [{source:{listing_issues_count:1,issue_signals:[{code:"100632",severity:"ERROR"}]}},
   "expansion_source_qualification_blocked"],
 [{target:sourceListing},"seller_sku_present_or_unknown_in_eu"],
 [{catalog:{...sourceCatalog,complete:false}},"expansion_source_ean_asin_not_unique"],
 [{catalog:{...sourceCatalog,identifiers:[{ean,state:"EXACT_MULTIPLE",exact_match_count:2,
   asins:[sourceAsin,"B0WRONG123"]}]}},"expansion_source_ean_asin_not_unique"],
 [{catalog:{...sourceCatalog,identifiers:[{ean,state:"EXACT_ONE",exact_match_count:1,
   asins:["B0WRONG123"]}]}},"expansion_source_ean_asin_not_unique"],
 [{details:{...sourceDetails,results:[{...sourceDetails.results[0],brand:"Other"}]}},
   "expansion_source_brand_or_type_mismatch"],
 [{details:{...sourceDetails,results:[{...sourceDetails.results[0],product_types:["HAT"]}]}},
   "expansion_source_brand_or_type_mismatch"],
 [{targetAbsence:{...targetAbsence,results:[{...targetAbsence.results[0],
   state:"SELLER_ASIN_LISTING_FOUND",skus:["ANOTHER_SKU"]}]}},"expansion_target_asin_present_or_unknown"],
 [{restrictionStatus:403},"expansion_target_restrictions_unverified"],
 [{restrictions:{}},"expansion_target_restricted_or_unknown"],
 [{restrictions:{restrictions:[{reasonCode:"APPROVAL_REQUIRED"}]}},"expansion_target_restricted_or_unknown"],
]) {
 const rejected=makeExpansion(options);
 const outcome=await run(expansionInput,env,rejected.deps);
 assert.equal(outcome.reason,reason,JSON.stringify(options));
 assert.equal(rejected.calls.live,0);
}
const schemaMissing=makeExpansion();
schemaMissing.deps.research=async()=>src;
assert.equal((await run(expansionInput,env,schemaMissing.deps)).reason,
 "expansion_asin_binding_not_in_target_schema");
assert.equal(schemaMissing.calls.live,0);
const wrongReadback=makeExpansion({readback:{asin:"B0WRONG123"}});
const uncertain=await run(expansionInput,env,wrongReadback.deps);
assert.equal(uncertain.status,"MARKETPLACE_EXPANSION_SUBMITTED_AWAITING_READBACK");
assert.equal(uncertain.marketplace_expansion_verified,false);
assert.equal(uncertain.asin_created_verified,false);
assert.equal(wrongReadback.calls.live,1);
for(const bad of [{...input,source_asin:sourceAsin},
 {...input,source_marketplace:"DE"},{...expansionInput,source_marketplace:"IT"},
 {...expansionInput,source_marketplace:"UK"},{...expansionInput,source_asin:"unsafe"}])
 await assert.rejects(()=>run(bad,env),/kway_pilot_request_invalid/);
console.log("K-Way creation and guarded EU expansion tests passed");
