import assert from "node:assert/strict";
import {build} from "esbuild";
const built=await build({entryPoints:["src/mare-business-amazon-it-issue-signals.ts"],
 bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {readAmazonItExistingIssueSignals:read}=await import(
 "data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));
const env={AMAZON_SP_API_SELLER_ID:"A1234567891234"};
const skus=["ECO_SAMPLE","MC2_SAMPLE","BUYABLE_SAMPLE"];
const sellerRead=async()=>({ok:true,read_only:true,provider_mutations:0,
 marketplace:"IT",results:[
 {sku:"ECO_SAMPLE",state:"PRESENT",identity_state:"VERIFIED",
  asin:"B0HGM56H31",statuses:["DISCOVERABLE"],
  issue_signals:[{code:"100632",severity:"ERROR"}]},
 {sku:"MC2_SAMPLE",state:"PRESENT",identity_state:"VERIFIED",
  asin:"B0H15Y3PZ5",statuses:["DISCOVERABLE"],
  issue_signals:[{code:"19038",severity:"ERROR"},{code:"100587",severity:"ERROR"}]},
 {sku:"BUYABLE_SAMPLE",state:"PRESENT",identity_state:"VERIFIED",
  asin:"B0GVXHVPLH",statuses:["BUYABLE"],
  issue_signals:[{code:"100632",severity:"ERROR"}]}
]});
const privateValue="Private Merchant 10 Secret Avenue seller@example.org";
let calls=0;
const deps={sellerRead,getAccessToken:async()=>"SECRET_ACCESS_TOKEN",
 fetch:async(url,init)=>{
  calls++;
  assert.equal(init.method,"GET");assert.equal(init.redirect,"manual");
  assert.equal(new URL(url).hostname,"sellingpartnerapi-eu.amazon.com");
  assert.equal(new URL(url).searchParams.get("includedData"),"summaries,issues");
  assert.equal(new URL(url).searchParams.get("issueLocale"),"en_US");
  const sku=decodeURIComponent(new URL(url).pathname.split("/").at(-1));
  if(sku==="ECO_SAMPLE")return new Response(JSON.stringify({
   sku,summaries:[{marketplaceId:"APJ6JRA9NG5V4",asin:"B0HGM56H31"}],
   issues:[{marketplaceId:"APJ6JRA9NG5V4",code:"100632",severity:"ERROR",
    attributeNames:["dsa_responsible_party_address"],
    message:"GPSR responsible person and manufacturer contact are required: "+privateValue},
   {code:"100527",severity:"WARNING",message:privateValue}]
  }),{status:200,headers:{"content-type":"application/json"}});
  return new Response(JSON.stringify({
   sku,summaries:[{marketplaceId:"APJ6JRA9NG5V4",asin:"B0H15Y3PZ5"}],
   issues:[{code:"19038",severity:"ERROR",
     message:"Your selling price exceeds your maximum price setting: "+privateValue},
    {code:"100587",severity:"ERROR",
     attributeNames:["media_locator"],message:"Image URL invalid "+privateValue}]
  }),{status:200,headers:{"content-type":"application/json"}});
 }};
const out=await read({skus},env,deps);
assert.equal(out.ok,true);
assert.equal(out.provider_mutations,0);
assert.equal(out.price_ceiling_verified,false);
assert.equal(out.manufacturer_verified,false);
assert.equal(calls,2,"BUYABLE never fetched from Amazon again");
assert.deepEqual(out.results[0].issues[0].wording_signals,
 ["GPSR_WORDING","RESPONSIBLE_PERSON_WORDING","MANUFACTURER_WORDING"]);
assert.deepEqual(out.results[0].issues[0].attributes,["dsa_responsible_party_address"]);
assert.deepEqual(out.results[1].issues.map(x=>x.code),["19038","100587"]);
assert(out.results[1].issues[0].wording_signals.includes("PRICE_BOUND_WORDING"));
assert(out.results[1].issues[1].wording_signals.includes("MEDIA_WORDING"));
assert.equal(out.results[2].state,"SKIPPED_UNVERIFIED_OR_BUYABLE");
assert(!JSON.stringify(out).includes(privateValue));
assert(!JSON.stringify(out).includes("example.org"));
assert(!JSON.stringify(out).includes("SECRET_ACCESS_TOKEN"));
const mismatch=await read({skus:["ECO_SAMPLE"]},env,{...deps,
 fetch:async()=>new Response(JSON.stringify({
  sku:"ECO_SAMPLE",summaries:[{marketplaceId:"APJ6JRA9NG5V4",asin:"B0WRONGASIN"}],
  issues:[{code:"100632",severity:"ERROR",message:privateValue}]
 }),{status:200,headers:{"content-type":"application/json"}})});
assert.equal(mismatch.results[0].state,"IDENTITY_OR_ISSUES_UNVERIFIED");
const rejected=await read({skus:["ECO_SAMPLE"]},env,{...deps,
 fetch:async()=>new Response("Server error "+privateValue,{status:503})});
assert.equal(rejected.results[0].state,"AMAZON_ISSUE_READ_UNVERIFIED");
const notPresent=await read({skus:["ECO_SAMPLE"]},env,{...deps,
 sellerRead:async()=>({ok:true,read_only:true,provider_mutations:0,marketplace:"IT",
 results:[{sku:"ECO_SAMPLE",state:"UNKNOWN",identity_state:"UNKNOWN"}]}),
 getAccessToken:async()=>{throw Error("must not call Amazon");}});
assert.equal(notPresent.status,"NO_CONFIRMED_EXISTING_INACTIVE_TARGETS");
for(const bad of [{},{skus:[]},{skus:["../bad"]},
 {skus:["X","X"]},{skus:["a","b","c","d"]},{skus, extra:true}]){
 await assert.rejects(()=>read(bad,env,deps),/amazon_it_issue_signals_invalid_request/);
}
console.log("Amazon IT existing issue wording privacy/read-only tests passed.");
