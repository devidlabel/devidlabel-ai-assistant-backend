import assert from "node:assert/strict";
import {build} from "esbuild";
const b=await build({entryPoints:["src/mare-business-amazon-it-inactive-report.ts"],
 bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
const {readAmazonItInactiveReportStatus:read,requestAmazonItInactiveReport:request}=
 await import("data:text/javascript;base64,"+Buffer.from(b.outputFiles[0].text).toString("base64"));
const now=Date.parse("2026-10-24T08:50:00Z");
const mk=(reports=[])=>{
 const calls=[];
 const deps={clock:()=>now,getAccessToken:async()=>"secret-test-token",
  fetch:async(url,init)=>{
   calls.push({method:init.method,url,body:init.body||null});
   assert.equal(new URL(url).hostname,"sellingpartnerapi-eu.amazon.com");
   if(init.method==="GET"){
    assert.equal(new URL(url).searchParams.get("marketplaceIds"),"APJ6JRA9NG5V4");
    assert.equal(new URL(url).searchParams.get("reportTypes"),"GET_MERCHANT_LISTINGS_INACTIVE_DATA");
    return new Response(JSON.stringify({reports}),{status:200,headers:{"content-type":"application/json"}});
   }
   assert.equal(init.method,"POST");
   const body=JSON.parse(init.body);
   assert.deepEqual(body,{reportType:"GET_MERCHANT_LISTINGS_INACTIVE_DATA",
    marketplaceIds:["APJ6JRA9NG5V4"],reportOptions:{preferredReportDocumentLocale:"en_US"}});
   return new Response(JSON.stringify({reportId:"123456789012"}),{status:202,headers:{"content-type":"application/json"}});
  }
 };
 return {deps,calls};
};
const env={},empty=mk();
const status=await read({},env,empty.deps);
assert.equal(status.report_available,false);
assert.equal(status.latest_report,null);
assert.equal(empty.calls.length,1);
const first=await request({},env,empty.deps);
assert.equal(first.status,"REPORT_REQUESTED");
assert.equal(first.report_request_created,true);
assert.equal(first.report.report_id,"123456789012");
assert.equal(first.listing_mutations,0);
assert.equal(first.stock_writes,0);
assert.equal(first.price_writes,0);
assert.equal(first.can_publish,false);
assert.equal(empty.calls.length,3);
const recent=[{reportType:"GET_MERCHANT_LISTINGS_INACTIVE_DATA",
 reportId:"12345678900",processingStatus:"IN_PROGRESS",
 createdTime:"2026-10-24T08:00:00Z"}];
const fresh=mk(recent);
const reused=await request({},env,fresh.deps);
assert.equal(reused.status,"REPORT_REUSED");
assert.equal(reused.report_request_created,false);
assert.equal(fresh.calls.length,1);
const done=mk([{...recent[0],processingStatus:"DONE",reportDocumentId:"PRIVATE_DOC"}]);
const ready=await read({},env,done.deps);
assert.equal(ready.report_available,true);
assert.equal(ready.latest_report.document_available,true);
assert(!JSON.stringify(ready).includes("PRIVATE_DOC"));
assert(!JSON.stringify(ready).includes("secret-test-token"));
const old=mk([{...recent[0],createdTime:"2026-10-23T00:00:00Z"}]);
const again=await request({},env,old.deps);
assert.equal(again.status,"REPORT_REQUESTED");
assert.equal(old.calls.length,2);
for(const bad of [{marketplace:"IT"},{force:true},null,[]]){
 await assert.rejects(()=>read(bad,env,empty.deps),/amazon_it_inactive_report_invalid_request/);
}
const failing=mk([{...recent[0],reportId:"invalid-report-id"}]);
const invalid=await read({},env,failing.deps);
assert.equal(invalid.latest_report,null);
console.log("amazon it inactive-report request and metadata: PASS");