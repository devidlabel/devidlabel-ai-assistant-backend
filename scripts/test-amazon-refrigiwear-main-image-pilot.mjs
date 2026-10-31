import assert from "node:assert/strict";
import {build} from "esbuild";
const compiled=await build({
 entryPoints:["src/mare-business-amazon-refrigiwear-main-image-pilot.ts"],
 bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent",
});
const {patchRefrigiwearMainImagePilot:run}=await import(
 "data:text/javascript;base64,"+Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const SKU="RFR_W53800_NY2303_E06107_S",ASIN="B0HPY8J51M";
const input={marketplace:"IT",sku:SKU,asin:ASIN};
const env={AMAZON_SP_API_SELLER_ID:"A1234567891234",AMAZON_OFFER_PREVIEW_ENABLED:"true"};
const imageUrl="https://cdn.shopify.com/s/files/1/1014/1545/3013/files/refrigiwear-braffy-jacket-green-lily-rfr-w53800-ny2303-e06107-foto-01.jpg?v=1787832051";
const listing=()=>({ok:true,marketplace:"IT",results:[{
 sku:SKU,state:"PRESENT",asin:ASIN,product_type:"COAT",identity_state:"VERIFIED",
 statuses:[],issue_signals:[{code:"18320",severity:"ERROR"}],
}]});
const source=()=>({productVariant:{id:"gid://shopify/ProductVariant/52554538123605",
 sku:SKU,product:{
 id:"gid://shopify/Product/10426204815701",title:"Braffy Jacket Green Lily",
 vendor:"Refrigiwear",status:"ACTIVE",media:{nodes:[{
 mediaContentType:"IMAGE",image:{url:imageUrl,width:1716,height:2206},
 }]},
}}});
const seen=[];
const deps={
 sellerReader:async()=>listing(),
 shopifyReader:async(_env,query,variables)=>{
  assert.equal(variables.id,"gid://shopify/ProductVariant/52554538123605");
  assert.ok(query.includes("media(first:1)"));return source();},
 token:async()=>"token",
 fetch:async(url,init)=>{
  const u=new URL(url);assert.equal(init.method,"PATCH");
  assert.equal(u.searchParams.get("marketplaceIds"),"APJ6JRA9NG5V4");
  assert.ok(u.pathname.endsWith("/"+SKU));
  const body=JSON.parse(init.body);
  assert.equal(body.productType,"COAT");
  assert.equal(body.patches.length,1);
  assert.equal(body.patches[0].path,"/attributes/main_product_image_locator");
  assert.deepEqual(body.patches[0].value,[{media_location:imageUrl,
   marketplace_id:"APJ6JRA9NG5V4"}]);
  assert.equal(JSON.stringify(body).includes("purchasable_offer"),false);
  assert.equal(JSON.stringify(body).includes("fulfillment_availability"),false);
  const preview=u.searchParams.get("mode")==="VALIDATION_PREVIEW";
  seen.push(preview?"preview":"live");
  return new Response(JSON.stringify({sku:SKU,status:preview?"VALID":"ACCEPTED",
    submissionId:preview?"preview":"image-submission-01",issues:[]}),
    {status:200,headers:{"content-type":"application/json"}});
 }
};
const accepted=await run(input,env,deps);
assert.equal(accepted.ok,true);
assert.equal(accepted.image_verified,false);
assert.equal(accepted.price_unchanged,true);
assert.equal(accepted.stock_unchanged,true);
assert.equal(accepted.submission_reference,"image-submission-01");
assert.deepEqual(seen,["preview","live"]);
const blocked=await run(input,env,{...deps,
 sellerReader:async()=>({...listing(),results:[{...listing().results[0],issue_signals:[]}]})});
assert.equal(blocked.status,"BLOCKED_REFRIGIWEAR_IMAGE_ONLY");
assert.deepEqual(seen,["preview","live"]);
const unverifiedSource=await run(input,env,{...deps,
 shopifyReader:async()=>{const s=source();s.productVariant.product.media.nodes[0].image.url="https://example.org/test.jpg";return s;}});
assert.equal(unverifiedSource.status,"BLOCKED_REFRIGIWEAR_IMAGE_ONLY");
assert.deepEqual(seen,["preview","live"]);
const invalidPreview=await run(input,env,{...deps,
 fetch:async()=>new Response(JSON.stringify({sku:SKU,status:"INVALID",
   issues:[{severity:"ERROR",code:"18320"}]}),
   {status:200,headers:{"content-type":"application/json"}})});
assert.equal(invalidPreview.provider_write_attempted,false);
await assert.rejects(()=>run({...input,asin:"B000000000"},env,deps));
console.log("PASS Refrigiwear main image canary guards price and stock");
