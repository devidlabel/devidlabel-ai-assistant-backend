import assert from "node:assert/strict";
import {build} from "esbuild";
const b=await build({entryPoints:["src/mare-business-amazon-seller-asin.ts"],
 bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
const {readAmazonSellerAsinListings}=await import(
 "data:text/javascript;base64,"+
 Buffer.from(b.outputFiles[0].text).toString("base64"));
const env={
 AMAZON_SP_API_CLIENT_ID:"synthetic-client",
 AMAZON_SP_API_CLIENT_SECRET:"synthetic-secret",
 AMAZON_SP_API_REFRESH_TOKEN:"synthetic-refresh",
 AMAZON_SP_API_SELLER_ID:"A123456789"
};
const asins=["B0TEST0001","B0TEST0002","B0TEST0003","B0TEST0004"];
const a=asin=>({sku:"EXISTING_OTHER_SKU",summaries:[{
 marketplaceId:"APJ6JRA9NG5V4",asin
}]});
const response=(body,status=200)=>new Response(JSON.stringify(body),{
 status,headers:{"content-type":"application/json"}
});
const original=globalThis.fetch;
let getCalls=[];
try{
 globalThis.fetch=async(url,opts={})=>{
  const u=new URL(String(url));
  if(u.host==="api.amazon.com")return response({access_token:"test-lwa-token"});
  assert.equal(opts.method,"GET");
  assert.equal(u.host,"sellingpartnerapi-eu.amazon.com");
  assert.equal(u.pathname,"/listings/2021-08-01/items/A123456789");
  assert.equal(u.searchParams.get("marketplaceIds"),"APJ6JRA9NG5V4");
  assert.equal(u.searchParams.get("identifiersType"),"ASIN");
  assert.equal(u.searchParams.get("includedData"),"summaries");
  assert.equal(u.searchParams.get("pageSize"),"20");
  assert.equal(opts.headers["x-amz-access-token"],"test-lwa-token");
  const asin=u.searchParams.get("identifiers"),token=u.searchParams.get("pageToken");
  getCalls.push([asin,token]);
  if(asin===asins[0])return response({numberOfResults:1,items:[a(asin)]});
  if(asin===asins[1])return response({numberOfResults:0,items:[]});
  if(asin===asins[2]){
    if(token==="second")return response({
      numberOfResults:2,items:[{...a(asin),sku:"ANOTHER_LEGACY_SKU"}]});
    assert.equal(token,null);
    return response({numberOfResults:2,items:[a(asin)],
      pagination:{nextToken:"second"}});
  }
  if(asin===asins[3])return response({numberOfResults:1,items:[{
    sku:"WRONG_ASIN_MATCH",summaries:[{
     marketplaceId:"APJ6JRA9NG5V4",asin:"B0WRONG001"
    }]
  }]});
  if(asin==="B0ERROR001")return response({errors:[{code:"THROTTLED"}]},429);
  if(asin==="B0ERROR002")return response({numberOfResults:2,items:[]});
  if(asin==="B0ERROR003")return response({numberOfResults:1,items:[a(asin)],
    pagination:{nextToken:"same"}});
  throw new Error("unexpected "+asin);
 };
 const x=await readAmazonSellerAsinListings({marketplace:"IT",asins},env);
 assert.equal(x.ok,true);
 assert.equal(x.read_only,true);
 assert.equal(x.seller_listings_found_count,2);
 assert.equal(x.search_empty_count,1);
 assert.equal(x.unknown_count,1);
 assert.equal(x.complete_evidence,false);
 assert.equal(x.results[0].state,"SELLER_ASIN_LISTING_FOUND");
 assert.deepEqual(x.results[0].skus,["EXISTING_OTHER_SKU"]);
 assert.equal(x.results[1].state,"NO_SELLER_ASIN_IN_BOUNDED_SEARCH");
 assert.equal(x.results[2].pages_read,2);
 assert.equal(x.results[2].skus.length,2);
 assert.equal(x.results[3].state,"UNKNOWN");
 assert.equal(x.can_create_offer,false);
 assert.equal(x.no_provider_writes,true);
 assert.equal(x.exact_seller_sku_must_still_be_checked,true);
 assert.equal(getCalls.length,5);
 const error=await readAmazonSellerAsinListings({
  marketplace:"IT",asins:["B0ERROR001","B0ERROR002","B0ERROR003"]
 },env);
 assert.equal(error.unknown_count,3);
 assert.equal(error.results[0].reason,"seller_asin_http_429");
 assert.equal(error.results[1].reason,"seller_asin_empty_with_nonzero_count");
 assert.equal(error.results[2].reason,"seller_asin_invalid_cursor");
 assert.equal(error.can_create_offer,false);
 const before=getCalls.length;
 for(const bad of [
  {marketplace:"US",asins:[asins[0]]},
  {marketplace:"IT",asins:[]},
  {marketplace:"IT",asins:[asins[0],asins[0]]},
  {marketplace:"IT",asins:[asins[0]],mode:"LIVE"},
  {marketplace:"IT",asins:Array(5).fill(asins[0])},
  {marketplace:"IT",asins:["invalid"]}
 ])await assert.rejects(()=>readAmazonSellerAsinListings(bad,env),/invalid_request/);
 assert.equal(before,getCalls.length);
 const config=await readAmazonSellerAsinListings(
  {marketplace:"IT",asins:[asins[0]]},
  {...env,AMAZON_SP_API_SELLER_ID:""});
 assert.equal(config.status,"BLOCKED_SELLER_ID_CONFIG");
 assert.equal(before,getCalls.length);
 console.log("PASS seller ASIN collision scan read-only; detects legacy different SKU, bounded pages, unknown outcomes and no publication");
}finally{
 globalThis.fetch=original;
}
