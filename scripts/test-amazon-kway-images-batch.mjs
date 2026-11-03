import assert from "node:assert/strict";
import {build} from "esbuild";
const compiled=await build({
 entryPoints:["src/mare-business-amazon-kway-images-batch.ts"],
 bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"
});
const {patchKwayRoulandImagesBatch:run}=await import("data:text/javascript;base64,"+
 Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const sku="KWAY_K6131ZW_USY_S",asin="B0HQ4XP9NZ";
const env={AMAZON_SP_API_SELLER_ID:"A1234567891234",AMAZON_OFFER_PREVIEW_ENABLED:"true"};
let calls=[];
const shopifyVariant=(status,id,url)=>({id:"gid://shopify/ProductVariant/54714280739157",sku,
 product:{id,title:"Giacca Le Vrai 4.0 Rouland Warm Black Pure",vendor:"K-Way",status,
  media:{nodes:[{mediaContentType:"IMAGE",image:{url,width:1200,height:1542}}]}}});
const photo="https://cdn.shopify.com/s/files/1/1014/1545/3013/files/devidlabel-gilet-k-way-nero.png?v=1788612116";
const deps={
 sellerReader:async()=>({ok:true,marketplace:"IT",results:[{sku,asin,
  state:"PRESENT",product_type:"COAT",identity_state:"VERIFIED",
  current_fbm_quantity:0,statuses:[],
  issue_signals:[{code:"18320",severity:"ERROR"}]}]}),
 shopifyReader:async()=>({productVariants:{pageInfo:{hasNextPage:false},nodes:[
  shopifyVariant("UNLISTED","gid://shopify/Product/10426195050837",photo),
  shopifyVariant("ACTIVE","gid://shopify/Product/11523512729941",photo)
 ]}}),
 token:async()=> "testtoken",
 fetch:async(url,init)=>{
  assert.equal(init.method,"PATCH");
  const payload=JSON.parse(init.body);
  assert.equal(payload.productType,"COAT");
  assert.equal(payload.patches.length,1);
  assert.equal(payload.patches[0].path,"/attributes/main_product_image_locator");
  assert.equal(payload.patches[0].value[0].media_location,photo);
  assert(!init.body.includes("fulfillment_availability"));
  assert(!init.body.includes("purchasable_offer"));
  assert(!init.body.includes("gpsr"));
  calls.push(new URL(url).searchParams.get("mode"));
  return new Response(JSON.stringify({sku,status:new URL(url).searchParams.has("mode")?"VALID":"ACCEPTED",
   issues:[],submissionId:"mock-kway-media"}),{status:200,
   headers:{"content-type":"application/json"}});
 }
};
const result=await run({marketplace:"IT",items:[{sku,asin}]},env,deps);
assert.equal(result.ok,true);assert.equal(result.live_submissions,1);
assert.deepEqual(calls,["VALIDATION_PREVIEW",null]);
assert.equal(result.image_verified,false);assert.equal(result.buyable_verified,false);
assert.equal(result.stock_unchanged,true);assert.equal(result.price_unchanged,true);
for(const items of [
 [{sku,asin},{sku,asin}],
 [{sku,asin:"B000000001"}],
 [{sku:"KWAY_K6131ZW_USY_XXXL",asin}],
 ])await assert.rejects(()=>run({marketplace:"IT",items},env,deps));
const unchanged=await run({marketplace:"IT",items:[{sku,asin}]},env,{
 ...deps,shopifyReader:async()=>({productVariants:{pageInfo:{hasNextPage:false},nodes:[
 shopifyVariant("ACTIVE","gid://shopify/Product/11523512729941",photo),
 shopifyVariant("ACTIVE","gid://shopify/Product/11523512729941",photo)]}})
});
assert.equal(unchanged.live_submissions,0);
const noImage=await run({marketplace:"IT",items:[{sku,asin}]},env,{
 ...deps,shopifyReader:async()=>({productVariants:{pageInfo:{hasNextPage:true},nodes:[]}})
});
assert.equal(noImage.live_submissions,0);
const stockChanged=await run({marketplace:"IT",items:[{sku,asin}]},env,{
 ...deps,sellerReader:async()=>({...await deps.sellerReader(),results:[{
  ...(await deps.sellerReader()).results[0],current_fbm_quantity:1
 }]})
});
assert.equal(stockChanged.live_submissions,0);
assert.deepEqual(calls,["VALIDATION_PREVIEW",null]);
console.log("PASS: exact K-Way Rouland images five-ASIN allowlist, legacy duplicate guard, media-only preview and no stock/price writes");
