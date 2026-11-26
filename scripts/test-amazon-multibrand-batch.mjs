import assert from "node:assert/strict";
import { build } from "esbuild";
const buildResult=await build({entryPoints:["src/marketplace-amazon-multibrand-batch.ts"],
  bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {validateAmazonNewAsinMultibrandBatch:validate,
  createAmazonNewAsinMultibrandBatch:run}=await import(
    "data:text/javascript;base64,"+
    Buffer.from(buildResult.outputFiles[0].text).toString("base64"));
const first={sku:"COL_11000026_8VX_99_48",product_type:"COAT"};
const second={sku:"ECO_MCMGAJKNIZO00188W26_128_S",product_type:"COAT"};
const third={sku:"RFR_F95000_FG9009_G06000_XL",product_type:"SWEATSHIRT"};
const input={marketplace:"IT",items:[first,second,third]};
assert.equal(validate(input).items.length,3);
for(const invalid of [{marketplace:"IT",items:[]},
  {marketplace:"UK",items:[first]},
  {marketplace:"IT",items:[first,first]},
  {marketplace:"IT",items:[{sku:"KWAY_AA",product_type:"COAT"}]},
  {marketplace:"IT",items:[{...first,product_type:"FOOD"}]},
  {marketplace:"IT",items:[{...first,stock:3}]},
  {marketplace:"IT",items:Array(13).fill(first)}])
  assert.throws(()=>validate(invalid),/amazon_multibrand_batch/);
const calls=[];
const ok=await run(input,{}, {pilot:async x=>{
  calls.push(x);
  assert.equal(x.allow_known_missing_attributes,false);
  assert.equal(x.marketplace,"IT");
  return {status:"NEW_ASIN_SELLER_LISTING_VERIFIED",provider_write_attempted:true,
    asin_created_verified:true,asin:"B0HPTCSTNL",submission_reference:"sub-verified"};
}});
assert.equal(ok.status,"MULTIBRAND_BATCH_COMPLETE");
assert.equal(ok.live_attempts,3);
assert.equal(ok.asin_verified,3);
assert.equal(ok.buyable_verified,0);
assert.equal(ok.quantity_submitted_if_accepted,0);
assert.equal(calls.length,3);
let n=0;
const pending=await run(input,{}, {pilot:async()=>{
  n++;
  return {status:"NEW_ASIN_SUBMITTED_AWAITING_READBACK",
    provider_write_attempted:true,asin_created_verified:false,
    submission_reference:"sub-pending-123"};
}});
assert.equal(pending.status,"MULTIBRAND_BATCH_STOPPED_REQUIRES_READBACK");
assert.equal(pending.live_attempts,1);
assert.equal(pending.submitted_awaiting_readback,1);
assert.equal(pending.remaining_not_attempted,2);
assert.equal(n,1);
n=0;
const blocked=await run(input,{}, {pilot:async()=>{
  n++;return {status:"BLOCKED_REFRIGIWEAR_PILOT",
    reason:"exact_zero_stock_preview_not_valid",provider_write_attempted:false};
}});
assert.equal(blocked.blocked_before_write,3);
assert.equal(blocked.live_attempts,0);
assert.equal(n,3);
n=0;
const uncertain=await run(input,{}, {pilot:async()=>{n++;throw Error("maybe submitted");}});
assert.equal(uncertain.stopped_on_uncertain_write,true);
assert.equal(uncertain.rows[0].provider_write_attempted,"UNKNOWN");
assert.equal(uncertain.remaining_not_attempted,2);
assert.equal(n,1);
const unsafe=await run({marketplace:"IT",items:[first]}, {}, {pilot:async()=>({
 status:"AMAZON_HTTP_REJECTED_OR_UNKNOWN",provider_write_attempted:true,
 amazon_issues:[{code:"5461",attribute_names:["brand"],
    message:"PRIVATE CUSTOMER EMAIL contact@example.com"}],
 submission_reference:"<unsafe>",unsafe:"SECRET"})});
assert.equal(unsafe.stopped_on_uncertain_write,true);
assert(!JSON.stringify(unsafe).includes("SECRET"));
assert(!JSON.stringify(unsafe).includes("contact@example.com"));
console.log("Amazon multibrand guarded batch dry-run regression passed.");
