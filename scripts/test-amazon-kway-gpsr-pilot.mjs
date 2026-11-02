import assert from "node:assert/strict";
import {build} from "esbuild";
const b=await build({entryPoints:["src/mare-business-amazon-kway-gpsr-contact-pilot.ts"],
 bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {patchKwayRoulandGpsrContacts:run}=await import(
 "data:text/javascript;base64,"+Buffer.from(b.outputFiles[0].text).toString("base64"));
const sku="KWAY_K6131ZW_USY_S",asin="B0HQ4XP9NZ",email="customer@k-way.com";
const env={AMAZON_SP_API_SELLER_ID:"A1234567891234",AMAZON_OFFER_PREVIEW_ENABLED:"true"};
const input={marketplace:"IT",sku,asin};
const evidence={brand:"K-Way",source_scope:"OFFICIAL_COMPANY_CONTACT_NOT_PRODUCT_LABEL_GPSR_PROOF",
 brand_operator:{name:"K-Way S.p.A.",public_contact_email:email},
 amazon_mapping_status:"DRAFT_GPSR_FIELDS_NOT_SUBMITTED_TO_AMAZON"};
const listing={ok:true,provider_mutations:0,results:[{sku,asin,product_type:"COAT",
 state:"PRESENT",identity_state:"VERIFIED",current_fbm_quantity:0,statuses:[],
 issue_signals:[{code:"100632",severity:"ERROR"}]}]};
const shopify={productVariants:{pageInfo:{hasNextPage:false},nodes:[{sku,inventoryQuantity:1,
 product:{id:"gid://shopify/Product/11523512729941",vendor:"K-Way",status:"ACTIVE",
 evidence:{type:"json",value:JSON.stringify(evidence)},mf:{value:email},rp:{value:email}}}]}};
const detail={sku,summaries:[{marketplaceId:"APJ6JRA9NG5V4",asin}],attributes:{}};
let calls=[];
const deps={seller:async()=>listing,shopify:async()=>shopify,auth:async()=>"TEST-TOKEN",
 fetch:async(url,options)=>{
  const u=new URL(url),method=options.method;
  calls.push({method,mode:u.searchParams.get("mode")});
  assert.equal(u.hostname,"sellingpartnerapi-eu.amazon.com");
  if(method==="GET")return new Response(JSON.stringify(detail),{
   status:200,headers:{"content-type":"application/json"}});
  assert.equal(method,"PATCH");
  const payload=JSON.parse(options.body);
  assert.equal(payload.productType,"COAT");
  assert.equal(payload.patches.length,2);
  assert.deepEqual(payload.patches.map(p=>p.path),[
   "/attributes/gpsr_manufacturer_reference",
   "/attributes/dsa_responsible_party_address"]);
  assert.equal(payload.patches[0].value[0].gpsr_manufacturer_email_address,email);
  assert.equal(payload.patches[1].value[0].value,email);
  assert(!options.body.includes("fulfillment_availability"));
  assert(!options.body.includes("purchasable_offer"));
  assert(!options.body.includes("gpsr_safety_attestation"));
  return new Response(JSON.stringify({sku,status:u.searchParams.has("mode")?"VALID":"ACCEPTED",
   issues:[],submissionId:"test-submission"}),{
   status:200,headers:{"content-type":"application/json"}});
 }};
const passed=await run(input,env,deps);
assert.equal(passed.ok,true);
assert.equal(passed.status,"GPSR_CONTACT_PATCH_SUBMITTED_AWAITING_READBACK");
assert.equal(passed.qty_changed,false);
assert.equal(passed.gpsr_compliance_proven,false);
assert.deepEqual(calls.map(x=>x.mode),[null,"VALIDATION_PREVIEW",null]);
assert(!JSON.stringify(passed).includes(email));
for(const raw of [{}, {...input,asin:"B000000001"},{...input,extra:1}])
 await assert.rejects(()=>run(raw,env,deps),/kway_gpsr_contact_pilot_invalid_request/);
let previewCalls=0;
const invalid=await run(input,env,{...deps,fetch:async(url,options)=>{
 if(options.method==="GET")return new Response(JSON.stringify(detail),{
  status:200,headers:{"content-type":"application/json"}});
 previewCalls++;assert(new URL(url).searchParams.has("mode"));
 return new Response(JSON.stringify({sku,status:"INVALID",issues:[{
  code:"90220",severity:"ERROR"}]}),{
  status:200,headers:{"content-type":"application/json"}});
}});
assert.equal(invalid.status,"GPSR_CONTACT_PREVIEW_NOT_VALID");
assert.equal(invalid.provider_mutations,0);
assert.equal(previewCalls,1);
const otherRole=await run(input,env,{...deps,shopify:async()=>({
 productVariants:{pageInfo:{hasNextPage:false},nodes:[{sku,inventoryQuantity:1,
 product:{...shopify.productVariants.nodes[0].product,
  evidence:{type:"json",value:JSON.stringify({...evidence,
    brand_operator:{name:"Other Co",public_contact_email:email}})}}}]}
}),fetch:async()=>{throw Error("must not fetch");}});
assert.equal(otherRole.status,"SHOPIFY_GPSR_CONTACTS_UNVERIFIED");
const conflict=await run(input,env,{...deps,fetch:async(url,options)=>{
 assert.equal(options.method,"GET");
 return new Response(JSON.stringify({...detail,attributes:{
  gpsr_manufacturer_reference:[{gpsr_manufacturer_email_address:"other@brand.example"}]}}),{
   status:200,headers:{"content-type":"application/json"}});
}});
assert.equal(conflict.status,"EXISTING_GPSR_REFERENCE_NOT_SAFE_TO_OVERWRITE");
console.log("K-Way GPSR contact-only canary fail-closed and one-shot: PASS");
