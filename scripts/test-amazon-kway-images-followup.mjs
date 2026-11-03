import assert from "node:assert/strict";
import {build} from "esbuild";
const compiled=await build({entryPoints:["src/mare-business-amazon-kway-images-followup.ts"],
 bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {patchKwayFollowupImagesBatch:run}=await import("data:text/javascript;base64,"+
 Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const sku="KWAY_K21515W_228_S",asin="B0HQ3YVZ1B",productId="gid://shopify/Product/11523509420373";
const env={AMAZON_SP_API_SELLER_ID:"A1234567891234",AMAZON_OFFER_PREVIEW_ENABLED:"true"};
let calls=[];
const image="https://cdn.shopify.com/s/files/1/1014/1545/3013/files/ChatGPTImage10ago2026_17_45_59.png?v=1788610000";
const node=(status,id)=>({id:"gid://shopify/ProductVariant/54714280739157",sku,
 product:{id,title:"Giacca Le Vrai Claude Orsetto Green DK Jungle",vendor:"K-Way",status,
 media:{nodes:[{mediaContentType:"IMAGE",image:{url:image,width:1200,height:1542}}]}}});
const deps={
 sellerReader:async()=>({ok:true,marketplace:"IT",results:[{sku,asin,
  state:"PRESENT",product_type:"COAT",identity_state:"VERIFIED",
  current_fbm_quantity:0,statuses:[],issue_signals:[{code:"18320",severity:"ERROR"}]}]}),
 shopifyReader:async()=>({productVariants:{pageInfo:{hasNextPage:false},nodes:[
  node("UNLISTED","gid://shopify/Product/10426195050837"),node("ACTIVE",productId)]}}),
 token:async()=> "testtoken",
 fetch:async(url,init)=>{
  const payload=JSON.parse(init.body);
  assert.equal(payload.productType,"COAT");
  assert.deepEqual(payload.patches.map(p=>p.path),["/attributes/main_product_image_locator"]);
  assert.equal(payload.patches[0].value[0].media_location,image);
  for(const forbidden of ["fulfillment_availability","purchasable_offer","gpsr_safety_attestation","dsa_responsible_party_address"])
   assert(!init.body.includes(forbidden));
  calls.push(new URL(url).searchParams.get("mode"));
  return new Response(JSON.stringify({sku,status:new URL(url).searchParams.has("mode")?"VALID":"ACCEPTED",
   issues:[],submissionId:"mock-kway-media"}),{status:200,headers:{"content-type":"application/json"}});
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
 [{sku:"KWAY_K6131ZW_USY_S",asin:"B0HQ4XP9NZ"}],
 ])await assert.rejects(()=>run({marketplace:"IT",items},env,deps));
for(const invalid of [
 {shopifyReader:async()=>({productVariants:{pageInfo:{hasNextPage:false},nodes:[node("ACTIVE",productId),node("ACTIVE",productId)]}})},
 {shopifyReader:async()=>({productVariants:{pageInfo:{hasNextPage:true},nodes:[]}})},
 {shopifyReader:async()=>({productVariants:{pageInfo:{hasNextPage:false},nodes:[node("ACTIVE","gid://shopify/Product/9999999999")]}})},
 {sellerReader:async()=>({...await deps.sellerReader(),results:[{...(await deps.sellerReader()).results[0],current_fbm_quantity:1}]})},
 ]){const blocked=await run({marketplace:"IT",items:[{sku,asin}]},env,{...deps,...invalid});
 assert.equal(blocked.live_submissions,0);}
assert.deepEqual(calls,["VALIDATION_PREVIEW",null]);
console.log("PASS exact K-Way 15 media followup with product ASIN type and zero-stock guards");
