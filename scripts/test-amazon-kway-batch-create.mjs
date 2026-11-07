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
  asin_created_verified:true,asin:"B0TEST1234"};
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
assert(!JSON.stringify(result).includes("token"));
const stopCalls=[];
const stopped=await run(input,{}, {pilot:async request=>{
 stopCalls.push(request.sku);
 return {status:"NEW_ASIN_SUBMITTED_AWAITING_READBACK",provider_write_attempted:true,
 asin_created_verified:false,submission_reference:"SECRET"};
}});
assert.equal(stopped.status,"KWAY_BATCH_STOPPED_REQUIRES_READBACK");
assert.equal(stopped.live_attempts,1);
assert.equal(stopped.remaining_not_attempted,2);
assert.deepEqual(stopCalls,[items[0].sku]);
assert(!JSON.stringify(stopped).includes("SECRET"));
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
console.log("K-Way 8-SKU live batch safety and no-retry: PASS");
