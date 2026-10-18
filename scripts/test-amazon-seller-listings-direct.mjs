import assert from "node:assert/strict";
import {build} from "esbuild";

/** Synthetic SP-API contract test: only Listings GET + LWA exchange. */
const bundled=await build({
  entryPoints:["src/mare-business-amazon-listings-direct.ts"],
  bundle:true,write:false,format:"esm",platform:"neutral",logLevel:"silent"
});
const {readAmazonSellerListingsDirect}=await import(
  "data:text/javascript;base64,"+
  Buffer.from(bundled.outputFiles[0].text).toString("base64")
);
const env={
  AMAZON_SP_API_CLIENT_ID:"synthetic-id",
  AMAZON_SP_API_CLIENT_SECRET:"synthetic-secret",
  AMAZON_SP_API_REFRESH_TOKEN:"synthetic-refresh",
  AMAZON_SP_API_SELLER_ID:"A123456789"
};
const original=globalThis.fetch;
let httpCalls=[];
const mock=(body,status=200,headers={})=>new Response(JSON.stringify(body),{
  status,headers:{"content-type":"application/json",
    "x-amzn-requestid":"req-synthetic-0001",...headers}
});
try{
  globalThis.fetch=async(url,opts={})=>{
    const u=new URL(String(url));
    if(u.hostname==="api.amazon.com"){
      assert.equal(opts.method,"POST");
      return mock({access_token:"synthetic-access"});
    }
    assert.equal(u.host,"sellingpartnerapi-eu.amazon.com");
    assert.equal(opts.method,"GET");
    assert.equal(opts.headers["x-amz-access-token"],"synthetic-access");
    assert.equal(u.searchParams.get("marketplaceIds"),"APJ6JRA9NG5V4");
    assert.equal(u.searchParams.get("includedData"),"summaries,offers,issues");
    const sku=decodeURIComponent(u.pathname.split("/").at(-1));
    httpCalls.push(sku);
    if(sku==="SYNTH_A")return mock({sku,summaries:[{
      marketplaceId:"APJ6JRA9NG5V4",asin:"B0TEST0001",
      productType:"HANDBAG",status:["BUYABLE"]
    }],offers:[{marketplaceId:"APJ6JRA9NG5V4"}],issues:[]});
    if(sku==="SYNTH_B")return mock({errors:[{code:"NOT_FOUND",message:"No listing"}]},404);
    if(sku==="SYNTH_C")return mock({errors:[{code:"ACCESS_DENIED"}]},404);
    if(sku==="SYNTH_D")return mock({errors:[{code:"THROTTLED"}]},429);
    if(sku==="SYNTH_E")return mock({sku:"WRONG_SKU",summaries:[]});
    if(sku==="SYNTH_F")return mock({sku,summaries:[{
      marketplaceId:"A13V1IB3VIYZZH",asin:"B0TEST0002"
    }]});
    if(sku==="SYNTH_G")return new Response("<html>not found</html>",{
      status:404,headers:{"content-type":"text/html","x-amzn-requestid":"request-2"}});
    if(sku==="SYNTH_H")throw new Error("synthetic_network_failure");
    throw new Error("unexpected sku");
  };
  const scan=await readAmazonSellerListingsDirect({
    marketplace:"IT",
    skus:["SYNTH_A","SYNTH_B","SYNTH_C","SYNTH_D","SYNTH_E","SYNTH_F","SYNTH_G","SYNTH_H"]
  },env);
  assert.equal(scan.ok,true);
  assert.equal(scan.source,"amazon_sp_api_get_listings_item");
  assert.equal(scan.report_download_dependency,false);
  assert.equal(scan.present,2);
  assert.equal(scan.verified_absent,1);
  assert.equal(scan.unknown,5);
  assert.equal(scan.complete_evidence,false);
  assert.equal(scan.has_created_or_updated_offer,false);
  assert.equal(scan.results[0].state,"PRESENT");
  assert.equal(scan.results[0].asin,"B0TEST0001");
  assert.deepEqual(scan.results[0].statuses,["BUYABLE"]);
  assert.equal(scan.results[1].state,"VERIFIED_ABSENT");
  assert.equal(scan.results[2].state,"UNKNOWN");
  assert.equal(scan.results[3].reason,"amazon_http_429");
  assert.equal(scan.results[4].reason,"listing_response_sku_or_json_mismatch");
  assert.equal(scan.results[5].state,"PRESENT_ATTRIBUTES_UNKNOWN");
  assert.equal(scan.results[6].reason,"ambiguous_404_not_absence_proof");
  assert.equal(scan.results[7].reason,"amazon_network_or_timeout");
  assert.equal(httpCalls.length,8);
  const before=httpCalls.length;
  for(const invalid of [
    {marketplace:"US",skus:["SYNTH_A"]},
    {marketplace:"IT",skus:[]},
    {marketplace:"IT",skus:["SYNTH_A","SYNTH_A"]},
    {marketplace:"IT",skus:["SYNTH_A"],operation:"publish"},
    {marketplace:"IT",skus:["SYNTH_A\nBAD"]},
    {marketplace:"IT",skus:Array(9).fill("A")}
  ])await assert.rejects(()=>readAmazonSellerListingsDirect(invalid,env));
  assert.equal(httpCalls.length,before);
  const noSeller=await readAmazonSellerListingsDirect({marketplace:"IT",skus:["SYNTH_A"]},
    {...env,AMAZON_SP_API_SELLER_ID:""});
  assert.equal(noSeller.status,"BLOCKED_SELLER_CONFIG");
  assert.equal(httpCalls.length,before);
  console.log("PASS direct seller Listings GET: verified absence requires typed 404+request ID, partial and throttle UNKNOWN, no report and no writes");
}finally{globalThis.fetch=original}
