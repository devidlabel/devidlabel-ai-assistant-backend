import assert from "node:assert/strict";
import {build} from "esbuild";
const built=await build({entryPoints:["src/mare-business-amazon-existing-gpsr-ptd.ts"],bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {readExistingItGpsrPtd:read}=await import("data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));
const sku="FWM_TEST_38_EU",asin="B0H2FBXMYL",type="SHOES",seller="A1234567891234";
const env={AMAZON_SP_API_SELLER_ID:seller};
const personal="secret-contact@example.org";
const listing={ok:true,read_only:true,provider_mutations:0,marketplace:"IT",results:[{
 sku,state:"PRESENT",identity_state:"VERIFIED",asin,product_type:type,
 statuses:["DISCOVERABLE"],issue_signals:[{code:"100632",severity:"ERROR"}]
}]};
const metadata={productType:type,requirements:"LISTING",requirementsEnforced:"NOT_ENFORCED",
 marketplaceIds:["APJ6JRA9NG5V4"],productTypeVersion:{latest:true,version:"2026-10-24"},
 schema:{checksum:"fake-checksum",link:{verb:"GET",resource:"https://amazon-ptd.s3.amazonaws.com/schema.json?X-Amz-Signature=redacted"}}};
const schema={type:"object",properties:{
 brand:{type:"array",items:{properties:{value:{type:"string"}}}},
 gpsr_manufacturer_reference:{type:"array",items:{properties:{gpsr_manufacturer_email_address:{type:"string",enum:[personal]}}}},
 dsa_responsible_party_address:{type:"array",items:{properties:{email_address:{type:"string",default:personal}}}},
 gpsr_safety_attestation:{type:"array",items:{properties:{value:{type:"boolean"}}}},
 compliance_media:{type:"array",items:{properties:{source_location:{type:"string"},content_language:{type:"string"}}}}
}};
let calls=0;
const deps={
 readSeller:async()=>listing,
 token:async()=>"TEST-TOKEN",
 fetch:async(url,init)=>{
  calls++;
  assert.equal(init.method,"GET");assert.equal(init.redirect,"manual");
  assert(!String(url).includes("example.org"));
  const isMeta=url.includes("/definitions/2020-09-01/productTypes/");
  if(isMeta){
   const u=new URL(url);
   assert.equal(u.searchParams.get("requirementsEnforced"),"NOT_ENFORCED");
   assert.equal(u.searchParams.get("requirements"),"LISTING");
   assert.equal(u.searchParams.get("marketplaceIds"),"APJ6JRA9NG5V4");
   return new Response(JSON.stringify(metadata),{status:200,headers:{"content-type":"application/json"}});
  }
  assert.equal(new URL(url).hostname,"amazon-ptd.s3.amazonaws.com");
  assert.equal(init.headers["x-amz-access-token"],undefined);
  return new Response(JSON.stringify(schema),{status:200,headers:{"content-type":"binary/octet-stream"}});
 }
};
const result=await read({sku},env,deps);
assert.equal(result.ok,true);assert.equal(result.status,"GPSR_PTD_SCHEMA_INSPECTED");
assert.equal(result.provider_mutations,0);assert.equal(result.can_publish,false);
assert.equal(result.schema_checksum_verified,false);
assert.equal(result.ptd_requirements_enforced,"NOT_ENFORCED");
assert.equal(calls,2);
assert.deepEqual(result.fields.map(x=>x.name),[
 "gpsr_manufacturer_reference","dsa_responsible_party_address",
 "gpsr_safety_attestation","compliance_media"]);
assert(result.fields.find(x=>x.name==="gpsr_manufacturer_reference").nested_property_paths.includes("gpsr_manufacturer_email_address"));
assert(!JSON.stringify(result).includes(personal));
assert(!JSON.stringify(result).includes("TEST-TOKEN"));
assert(!JSON.stringify(result).includes("X-Amz-Signature"));
assert.equal(result.gpsr_compliance_proven,false);
for(const item of [{},{sku:"KANGOL_X"},{sku:"../unsafe"},{sku:" A "},{sku,extra:true}]){
 await assert.rejects(()=>read(item,env,deps),/amazon_existing_gpsr_ptd_invalid_request/);
}
const rejected=await read({sku},env,{...deps,
 readSeller:async()=>({...listing,results:[{...listing.results[0],statuses:["BUYABLE"]}]}),
 token:async()=>{throw Error("should not request token");}});
assert.equal(rejected.status,"SELLER_NOT_CONFIRMED_EXISTING_GPSR_TARGET");
const wrongAsin=await read({sku},env,{...deps,
 readSeller:async()=>({...listing,results:[{...listing.results[0],asin:"bad"}]})});
assert.equal(wrongAsin.ok,false);
const malicious=await read({sku},env,{...deps,
 fetch:async(url)=>{
  if(url.includes("/definitions/"))return new Response(JSON.stringify({
   ...metadata,schema:{...metadata.schema,link:{verb:"GET",resource:"https://evil.example.org/take-private"}}}
  }),{status:200,headers:{"content-type":"application/json"}});
  throw Error("SSRF: should not reach arbitrary origin");
 }});
assert.equal(malicious.status,"PTD_METADATA_IDENTITY_UNVERIFIED");
const stale=await read({sku},env,{...deps,fetch:async()=>new Response("Error",{status:503})});
assert.equal(stale.status,"PTD_METADATA_UNAVAILABLE");
console.log("Amazon existing IT GPSR PTD read-only safety tests passed.");
