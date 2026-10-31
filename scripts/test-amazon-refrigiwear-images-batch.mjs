import assert from "node:assert/strict";
import {build} from "esbuild";
const x=await build({entryPoints:["src/mare-business-amazon-refrigiwear-images-batch.ts"],bundle:true,format:"esm",platform:"neutral",write:false});
const mod=await import("data:text/javascript;base64,"+Buffer.from(x.outputFiles[0].text).toString("base64"));
const run=mod.patchRefrigiwearImagesBatch;
const sku="RFR_W53800_NY2303_E06107_M",asin="B0HPYGHFY7";
const env={AMAZON_SP_API_SELLER_ID:"A1234567891234",AMAZON_OFFER_PREVIEW_ENABLED:"true"};
let writes=0;
const dep={
 sellerReader:async()=>({ok:true,marketplace:"IT",results:[{sku,asin,state:"PRESENT",product_type:"COAT",identity_state:"VERIFIED",statuses:[],issue_signals:[{code:"18320",severity:"ERROR"}]}]}),
 shopifyReader:async()=>({productVariants:{pageInfo:{hasNextPage:false},nodes:[{id:"gid://shopify/ProductVariant/52554538123605",sku,product:{id:"gid://shopify/Product/10426204815701",title:"Braffy Jacket Green Lily",vendor:"Refrigiwear",status:"ACTIVE",media:{nodes:[{mediaContentType:"IMAGE",image:{url:"https://cdn.shopify.com/s/files/1/1014/1545/3013/files/refrigiwear-braffy-jacket-green-lily-rfr-w53800-ny2303-e06107-foto-01.jpg?v=1787832051",width:1716,height:2206}}]}}}]}}),
 token:async()=>"mocktoken",
 fetch:async(url,init)=>{
  const body=JSON.parse(init.body);
  assert.equal(init.method,"PATCH");
  assert.equal(body.patches.length,1);
  assert.equal(body.patches[0].path,"/attributes/main_product_image_locator");
  assert.equal(JSON.stringify(body).includes("purchasable_offer"),false);
  assert.equal(JSON.stringify(body).includes("fulfillment_availability"),false);
  writes++;
  return new Response(JSON.stringify({sku,status:new URL(url).searchParams.has("mode")?"VALID":"ACCEPTED",issues:[],submissionId:"test-image-01"}),{status:200,headers:{"content-type":"application/json"}});
 }
};
const result=await run({marketplace:"IT",items:[{sku,asin}]},env,dep);
assert.equal(result.live_submissions,1);
assert.equal(writes,2);
assert.equal(result.stock_unchanged,true);
assert.equal(result.price_unchanged,true);
await assert.rejects(()=>run({marketplace:"IT",items:[{sku,asin},{sku,asin}]},env,dep));
const dup=await run({marketplace:"IT",items:[{sku,asin}]},env,{...dep,shopifyReader:async()=>({productVariants:{pageInfo:{hasNextPage:true},nodes:[]}})});
assert.equal(dup.live_submissions,0);
assert.equal(writes,2);
console.log("PASS media batch avoids price/stock and duplicates");
