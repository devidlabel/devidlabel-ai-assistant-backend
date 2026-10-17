import assert from "node:assert/strict";
import {build} from "esbuild";
const out=await build({entryPoints:["src/mare-business-amazon-sku-status.ts"],
  bundle:true,write:false,platform:"neutral",format:"esm",logLevel:"silent"});
const {readAmazonMerchantSkuStatuses}=await import(
  "data:text/javascript;base64,"+Buffer.from(out.outputFiles[0].text).toString("base64"));
const a=["PRIVATE-NOTO","PRIVATE-MATERA","PRIVATE-CEFALU"];
const creds={AMAZON_SP_API_CLIENT_ID:"test-id",
  AMAZON_SP_API_CLIENT_SECRET:"test-secret",AMAZON_SP_API_REFRESH_TOKEN:"test-refresh"};
let called=0;
async function reader(_env,market,skus){
  called++;assert.equal(market,"IT");assert.deepEqual(skus,a);
  return {marketplace:"IT",snapshot_complete:true,safe_for_missing_sku_classification:true,
    fresh_within_24h:true,encoding_verified:true,duplicate_sku_rows:0,
    status_column_present:true,rows:250,report_created_at:"2026-10-17T21:00:00Z",
    selected_sku_statuses:Object.fromEntries([
      [a[0],"MISSING"],[a[1],"ACTIVE"],[a[2],"MISSING"]])};
}
const valid=await readAmazonMerchantSkuStatuses({marketplace:"IT",skus:a},creds,reader);
assert.equal(valid.ok,true);
assert.equal(valid.no_listing_writes,true);
assert.deepEqual(valid.statuses.map(x=>x.status),["MISSING","ACTIVE","MISSING"]);
assert.equal(valid.statuses[1].must_not_create_duplicate,true);
assert.equal(valid.statuses[0].eligibility_for_new_offer,"NEEDS_PRODUCT_REVIEW");
assert.equal(called,1);
for (const bad of [
  {marketplace:"US",skus:a},
  {marketplace:"IT",skus:[]},
  {marketplace:"IT",skus:[a[0],a[0]]},
  {marketplace:"IT",skus:["bad\nsku"]},
  {marketplace:"IT",skus:Array(9).fill("SKU")}
]) await assert.rejects(()=>readAmazonMerchantSkuStatuses(bad,creds,reader));
assert.equal(called,1);
for (const alteration of [
 {safe_for_missing_sku_classification:false},
 {snapshot_complete:false},
 {duplicate_sku_rows:1},
 {status_column_present:false},
 {encoding_verified:false},
 {fresh_within_24h:false},
 {selected_sku_statuses:{[a[0]]:"MISSING"}}
]){
 await assert.rejects(()=>readAmazonMerchantSkuStatuses({marketplace:"IT",skus:a},
   creds,async (...args)=>({...await reader(...args),...alteration})));
}
console.log("Merchant-private Amazon seller SKU missing/active strict report safeguards passed");
