import assert from "node:assert/strict";
import { build } from "esbuild";

const b=await build({entryPoints:["src/mare-business-amazon-details.ts"],
  bundle:true,write:false,platform:"neutral",format:"esm",logLevel:"silent"});
const { readAmazonCatalogASINDetails }=await import(
  "data:text/javascript;base64,"+Buffer.from(b.outputFiles[0].text).toString("base64"));
const asin="B000000001";
const creds={AMAZON_SP_API_CLIENT_ID:"test-client",
  AMAZON_SP_API_CLIENT_SECRET:"test-secret",
  AMAZON_SP_API_REFRESH_TOKEN:"test-refresh"};
const oldFetch=globalThis.fetch;let calls=0;
try {
  globalThis.fetch=async(input,init)=>{
    calls++;
    const url=new URL(String(input));
    if(url.pathname==="/auth/o2/token"){
      assert.equal(init.method,"POST");
      return new Response(JSON.stringify({access_token:"mock-access"}),{status:200});
    }
    assert.equal(init.method,"GET");
    assert.equal(init.headers["x-amz-access-token"],"mock-access");
    assert.equal(url.pathname,"/catalog/2022-04-01/items/"+asin);
    assert.equal(url.searchParams.get("marketplaceIds"),"APJ6JRA9NG5V4");
    assert(url.searchParams.get("includedData").includes("summaries"));
    return new Response(JSON.stringify({
      asin, summaries:[{marketplaceId:"APJ6JRA9NG5V4",
        brand:"Demo Brand",itemName:"Demo Mini Bag Black",
        manufacturer:"Brand Co",modelNumber:"MODEL-1",
        itemClassification:"BASE_PRODUCT"}],
      productTypes:[{marketplaceId:"APJ6JRA9NG5V4",productType:"HANDBAG"}],
      images:[{marketplaceId:"APJ6JRA9NG5V4",images:[{link:"https://images.example.com/1.jpg"}]}],
      attributes:{color:[{value:"Black"}],size:[{value:"One Size"}]}
    }),{status:200});
  };
  const out=await readAmazonCatalogASINDetails({marketplace:"IT",asins:[asin]},creds);
  assert.equal(out.ok,true);
  assert.equal(out.no_listing_writes,true);
  assert.equal(out.has_created_offer,false);
  assert.equal(out.results[0].asin,asin);
  assert.equal(out.results[0].brand,"Demo Brand");
  assert.equal(out.results[0].item_name,"Demo Mini Bag Black");
  assert.deepEqual(out.results[0].product_types,["HANDBAG"]);
  assert.equal(out.results[0].color,"Black");
  assert.equal(out.results[0].size,"One Size");
  assert.equal(out.results[0].images_available,1);
  assert(!JSON.stringify(out).includes("mock-access"));
  assert(!JSON.stringify(out).includes("test-secret"));
  const previous=calls;
  for(const bad of [
    {marketplace:"US",asins:[asin]},
    {marketplace:"IT",asins:["INVALID"]},
    {marketplace:"IT",asins:[asin,asin]},
    {marketplace:"IT",asins:[]},
    {marketplace:"IT",asins:Array(4).fill(asin)}
  ])await assert.rejects(()=>readAmazonCatalogASINDetails(bad,creds));
  assert.equal(calls,previous,"Invalid inputs must never call Amazon");
  // Real Amazon rate limiting is a transient state, not catalog absence.
  // Retry after 0 seconds requires no waiting in the synthetic test.
  const normalCatalogResponder=globalThis.fetch;
  let transientGetCount=0;
  globalThis.fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname;
    if(path==="/catalog/2022-04-01/items/"+asin && transientGetCount++===0)
      return new Response(JSON.stringify({message:"Throttled"}),{
        status:429,headers:{"retry-after":"0","content-type":"application/json"}});
    return normalCatalogResponder(input,init);
  };
  const recovered=await readAmazonCatalogASINDetails({marketplace:"IT",asins:[asin]},creds);
  assert.equal(transientGetCount,2,"Exactly one bounded 429 retry");
  assert.equal(recovered.results[0].state,"READ_ONLY_DETAILS_COMPLETE");
  assert.equal(recovered.has_created_offer,false);

  // A long Retry-After cannot be ignored to hammer Amazon.
  let delayedGetCount=0;
  globalThis.fetch=async(input,init)=>{
    if(new URL(String(input)).pathname==="/catalog/2022-04-01/items/"+asin){
      delayedGetCount++;
      return new Response(JSON.stringify({message:"slow down"}),{
        status:429,headers:{"retry-after":"30"}});
    }
    return normalCatalogResponder(input,init);
  };
  await assert.rejects(()=>readAmazonCatalogASINDetails({marketplace:"IT",asins:[asin]},creds),
    /amazon_catalog_details_http_429/);
  assert.equal(delayedGetCount,1,"Do not retry if Amazon requests a long delay");

  let repeatedGetCount=0;
  globalThis.fetch=async(input,init)=>{
    if(new URL(String(input)).pathname==="/catalog/2022-04-01/items/"+asin){
      repeatedGetCount++;
      return new Response(JSON.stringify({message:"Throttled"}),{
        status:429,headers:{"retry-after":"0"}});
    }
    return normalCatalogResponder(input,init);
  };
  await assert.rejects(()=>readAmazonCatalogASINDetails({marketplace:"IT",asins:[asin]},creds),
    /amazon_catalog_details_http_429/);
  assert.equal(repeatedGetCount,3,"Bound Amazon requests to three attempts per ASIN");
  globalThis.fetch=normalCatalogResponder;
  console.log("Merchant-only Amazon ASIN attributes read-only validation passed");
} finally {globalThis.fetch=oldFetch;}
