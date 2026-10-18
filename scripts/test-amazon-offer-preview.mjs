import assert from "node:assert/strict";
import {build} from "esbuild";

/** All tests offline: no Seller Central or provider modifications. */
const compiled=await build({entryPoints:["src/mare-business-amazon-offer-preview.ts"],
  bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {previewAmazonOfferOnlyZeroQuantity}=await import("data:text/javascript;base64,"+
  Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const input={marketplace:"IT",sku:"SYNTHETIC_001",ean:"2000000001233",asin:"B0TEST0001"};
const env={
  AMAZON_SP_API_CLIENT_ID:"synthetic-client",
  AMAZON_SP_API_CLIENT_SECRET:"synthetic-secret",
  AMAZON_SP_API_REFRESH_TOKEN:"synthetic-refresh",
  AMAZON_SP_API_SELLER_ID:"A123456789",
  AMAZON_OFFER_PREVIEW_ENABLED:"true"
};
const preflight=async()=>({
  ok:true,status:"REVIEW_REQUIRED",
  ...input,exact_ean_asin:true,
  seller_listing_absence_result:"NOT_FOUND_VERIFIED_BY_LISTINGS_API",
  schema_product_type:"PRODUCT",schema_requirements:"LISTING_OFFER_ONLY",
  schema_version:"synthetic-version",schema_checksum:"c3ludGhldGljLXRlc3QxMg==",
  shopify_currency:"EUR",shopify_price_minor:2599
});
let calls=[], amazonStatus="VALID",amazonHttp=200;
const original=globalThis.fetch;
const json=(o,status=200)=>new Response(JSON.stringify(o),{status,
  headers:{"content-type":"application/json"}});
try {
  globalThis.fetch=async(url,init={})=>{
    const u=new URL(String(url));
    calls.push({url:u.toString(),method:init.method,body:init.body,headers:init.headers});
    if(u.hostname==="api.amazon.com"){
      assert.equal(init.method,"POST");
      return json({access_token:"synthetic-token"});
    }
    assert.equal(u.host,"sellingpartnerapi-eu.amazon.com");
    assert.equal(u.pathname,"/listings/2021-08-01/items/A123456789/SYNTHETIC_001");
    assert.equal(init.method,"PUT");
    assert.equal(u.searchParams.get("mode"),"VALIDATION_PREVIEW");
    assert.equal(u.searchParams.get("marketplaceIds"),"APJ6JRA9NG5V4");
    assert.equal(init.headers["x-amz-access-token"],"synthetic-token");
    const payload=JSON.parse(init.body);
    assert.equal(payload.productType,"PRODUCT");
    assert.equal(payload.requirements,"LISTING_OFFER_ONLY");
    assert.equal(payload.attributes.merchant_suggested_asin[0].value,input.asin);
    assert.equal(payload.attributes.fulfillment_availability[0].quantity,0);
    assert.equal(payload.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax,25.99);
    assert.equal(payload.attributes.condition_type[0].value,"new_new");
    if(amazonHttp!==200)return json({errors:[{code:"THROTTLED"}]},amazonHttp);
    return json({sku:input.sku,status:amazonStatus,submissionId:"SYNTHETIC_SUBMISSION",
      issues:amazonStatus==="INVALID"?[{code:"ATTRIBUTE_MISSING",severity:"ERROR"}]:[]});
  };
  const valid=await previewAmazonOfferOnlyZeroQuantity(input,env,preflight);
  assert.equal(valid.ok,true);
  assert.equal(valid.amazon_preview_status,"VALID");
  assert.equal(valid.validation_mode,"VALIDATION_PREVIEW");
  assert.equal(valid.offer_quantity_submitted,0);
  assert.equal(valid.can_publish,false);
  assert.equal(valid.offer_created,false);
  assert.equal(valid.listing_write_enabled,false);
  amazonStatus="INVALID";
  const invalid=await previewAmazonOfferOnlyZeroQuantity(input,env,preflight);
  assert.equal(invalid.status,"PREVIEW_REVIEW_REQUIRED");
  assert.equal(invalid.amazon_preview_status,"INVALID");
  assert.equal(invalid.preview_issues[0].code,"ATTRIBUTE_MISSING");
  const count=calls.length;
  for(const blocked of [
    {input,env:{...env,AMAZON_OFFER_PREVIEW_ENABLED:"false"},preflight},
    {input,env:{...env,AMAZON_SP_API_SELLER_ID:""},preflight},
    {input,env,preflight:async()=>({...await preflight(),status:"BLOCKED_CATALOG_ATTRIBUTES"})},
    {input,env,preflight:async()=>({...await preflight(),shopify_price_minor:0})},
    {input,env,preflight:async()=>({...await preflight(),schema_checksum:"NO"})}
  ]){
    const result=await previewAmazonOfferOnlyZeroQuantity(blocked.input,blocked.env,blocked.preflight);
    assert.equal(result.status,"BLOCKED_PREVIEW");
  }
  assert.equal(calls.length,count,"Blocked preview must not reach Amazon");
  await assert.rejects(()=>previewAmazonOfferOnlyZeroQuantity({
    ...input,quantity:1
  },env,preflight),/amazon_offer_preview_invalid_input/);
  assert.equal(calls.length,count);
  amazonHttp=429;
  await assert.rejects(()=>previewAmazonOfferOnlyZeroQuantity(input,env,preflight),
    /amazon_offer_preview_http_429/);
  console.log("PASS Amazon zero-stock Offer Only VALIDATION_PREVIEW: fixed mode, fail-closed preflight, no live write path");
}finally{globalThis.fetch=original;}
