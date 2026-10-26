import assert from "node:assert/strict";
import { build } from "esbuild";
const compiled=await build({
  entryPoints:["src/mare-business-amazon-first-asin-media-price-pilot.ts"],
  bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"
});
const {patchFirstAmazonAsinImagePrice:run}=await import(
  "data:text/javascript;base64,"+
  Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const request={marketplace:"IT",sku:"4B12_PLAYNEW_D2045_39_EU",asin:"B0HPBKM8SL"};
const env={AMAZON_SP_API_SELLER_ID:"A123456789",
  AMAZON_OFFER_PREVIEW_ENABLED:"true"};
const image="https://cdn.shopify.com/s/files/1/1014/1545/3013/files/4b12-playnew-d-2045-white-bronze-4b12-playnew-d2045-foto-01.jpg?v=1787834364";
function fixture(options={}){
  const calls=[];let sellerReads=0;
  const seller=async(q)=>{
    calls.push("seller");sellerReads++;
    assert.deepEqual(q,{marketplace:"IT",skus:[request.sku]});
    return {ok:true,marketplace:"IT",results:[{
      sku:request.sku,state:"PRESENT",
      asin:options.sellerAsin??request.asin,product_type:"SHOES",
      identity_state:"VERIFIED",statuses:["DISCOVERABLE"],
      issue_signals:[],price_state:"UNKNOWN",reported_offer_count:0
    }]};
  };
  const shopify=async(_env,_query,vars)=>{
    calls.push("shopify");
    assert.equal(vars.id,"gid://shopify/ProductVariant/54713971048789");
    return {productVariant:{
      id:vars.id,sku:request.sku,
      inventoryQuantity:3,
      price:options.price??"179.10",compareAtPrice:"199.00",
      product:{
        id:"gid://shopify/Product/11523332047189",
        title:"PlayNew D-2045 White/Bronze",
        vendor:"4B12",status:"ACTIVE",productType:"Sneakers",
        media:{nodes:[{mediaContentType:"IMAGE",image:{
          url:options.image??image,width:600,height:771
        }}]}
      }
    }};
  };
  const fetchMock=async(url,init)=>{
    const u=new URL(url);
    assert.equal(u.origin,"https://sellingpartnerapi-eu.amazon.com");
    assert.equal(u.pathname,
      "/listings/2021-08-01/items/A123456789/4B12_PLAYNEW_D2045_39_EU");
    assert.equal(u.searchParams.get("marketplaceIds"),"APJ6JRA9NG5V4");
    assert.equal(init.method,"PATCH");
    assert.equal(init.headers["x-amz-access-token"],"mock-access");
    const p=JSON.parse(init.body);
    assert.equal(p.productType,"SHOES");
    assert.equal(p.patches.length,2);
    assert.deepEqual(p.patches.map(x=>x.path),[
      "/attributes/main_product_image_locator",
      "/attributes/purchasable_offer"
    ]);
    assert.equal(p.patches[0].value[0].media_location,image);
    assert.equal(p.patches[1].value[0].our_price[0].schedule[0].value_with_tax,179.1);
    assert.equal(JSON.stringify(p).includes("fulfillment_availability"),false);
    if(u.searchParams.has("mode")){
      calls.push("PREVIEW_PATCH");
      assert.equal(u.searchParams.get("mode"),"VALIDATION_PREVIEW");
      return new Response(JSON.stringify({
        sku:request.sku,status:options.invalidPreview?"INVALID":"VALID",
        issues:options.invalidPreview?[{code:"90004100",severity:"ERROR"}]:[]
      }),{status:200,headers:{"content-type":"application/json"}});
    }
    calls.push("LIVE_PATCH");
    return new Response(JSON.stringify({
      sku:request.sku,status:options.invalidLive?"INVALID":"ACCEPTED",
      submissionId:"photo-price-test-001",
      issues:options.invalidLive?[{code:"90220",severity:"ERROR"}]:[]
    }),{status:200,headers:{"content-type":"application/json"}});
  };
  return {calls,run:()=>run(request,env,{sellerReader:seller,
    shopifyReader:shopify,token:async()=>"mock-access",fetch:fetchMock})};
}
let count=0;
async function test(fn){await fn();count++;}
await test(async()=>{
  const a=fixture(),r=await a.run();
  assert.equal(r.ok,true);assert.equal(r.status,
    "IMAGE_AND_PRICE_PATCH_SUBMITTED_AWAITING_READBACK");
  assert.equal(r.submission_reference,"photo-price-test-001");
  assert.equal(r.submitted_price_eur,179.10);
  assert.equal(r.buyable_verified,false);
  assert.equal(r.inventory_mutated,false);
  assert.deepEqual(a.calls,[
    "seller","shopify","PREVIEW_PATCH","seller","LIVE_PATCH"
  ]);
});
await test(async()=>{
  const a=fixture({invalidPreview:true}),r=await a.run();
  assert.equal(r.ok,false);
  assert.equal(r.provider_write_attempted,false);
  assert.equal(a.calls.includes("LIVE_PATCH"),false);
});
await test(async()=>{
  const a=fixture({invalidLive:true}),r=await a.run();
  assert.equal(r.ok,false);
  assert.equal(r.status,"PATCH_REJECTED_OR_UNKNOWN");
  assert.equal(r.buyable_verified,false);
});
await test(async()=>{
  const a=fixture({sellerAsin:"B000000000"}),r=await a.run();
  assert.equal(r.reason,"seller_or_offer_state_changed");
  assert.deepEqual(a.calls,["seller"]);
});
await test(async()=>{
  const a=fixture({price:"188.10"}),r=await a.run();
  assert.equal(r.reason,"shopify_image_price_identity_unverified");
  assert.equal(a.calls.includes("PREVIEW_PATCH"),false);
});
await test(async()=>{
  const a=fixture({image:"https://attacker.example.com/evil.jpg"}),r=await a.run();
  assert.equal(r.reason,"shopify_image_price_identity_unverified");
  assert.equal(a.calls.includes("PREVIEW_PATCH"),false);
});
await test(async()=>{
  const a=fixture();
  await assert.rejects(run({...request,quantity:100},env,{}),
    /image_price_pilot_invalid_input/);
  assert.equal(a.calls.length,0);
});
console.log(JSON.stringify({ok:true,tests:count,live_sp_api_calls:0,
  mock_only:true,inventory_never_written:true}));
