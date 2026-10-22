import assert from "node:assert/strict";
import {build} from "esbuild";
const b=await build({entryPoints:["src/mare-business-amazon-existing-offers-bulk-worklist.ts"],
 bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
const {readAmazonExistingOffersBulkCaseWorklist:read}=
 await import("data:text/javascript;base64,"+Buffer.from(b.outputFiles[0].text).toString("base64"));
const codes=[
 ["RNS_15600_COAL","5715793005679","B0HLWFFZKD"],
 ["RNS_14160_COAL","5715793003613","B0H1JMJJ23"],
 ["RNS_15580_COAL","5715793016255","B0HLWJQBJZ"],
 ["RNS_12870_BEIGE","5715793002913","B0HBCBQL7P"],
 ["RNS_RA14160_BLU","5715793003620","B0H1JM72GF"],
 ["RNS_13000_DFT","5711747603151","B0FR33PJ85"],
 ["RNS_14920_BLACK","5711747572921","B0CW4LTCX4"],
];
const entries=codes.map(([sku,ean])=>({sku,ean}));
const typeCodes=[
 "SELLER_SUPPORT_100632_NO_APPLICATION_LINK",
 "EXISTING_OFFER_BUYABLE",
 "SELLER_CENTRAL_APPROVAL_LINK",
 "CATALOG_IDENTITY_ESCALATION",
 "RECHECK_REQUIRED",
 "SELLER_IDENTITY_DIAGNOSTICS",
 "NOT_100632_COHORT",
];
let calls=[];
function mockRows(request,flip=undefined){
 return {
 ok:true,status:"READ_ONLY_EXISTING_OFFER_TRIAGE",read_only:true,
 marketplace:request.marketplace,requested:request.items.length,
 provider_mutations:0,brand_approval_proven:false,can_publish:false,
 offers_created:0,applications_created:0,
 support_case_created:false,seller_central_submission_performed:false,
 results:request.items.map(item=>{
  const i=codes.findIndex(y=>y[0]===item.sku);
  const state=typeCodes[i],asin=codes[i][2];
  const isSupport=state==="SELLER_SUPPORT_100632_NO_APPLICATION_LINK";
  return {
   sku:item.sku,ean:item.ean,asin,
   state,listing_issues:isSupport?["100632","100527"]:["18448"],
   additional_issue_codes:isSupport?["100527"]:["18448"],
   catalog_ean_state:isSupport?"MATCH":"UNKNOWN",
   catalog_asin_state:isSupport?"FOUND":"UNKNOWN",
   restrictions_state:isSupport?"NO_RESTRICTIONS_RETURNED_NOT_APPROVAL_PROOF":"UNKNOWN",
   brand_approval_proven:false,can_publish:false,
   seller_central_approval_url:state==="SELLER_CENTRAL_APPROVAL_LINK"?
    "https://sellercentral.amazon.es/hz/approvalrequest/restrictions/approve?asin="+asin:null,
  };
 }),...flip};
}
const input={marketplace:"ES",items:entries};
const run=(payload=input,fn=undefined)=>read(payload,{},{
 triage:fn??(async request=>{
  calls.push(request.items.map(x=>x.sku));
  return mockRows(request);
 })
});
const correct=await run();
assert.equal(correct.ok,true);
assert.equal(correct.status,"READ_ONLY_BULK_CASE_WORKLIST");
assert.equal(correct.requested,7);
assert.equal(correct.batches_read,3);
assert.deepEqual(calls.map(x=>x.length),[3,3,1]);
assert.equal(correct.results.length,7);
assert.equal(correct.results[0].ean,codes[0][1]);
for(const t of typeCodes)assert.equal(correct.counts[t],1);
assert.equal(correct.worklist.length,7);
assert.equal(correct.worklist[0].route,typeCodes[0]);
assert.equal(correct.worklist[0].sku_asin.length,1);
assert.equal(correct.worklist[2].sku_asin[0].seller_central_approval_url,
 "https://sellercentral.amazon.es/hz/approvalrequest/restrictions/approve?asin="+codes[2][2]);
assert.equal(correct.provider_mutations,0);
assert.equal(correct.brand_approval_proven,false);
assert.equal(correct.seller_support_cases_created,0);
assert.equal(correct.applications_created,0);
assert.equal(correct.can_publish,false);
assert.equal(correct.channable_handoff_performed,false);
assert.equal(correct.empty_listings_restrictions_do_not_prove_brand_approval,true);
assert(!JSON.stringify(correct).includes("Bearer"));
calls=[];
const small=await run({marketplace:"ES",items:entries.slice(0,2)});
assert.equal(small.batches_read,1);
assert.deepEqual(calls.map(x=>x.length),[2]);
for(const invalid of [
 {marketplace:"ES",items:[]},
 {marketplace:"ES",items:[...entries,...entries.slice(0,3)]},
 {marketplace:"ES",items:[entries[0],entries[0]]},
 {marketplace:"ES",items:[{...entries[0],ean:"5715793005670"}]},
 {marketplace:"ES",items:[{...entries[0],ean:"abc"}]},
 {marketplace:"ES",items:entries.slice(0,1),compare_marketplace:"ES"},
 {marketplace:"US",items:entries.slice(0,1)},
 {marketplace:"ES",items:entries.slice(0,1),publish:true}
])await assert.rejects(()=>run(invalid),/amazon_bulk_offer_worklist_invalid_request/);
const faulty=[
 (r)=>({...r,ok:false}),
 (r)=>({...r,provider_mutations:1}),
 (r)=>({...r,brand_approval_proven:true}),
 (r)=>({...r,results:r.results.slice(1)}),
 (r)=>({...r,results:[r.results[0],...r.results.slice(0,2)]}),
 (r)=>({...r,results:r.results.map((x,i)=>i===0?{...x,ean:"0000000000000"}:x)}),
 (r)=>({...r,results:r.results.map((x,i)=>i===0?{...x,state:"UNSAFE_AUTO_APPROVED"}:x)}),
 (r)=>({...r,results:r.results.map((x,i)=>i===0?{...x,seller_central_approval_url:"https://evil.example/approval"}:x)}),
 (r)=>({...r,results:r.results.map((x,i)=>i===0?{...x,listing_issues:[]} :x)}),
];
for(const bad of faulty){
 let n=0;
 const result=await run(input,async req=>{
  n++;
  const baseline=mockRows(req);
  return n===1?bad(baseline):baseline;
 });
 assert.equal(result.ok,false);
 assert.equal(result.status,"INCOMPLETE_WORKLIST_FAIL_CLOSED");
 assert.equal(result.counts_are_safe_to_act_on,false);
 assert.deepEqual(result.results,[]);
 assert.equal(n,1,"Stop subsequent batches after failed evidence");
}
const crash=await run(input,async()=>{throw Error("synthetic timeout: credentials omitted")});
assert.equal(crash.ok,false);
assert.equal(crash.reason,"PROVIDER_READ_FAILED");
assert(!JSON.stringify(crash).includes("credentials omitted"));
console.log("PASS Amazon read-only bulk 100632 worklist: 9 SKU cap, serial batching, cases without submissions, fail-closed");
