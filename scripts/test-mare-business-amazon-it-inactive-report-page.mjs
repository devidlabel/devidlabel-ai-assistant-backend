import assert from "node:assert/strict";
import {build} from "esbuild";
const b=await build({entryPoints:["src/mare-business-amazon-it-inactive-report-page.ts"],
 bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
const {readAmazonItInactiveReportPage:read}=await import(
 "data:text/javascript;base64,"+Buffer.from(b.outputFiles[0].text).toString("base64"));
const timestamp="2026-10-24T09:00:55+00:00";
const tsv=[
 "Status\tReason\tSKU\tASIN\tProduct name\tCondition\tStatus Change Date\tIssue Description",
 "INACTIVE\t100632\tPUI_101_101_VINTAGE_ECLIPSE_43_EU\tB0HMPJYY5X\tShoe\tNew\t2026-10-24\tGPSR missing responsible person",
 "INACTIVE\t8541\tGML_FW2617008_SABLE_2\tB0HLQ4D3VG\tPullover\tNew\t2026-10-24\tMatching conflict",
 "INACTIVE\tUnknown\tSPR_910B9099NSZ\tB0HBR78DG7\tBackpack\tNew\t2026-10-24\tNo data",
 "DELETED\tGPSR\tDELETE_ME\tB000000001\tDeleted\tNew\t2026-10-24\tProduct safety",
 "INACTIVE\tGPSR\tNO_ASIN\t\tMissing\tNew\t2026-10-24\tSafety",
].join("\n")+"\n";
let calls=[];
const deps={clock:()=>Date.parse("2026-10-24T09:01:55Z"),getAccessToken:async()=>"token",
 fetch:async(url,init)=>{
  calls.push({url,method:init.method,auth:init.headers?.["x-amz-access-token"]});
  const u=new URL(url);
  if(u.pathname.endsWith("/reports")&&u.hostname==="sellingpartnerapi-eu.amazon.com")
   return new Response(JSON.stringify({reports:[{
     reportId:"250479020750",reportType:"GET_MERCHANT_LISTINGS_INACTIVE_DATA",
     processingStatus:"DONE",reportDocumentId:"amzn1.spdoc.1.4.eu.opaque",createdTime:timestamp
   }]}),{status:200,headers:{"content-type":"application/json"}});
  if(u.pathname.endsWith("/amzn1.spdoc.1.4.eu.opaque"))
   return new Response(JSON.stringify({url:"https://reports.s3.amazonaws.com/download-file"}),
    {status:200,headers:{"content-type":"application/json"}});
  if(u.hostname==="reports.s3.amazonaws.com"){
   assert.equal(init.auth,undefined);
   assert.equal(init.headers,undefined);
   return new Response(tsv,{status:200,headers:{"content-type":"text/plain"}});
  }
  throw Error("unexpected fetch "+url);
 }
};
// Regression: opaque Amazon spdoc IDs with dots must remain readable.
const out=await read({after:0,limit:2},{},deps);
assert.equal(out.ok,true);
assert(calls.some(c=>new URL(c.url).pathname.endsWith("/amzn1.spdoc.1.4.eu.opaque")));
assert.equal(out.status,"REPORT_INACTIVE_ASIN_CANDIDATES_READONLY");
assert.equal(out.report_id,"250479020750");
assert.equal(out.report_rows,5);
assert.equal(out.asin_candidate_rows,3);
assert.equal(out.deleted_rows_excluded,1);
assert.equal(out.missing_asin_excluded,1);
assert.equal(out.has_more,true);
assert.equal(out.next_after,2);
assert.deepEqual(out.rows.map(x=>x.classification),
 ["GPSR_INDICATION","IDENTITY_8541"]);
assert(out.rows.every(r=>r.shopify_stock==="NOT_VERIFIED"&&
 r.direct_seller_identity==="NOT_RECHECKED"));
assert.equal(out.listing_mutations,0);
assert.equal(out.can_publish,false);
assert.equal(out.document_url_exposed,false);
assert(!JSON.stringify(out).includes("reports.s3.amazonaws.com"));
assert(calls.every(c=>c.method==="GET"));
// Amazon's official inactive report can omit Status/Reason columns.
const compact=tsv.split("\n").filter(line=>!line.startsWith("DELETED\t"))
 .map((line,i)=>line.split("\t")
 .filter((_,col)=>col!==0&&col!==1).join("\t")).join("\n");
const noStatus=await read({}, {}, {...deps,fetch:async(url,init)=>{
 if(new URL(url).hostname==="reports.s3.amazonaws.com")
  return new Response(compact,{status:200});
 return deps.fetch(url,init);
}});
assert.equal(noStatus.asin_candidate_rows,3);
assert.equal(noStatus.rows[0].classification,"GPSR_INDICATION");
const next=await read({after:2,limit:2},{},deps);
assert.deepEqual(next.rows.map(x=>x.sku),["SPR_910B9099NSZ"]);
assert.equal(next.has_more,false);
for(const input of [{after:-1},{after:1.2},{limit:51},{page:1},null]){
 await assert.rejects(()=>read(input,{},deps),/amazon_inactive_report_page_invalid_request/);
}
const stale=await read({}, {}, {...deps,clock:()=>Date.parse("2026-10-30T00:00:00Z")});
assert.equal(stale.status,"REPORT_TOO_OLD");
console.log("amazon it inactive report safe paginated audit: PASS");