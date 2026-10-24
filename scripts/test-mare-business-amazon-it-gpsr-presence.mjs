import assert from "node:assert/strict";
import {build} from "esbuild";
const b=await build({entryPoints:["src/mare-business-amazon-it-gpsr-presence.ts"],
 bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
const {auditExistingAmazonItGpsrPresence:audit}=await import(
 "data:text/javascript;base64,"+Buffer.from(b.outputFiles[0].text).toString("base64"));
const sku="ECO_MCWGAJKMORA00048W26_021_XS",asin="B0HMN12H1L";
const env={AMAZON_SP_API_SELLER_ID:"A1234567890"};
let sellerCalls=0,shopifyCalls=0,amazonCalls=0;
const deps={
 sellerRead:async req=>{
  sellerCalls++;
  assert.equal(req.marketplace,"IT");
  return {ok:true,marketplace:"IT",provider_mutations:0,read_only:true,
   results:req.skus.map(s=>({sku:s,state:"PRESENT",identity_state:"VERIFIED",
    fulfillment_state:"VERIFIED",current_fbm_quantity:2,asin,product_type:"APPAREL",
    issue_signals:[{code:"100527"},{code:"100528"},{code:"100632"}]}))};
 },
 readShopify:async(_,query,vars)=>{
  shopifyCalls++;
  assert(query.includes("productVariants"));
  return {productVariants:{nodes:[{
   sku:vars.query.slice(4),inventoryQuantity:2,
   product:{status:"ACTIVE",vendor:"Ecoalf"}
  }]}};
 },
 getAccessToken:async()=>"token",
 fetch:async(url,init)=>{
  amazonCalls++;
  assert.equal(init.method,"GET");
  assert.equal(new URL(url).searchParams.get("includedData"),
   "summaries,attributes,issues");
  const theSku=decodeURIComponent(new URL(url).pathname.split("/").at(-1));
  return new Response(JSON.stringify({
   sku:theSku,summaries:[{marketplaceId:"APJ6JRA9NG5V4",asin}],
   attributes:{
    gpsr_manufacturer_reference:[{gpsr_manufacturer_email_address:"private@example.com"}],
    dsa_responsible_party_address:[],
    compliance_media:[{source_location:"https://private.example/file"}]
   },
  }),{status:200,headers:{"content-type":"application/json"}});
 }
};
const o=await audit({skus:[sku]},env,deps);
assert.equal(o.ok,true);
assert.equal(o.status,"GPSR_PRESENCE_AUDIT_ONLY");
assert.equal(o.provider_mutations,0);
assert.equal(o.gpsr_compliant_proven,false);
assert.equal(o.results.length,1);
assert.equal(o.results[0].state,"EXISTING_STOCK_POSITIVE_NEEDS_GPSR_REVIEW");
assert.equal(o.results[0].shopify_quantity,2);
assert.deepEqual(o.results[0].issue_codes,["100527","100528","100632"]);
assert.equal(o.results[0].gpsr_attribute_observations.gpsr_manufacturer_reference,
 "PRESENT_IN_SELLER_LISTING");
assert.equal(o.results[0].gpsr_attribute_observations.dsa_responsible_party_address,
 "NOT_OBSERVED_IN_SELLER_LISTING");
assert.equal(o.results[0].gpsr_attribute_observations.compliance_media,
 "PRESENT_IN_SELLER_LISTING");
assert.equal(o.results[0].missing_in_response_is_not_absence_from_account_health,true);
assert.equal(sellerCalls,1);
assert.equal(shopifyCalls,1);
assert.equal(amazonCalls,1);
assert(!JSON.stringify(o).includes("private@example.com"));
assert(!JSON.stringify(o).includes("https://private.example"));
for(const request of [
 {skus:[]},{skus:[sku,sku]},{skus:[sku],marketplace:"IT"},
 {skus:["bad<script>"]},{skus:[sku,sku,sku,sku]}
])await assert.rejects(()=>audit(request,env,deps),
 /amazon_it_gpsr_audit_invalid_request/);
const out=await audit({skus:[sku]},env,{...deps,
 readShopify:async()=>({productVariants:{nodes:[{
  sku,inventoryQuantity:0,product:{status:"ACTIVE",vendor:"Ecoalf"}}]}}),
 fetch:async()=>{throw Error("forbidden Amazon GET");}
});
assert.equal(out.results[0].state,"BLOCKED_SHOPIFY_STOCK_UNVERIFIED");
const mismatch=await audit({skus:[sku]},env,{...deps,
 fetch:async()=>new Response(JSON.stringify({
  sku,summaries:[{marketplaceId:"APJ6JRA9NG5V4",asin:"B000000000"}],
  attributes:{dsa_responsible_party_address:[{value:"private@example.com"}]}
 }),{status:200,headers:{"content-type":"application/json"}})
});
assert.equal(mismatch.results[0].state,"BLOCKED_AMAZON_ASIN_CONFLICT");
assert.equal(mismatch.can_publish,false);
console.log("amazon it existing GPSR presence read-only evidence: PASS");