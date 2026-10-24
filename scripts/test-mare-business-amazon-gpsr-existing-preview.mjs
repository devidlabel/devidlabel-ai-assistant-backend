import assert from "node:assert/strict";
import {build} from "esbuild";
const built=await build({entryPoints:["src/mare-business-amazon-gpsr-existing-preview.ts"],bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {previewExistingItManufacturerReference:run}=await import(
 "data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));
const sku="FWM_EXAMPLE_38_EU",asin="B0H2FBXMYL",manufacturer="manufacturer-contact@example.org";
const env={AMAZON_SP_API_SELLER_ID:"A1234567891234"};
const seller={ok:true,read_only:true,provider_mutations:0,marketplace:"IT",results:[{
 sku,asin,product_type:"SHOES",state:"PRESENT",identity_state:"VERIFIED",
 current_fbm_quantity:2,statuses:["DISCOVERABLE"],
 issue_signals:[{code:"100632",severity:"ERROR"}]
}]};
const detail={sku,summaries:[{marketplaceId:"APJ6JRA9NG5V4",asin}],
 attributes:{gpsr_manufacturer_reference:[{
  marketplace_id:"APJ6JRA9NG5V4",gpsr_manufacturer_email_address:manufacturer
 }]},issues:[{code:"100632",severity:"ERROR"}]};
let requests=[];
const dependencies={
 seller:async()=>seller,auth:async()=>"SECRET-TOKEN",
 fetch:async(url,init)=>{
  requests.push({url,method:init.method});
  const u=new URL(url);
  assert.equal(u.hostname,"sellingpartnerapi-eu.amazon.com");
  assert.equal(u.searchParams.get("marketplaceIds"),"APJ6JRA9NG5V4");
  assert.equal(init.redirect,"manual");
  if(init.method==="GET"){
   assert.equal(u.searchParams.get("includedData"),"summaries,attributes,issues");
   return new Response(JSON.stringify(detail),{status:200,headers:{"content-type":"application/json"}});
  }
  assert.equal(init.method,"PATCH");
  assert.equal(u.searchParams.get("mode"),"VALIDATION_PREVIEW");
  assert.equal(u.searchParams.get("issueLocale"),"en_US");
  const body=JSON.parse(init.body);
  assert.equal(body.productType,"SHOES");
  assert.equal(body.patches.length,1);
  assert.equal(body.patches[0].op,"replace");
  assert.equal(body.patches[0].path,"/attributes/gpsr_manufacturer_reference");
  assert.deepEqual(body.patches[0].value,[{
   gpsr_manufacturer_email_address:manufacturer,marketplace_id:"APJ6JRA9NG5V4"
  }]);
  assert(!init.body.includes("purchasable_offer"));
  assert(!init.body.includes("fulfillment_availability"));
  assert(!init.body.includes("dsa_responsible_party_address"));
  assert(!init.body.includes("gpsr_safety_attestation"));
  return new Response(JSON.stringify({sku,status:"INVALID",
    issues:[{code:"100632",severity:"ERROR",message:"Private "+manufacturer}]}),
    {status:200,headers:{"content-type":"application/json"}});
 }
};
const out=await run({sku},env,dependencies);
assert.equal(out.ok,true);
assert.equal(out.response_status,"INVALID");
assert.deepEqual(out.issue_codes,["100632"]);
assert.equal(out.provider_mutations,0);
assert.equal(out.can_publish,false);
assert.equal(out.gpsr_compliance_proven,false);
assert.deepEqual(requests.map(x=>x.method),["GET","PATCH"]);
assert(requests[1].url.includes("mode=VALIDATION_PREVIEW"));
assert(!JSON.stringify(out).includes(manufacturer));
assert(!JSON.stringify(out).includes("SECRET-TOKEN"));
assert(!JSON.stringify(out).includes("Private"));
for(const request of [{},{sku:"KANGOL_01"},{sku:"../unsafe"},{sku,extra:1}]){
 await assert.rejects(()=>run(request,env,dependencies),/gpsr_existing_manufacturer_preview_invalid_request/);
}
const noStock=await run({sku},env,{...dependencies,
 seller:async()=>({...seller,results:[{...seller.results[0],current_fbm_quantity:0}]}),
 auth:async()=>{throw Error("must not call auth");}});
assert.equal(noStock.status,"NOT_ELIGIBLE_EXISTING_POSITIVE_STOCK_100632");
const buyable=await run({sku},env,{...dependencies,
 seller:async()=>({...seller,results:[{...seller.results[0],statuses:["BUYABLE"]}]}),
 auth:async()=>{throw Error("must not call auth");}});
assert.equal(buyable.status,"NOT_ELIGIBLE_EXISTING_POSITIVE_STOCK_100632");
const noManufacturer=await run({sku},env,{...dependencies,fetch:async(url,init)=>{
 assert.equal(init.method,"GET");
 return new Response(JSON.stringify({...detail,attributes:{}}),
 {status:200,headers:{"content-type":"application/json"}});
}});
assert.equal(noManufacturer.status,"NO_UNIQUE_EXISTING_MANUFACTURER_REFERENCE");
const conflicting=await run({sku},env,{...dependencies,fetch:async(url,init)=>{
 assert.equal(init.method,"GET");
 return new Response(JSON.stringify({...detail,summaries:[{marketplaceId:"APJ6JRA9NG5V4",asin:"B0DIFFERENT"}]}),
 {status:200,headers:{"content-type":"application/json"}});
}});
assert.equal(conflicting.status,"AMAZON_ASIN_IDENTITY_MISMATCH");
const unknown=await run({sku},env,{...dependencies,fetch:async(url,init)=>{
 if(init.method==="GET")return new Response(JSON.stringify(detail),
 {status:200,headers:{"content-type":"application/json"}});
 return new Response(JSON.stringify({sku,status:"VALID",issues:[]}),
 {status:200,headers:{"content-type":"application/json"}});
}});
assert.equal(unknown.ok,true);
assert.equal(unknown.response_status,"VALID");
assert.equal(unknown.gpsr_compliance_proven,false);
const fakeAccepted=await run({sku},env,{...dependencies,fetch:async(url,init)=>{
 if(init.method==="GET")return new Response(JSON.stringify(detail),
 {status:200,headers:{"content-type":"application/json"}});
 return new Response(JSON.stringify({sku,status:"ACCEPTED",issues:[]}),
 {status:200,headers:{"content-type":"application/json"}});
}});
assert.equal(fakeAccepted.ok,false);
assert.equal(fakeAccepted.status,"AMAZON_VALIDATION_PREVIEW_RESPONSE_UNVERIFIED");
console.log("Existing-value GPSR preview remains non-persisting and PII-safe: PASS");
