import assert from "node:assert/strict";
import { build } from "esbuild";
const b=await build({entryPoints:["src/marketplace-amazon-kway-batch-create.ts"],
 bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {createKwayNewAsinBatch:run}=await import(
 "data:text/javascript;base64,"+Buffer.from(b.outputFiles[0].text).toString("base64"));
const items=[{sku:"KWAY_K6133HW_USY_S",product_type:"SWEATSHIRT"},
 {sku:"KWAY_K6133HW_USY_M",product_type:"SWEATSHIRT"},
 {sku:"KWAY_K6133HW_USY_L",product_type:"SWEATSHIRT"}];
const input={marketplace:"IT",items};
const calls=[];
const deps={pilot:async request=>{
 calls.push(request.sku);
 if(request.sku===items[0].sku)return {status:"BLOCKED_KWAY_PILOT",reason:"amazon_validation_preview_not_accepted",
  provider_write_attempted:false,asin_created_verified:false};
 return {status:"NEW_ASIN_SELLER_LISTING_VERIFIED",provider_write_attempted:true,
  asin_created_verified:true,asin:"B0TEST1234",submission_reference:"sub-verified-123"};
}};
const result=await run(input,{},deps);
assert.equal(result.status,"KWAY_BATCH_COMPLETE");
assert.equal(result.blocked_before_write,1);
assert.equal(result.live_attempts,2);
assert.equal(result.asin_verified,2);
assert.equal(result.remaining_not_attempted,0);
assert.equal(result.price_changed,false);
assert.equal(result.quantity_submitted_if_accepted,0);
assert.deepEqual(calls,items.map(x=>x.sku));
assert.equal(result.rows[1].asin,"B0TEST1234");
assert.equal(result.rows[1].submission_reference,"sub-verified-123");
assert.equal(Object.hasOwn(result.rows[0],"submission_reference"),false);
assert(!JSON.stringify(result).includes("token"));
const stopCalls=[];
const stopped=await run(input,{}, {pilot:async request=>{
 stopCalls.push(request.sku);
 return {status:"NEW_ASIN_SUBMITTED_AWAITING_READBACK",provider_write_attempted:true,
 asin_created_verified:false,submission_reference:"sub-awaiting-123",untrusted_extra:"SECRET"};
}});
assert.equal(stopped.status,"KWAY_BATCH_STOPPED_REQUIRES_READBACK");
assert.equal(stopped.live_attempts,1);
assert.equal(stopped.remaining_not_attempted,2);
assert.deepEqual(stopCalls,[items[0].sku]);
assert(!JSON.stringify(stopped).includes("SECRET"));
assert.equal(stopped.rows[0].submission_reference,"sub-awaiting-123");
const thrown=await run(input,{}, {pilot:async()=>{throw Error("UNKNOWN_SUBMISSION");}});
assert.equal(thrown.stopped_on_uncertain_write,true);
assert.equal(thrown.live_attempts,0);
assert.equal(thrown.rows[0].provider_write_attempted,"UNKNOWN");
for(const invalid of [{marketplace:"IT",items:[]},
 {marketplace:"IT",items:[items[0],items[0]]},
 {marketplace:"IT",items:[{...items[0],product_type:"FOOD"}]},
 {marketplace:"UK",items:[items[0]]},
 {marketplace:"IT",items:[items[0]],extra:true}])
 await assert.rejects(()=>run(invalid,{},deps),/kway_create_batch/);
const expandedItem={...items[0],source_marketplace:"DE",source_asin:"B0HPTCSTNL"};
const expansionBatch=await run({marketplace:"IT",items:[expandedItem,items[1]]},{},
 {pilot:async request=>{
  if(request.source_marketplace){
   assert.deepEqual(request,{marketplace:"IT",...expandedItem});
   return {status:"MARKETPLACE_EXPANSION_VERIFIED",provider_write_attempted:true,
    marketplace_expansion_verified:true,asin_created_verified:false,asin:request.source_asin,
    submission_reference:"expansion-verified-123"};
  }
  return deps.pilot(request);
 }});
assert.equal(expansionBatch.status,"KWAY_BATCH_COMPLETE");
assert.equal(expansionBatch.marketplace_expansion_verified,1);
assert.equal(expansionBatch.asin_verified,1);
assert.equal(expansionBatch.listings_verified,2);
assert.equal(expansionBatch.rows[0].asin_created_verified,false);
assert.equal(expansionBatch.rows[0].asin,expandedItem.source_asin);
assert.equal(expansionBatch.rows[0].submission_reference,"expansion-verified-123");
for(const reply of [
 {status:"MARKETPLACE_EXPANSION_SUBMITTED_AWAITING_READBACK",marketplace_expansion_verified:false},
 {status:"MARKETPLACE_EXPANSION_VERIFIED",marketplace_expansion_verified:true,asin:"B0WRONG123"},
 {status:"NEW_ASIN_SELLER_LISTING_VERIFIED",asin_created_verified:true,asin:expandedItem.source_asin}
]) {
 const stopped=await run({marketplace:"IT",items:[expandedItem,items[1]]},{},
  {pilot:async()=>({provider_write_attempted:true,asin_created_verified:false,
   submission_reference:"expansion-pending-123",...reply})});
 assert.equal(stopped.stopped_on_uncertain_write,true);
 assert.equal(stopped.remaining_not_attempted,1);
 assert.equal(stopped.asin_verified,0);
 assert.equal(stopped.marketplace_expansion_verified,0);
 assert.equal(stopped.rows[0].submission_reference,"expansion-pending-123");
}
for(const submission_reference of [undefined,"","<unsafe>","x".repeat(161)]) {
 const sanitized=await run(input,{}, {pilot:async()=>({
  status:"NEW_ASIN_SUBMITTED_AWAITING_READBACK",provider_write_attempted:true,
  asin_created_verified:false,submission_reference})});
 assert.equal(Object.hasOwn(sanitized.rows[0],"submission_reference"),false);
}
for(const item of [{...items[0],source_marketplace:"DE"},
 {...items[0],source_asin:expandedItem.source_asin},{...expandedItem,source_marketplace:"IT"}])
 await assert.rejects(()=>run({marketplace:"IT",items:[item]},{},deps),/kway_create_batch/);
const diagnostics=await run({marketplace:"IT",items:[items[0]]},{}, {pilot:async()=>({
 status:"BLOCKED_KWAY_PILOT",provider_write_attempted:false,
 amazon_preview_status:"INVALID",exact_preview_status:"INVALID",
 amazon_preview_issues:[{code:"90220",attribute_names:["manufacturer"],message:"PRIVATE_CONTACT"},
  ...Array.from({length:30},()=>({code:"unsafe@contact.invalid",attribute_names:[
   "invalid@contact.invalid",...Array.from({length:12},()=>"brand")]}))],
 amazon_issues:[{code:"8560",attribute_names:["merchant_suggested_asin"],raw:"PRIVATE_PAYLOAD"}]
})});
assert.equal(diagnostics.rows[0].amazon_preview_status,"INVALID");
assert.equal(diagnostics.rows[0].exact_preview_status,"INVALID");
assert.equal(diagnostics.rows[0].amazon_preview_issues.length,25);
assert.deepEqual(diagnostics.rows[0].amazon_preview_issues[0],{
 code:"90220",attribute_names:["manufacturer"]});
assert.equal(diagnostics.rows[0].amazon_preview_issues[1].code,"UNKNOWN");
assert.equal(diagnostics.rows[0].amazon_preview_issues[1].attribute_names.length,10);
assert.deepEqual(diagnostics.rows[0].amazon_issues,[{code:"8560",attribute_names:["merchant_suggested_asin"]}]);
assert(!JSON.stringify(diagnostics).includes("PRIVATE"));
assert(!JSON.stringify(diagnostics).includes("contact.invalid"));
assert.equal(Object.hasOwn(result.rows[1],"amazon_preview_issues"),false);
console.log("K-Way batch creation/expansion counting and no-retry: PASS");
