import assert from "node:assert/strict";
import { build } from "esbuild";
const out=await build({entryPoints:["src/mare-business-amazon-qualification-restrictions.ts"],
  bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
const {readAmazonQualificationRestrictions:read}=await import(
  "data:text/javascript;base64,"+Buffer.from(out.outputFiles[0].text).toString("base64"));
const env={AMAZON_SP_API_SELLER_ID:"A1234567891234"};
const skus=["TEST_BLOCKED","TEST_BUY","TEST_ABSENT","TEST_UNKNOWN"];
const listing=()=>({ok:true,marketplace:"ES",results:[
  {sku:"TEST_BLOCKED",state:"PRESENT",asin:"B0HMPR8T18",statuses:["DISCOVERABLE"],
   issue_signals:[{code:"100632",severity:"ERROR",categories:["QUALIFICATION_REQUIRED"]}]},
  {sku:"TEST_BUY",state:"PRESENT",asin:"B0HMPHFX88",statuses:["BUYABLE"],
   issue_signals:[{code:"100632",severity:"ERROR"}]},
  {sku:"TEST_ABSENT",state:"VERIFIED_ABSENT",asin:null,statuses:[],issue_signals:[]},
  {sku:"TEST_UNKNOWN",state:"PRESENT_ATTRIBUTES_UNKNOWN",asin:null,statuses:[],
   issue_signals:[{code:"100632",severity:"ERROR"}]},
]});
let calls=0;
const deps={
  readListings:async q=>{assert.deepEqual(q,{marketplace:"ES",skus});return listing();},
  getAccessToken:async()=>"test-access-token",
  fetch:async(url,init)=>{
    calls++;
    const u=new URL(url);
    assert.equal(u.hostname,"sellingpartnerapi-eu.amazon.com");
    assert.equal(u.pathname,"/listings/2021-08-01/restrictions");
    assert.equal(u.searchParams.get("asin"),"B0HMPR8T18");
    assert.equal(u.searchParams.get("marketplaceIds"),"A1RKKUPIHCS9HS");
    assert.equal(u.searchParams.get("conditionType"),"new_new");
    assert.equal(init.method,"GET");
    assert.equal(init.redirect,"manual");
    return new Response(JSON.stringify({restrictions:[{
      marketplaceId:"A1RKKUPIHCS9HS",conditionType:"new_new",
      reasons:[{reasonCode:"APPROVAL_REQUIRED",
        message:"private provider description",
        links:[{resource:"https://sellercentral.amazon.es/abis/listing/apply",verb:"GET"},
          {resource:"https://evil.example/hijack",verb:"GET"}]}]
    }]}),{status:200,headers:{"content-type":"application/json"}});
  }
};
const result=await read({marketplace:"ES",skus},env,deps);
assert.equal(result.ok,true);
assert.equal(calls,1,"only confirmed nonbuyable issue can call restrictions API");
assert.equal(result.results[0].status,"RESTRICTIONS_REPORTED");
assert.deepEqual(result.results[0].reason_codes,["APPROVAL_REQUIRED"]);
assert.deepEqual(result.results[0].seller_central_links,
  ["https://sellercentral.amazon.es/abis/listing/apply"]);
for(const x of result.results.slice(1))
  assert.equal(x.status,"NO_CONFIRMED_NONBUYABLE_100632");
assert.equal(result.provider_mutations,0);
assert.equal(result.brand_approval_proven,false);
assert.equal(result.applications_created,0);
assert.ok(!JSON.stringify(result).includes("private provider description"));
assert.ok(!JSON.stringify(result).includes("test-access-token"));
assert.ok(!JSON.stringify(result).includes("evil.example"));
const empty=await read({marketplace:"ES",skus},env,{...deps,
  fetch:async()=>new Response(JSON.stringify({restrictions:[]}),
    {status:200,headers:{"content-type":"application/json"}})});
assert.equal(empty.results[0].status,"NO_RESTRICTIONS_RETURNED_NOT_APPROVAL_PROOF");
assert.equal(empty.brand_approval_proven,false);
const mismatch=await read({marketplace:"ES",skus},env,{...deps,
  fetch:async()=>new Response(JSON.stringify({
    restrictions:[{marketplaceId:"APJ6JRA9NG5V4",reasons:[]}]
  }),{status:200,headers:{"content-type":"application/json"}})});
assert.equal(mismatch.results[0].status,"RESTRICTIONS_RESPONSE_UNVERIFIED");
const throttled=await read({marketplace:"ES",skus},env,{...deps,
  fetch:async()=>new Response("slow down",{status:429,headers:{"content-type":"text/plain"}})});
assert.equal(throttled.results[0].status,"RESTRICTIONS_RESPONSE_UNVERIFIED");
const noBlocked=await read({marketplace:"ES",skus},env,{...deps,
  readListings:async()=>({...listing(),results:listing().results.map(z=>({
    ...z,issue_signals:[],statuses:["BUYABLE"]}))}),
  getAccessToken:async()=>{throw Error("should not be called");},
  fetch:async()=>{throw Error("should not be called");}});
assert.equal(noBlocked.status,"NO_VERIFIED_100632_TARGETS");
for(const raw of [{},{marketplace:"US",skus}, {marketplace:"ES",skus:["../bad"]},
  {marketplace:"ES",skus:["REPEAT","REPEAT"]},
  {marketplace:"ES",skus:["a","b","c","d","e"]},
  {marketplace:"ES",skus,mode:"LIVE"}]){
  await assert.rejects(()=>read(raw,env,deps),/amazon_qualification_invalid_request/);
}
console.log("Amazon 100632 restrictions read-only safety tests passed.");
