import assert from "node:assert/strict";
import { build } from "esbuild";
const compiled = await build({ entryPoints: ["src/mare-business-amazon-offer-preflight.ts"], bundle: true, write: false, platform: "neutral", format: "esm", logLevel: "silent" });
const { readAmazonOfferOnlyPreflight } = await import("data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const input={marketplace:"IT",sku:"DL_PC1_OR",ean:"7426885112370",asin:"B07D914KXP"};
const env={AMAZON_SP_API_CLIENT_ID:"fake-id",AMAZON_SP_API_CLIENT_SECRET:"fake-secret",AMAZON_SP_API_REFRESH_TOKEN:"fake-refresh",AMAZON_SP_API_SELLER_ID:"A123456789"};
const shopify=async()=>({ok:true,truncated:false,complete_variant_pagination:true,products:[{vendor:"Devid Label",status:"ACTIVE",variants:[{sku:input.sku,barcode:input.ean,inventory_quantity:2,price:"26.91",inventory_tracked:true,inventory_levels_complete:true}]}]});
const match=async()=>({ok:true,result:{complete:true,identifiers:[{ean:input.ean,state:"EXACT_ONE",asins:[input.asin]}]}});
const details=async()=>({ok:true,results:[{state:"READ_ONLY_DETAILS_COMPLETE",asin:input.asin,brand:"Devid Label"}]});
const original=globalThis.fetch;
let requests=[];
function json(value,status=200){return new Response(JSON.stringify(value),{status});}
try {
 globalThis.fetch=async(url,opts)=>{
   requests.push({url:String(url),method:opts.method});
   if(String(url).includes("/auth/o2/token"))return json({access_token:"fake-token"});
   if(String(url).includes("/listings/2021-08-01/items/"))return json({},404);
   if(String(url).includes("/listings/2021-08-01/restrictions"))return json({restrictions:[]});
   if(String(url).includes("/definitions/2020-09-01/productTypes/PRODUCT"))return json({productType:"PRODUCT",schema:{link:{resource:"some-schema"}},productTypeVersion:"1"});
   throw Error("unexpected call");
 };
 const valid=await readAmazonOfferOnlyPreflight(input,env,shopify,match,details);
 assert.equal(valid.ok,true);
 assert.equal(valid.read_only,true);
 assert.equal(valid.has_created_offer,false);
 assert.equal(valid.status,"CANDIDATE_FOR_VALIDATION_PREVIEW");
 assert(requests.filter(x=>!x.url.includes("/auth/o2/token")).every(x=>x.method==="GET"));
 const current=requests.length;
 await assert.rejects(()=>readAmazonOfferOnlyPreflight({...input,sku:"x\nbad"},env,shopify,match,details));
 assert.equal(requests.length,current);
 const duplicate=await readAmazonOfferOnlyPreflight(input,env,async()=>({...await shopify(),products:[...(await shopify()).products,...(await shopify()).products]}),match,details);
 assert.equal(duplicate.status,"BLOCKED_SHOPIFY_IDENTITY");
 const wrong=await readAmazonOfferOnlyPreflight(input,env,shopify,async()=>({...await match(),result:{complete:true,identifiers:[{ean:input.ean,state:"NO_EXACT_MATCH",asins:[]}]}}),details);
 assert.equal(wrong.status,"BLOCKED_CATALOG_MATCH");
 globalThis.fetch=async(url,opts)=>{requests.push({url:String(url),method:opts.method});if(String(url).includes("/auth/o2/token"))return json({access_token:"fake-token"});return json({sku:input.sku},200);};
 const present=await readAmazonOfferOnlyPreflight(input,env,shopify,match,details);
 assert.equal(present.status,"BLOCKED_EXISTING_OFFER");
 console.log("Amazon Offer Only preflight: fail-closed safety and no-write checks passed");
}finally{globalThis.fetch=original;}
