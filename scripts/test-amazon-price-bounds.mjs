import assert from "node:assert/strict";
import { build } from "esbuild";
const b=await build({entryPoints:["src/mare-business-amazon-price-bounds.ts"],
 bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {readAmazonEuPriceBounds:read}=await import(
 "data:text/javascript;base64,"+Buffer.from(b.outputFiles[0].text).toString("base64"));
const sku="MC2_JUDE002 00311E_Taglia unica", market="APJ6JRA9NG5V4";
const env={AMAZON_SP_API_SELLER_ID:"A1234567891234"};
let count=0;
const data={sku,summaries:[{asin:"B0GW7X2HLH",marketplaceId:market}],
 attributes:{purchasable_offer:[{marketplace_id:market,audience:"ALL",currency:"EUR",
 our_price:[{schedule:[{value_with_tax:97.9}]}],
 maximum_seller_allowed_price:[{schedule:[{value_with_tax:89.00}]}],
 minimum_seller_allowed_price:[{schedule:[{value_with_tax:50.00}]}]}]},
 issues:[{code:"19038",message:"PRIVATE CONTACT user@example.com"}, {code:"100632",message:"PRIVATE"}]};
const deps={auth:async()=>"FAKE-TOKEN",fetch:async(url,opts)=>{
 count++;assert.equal(opts.method,"GET");const parsed=new URL(url);
 assert.equal(parsed.searchParams.get("includedData"),"summaries,attributes,issues,offers");
 assert.equal(parsed.searchParams.get("marketplaceIds"),market);
 return new Response(JSON.stringify(data),{status:200,headers:{"content-type":"application/json"}});
}};
const r=await read({marketplace:"IT",skus:[sku]},env,deps);
assert.equal(r.ok,true);assert.equal(r.results[0].seller_price_eur,97.9);
assert.equal(r.results[0].maximum_seller_allowed_price_eur,89);
assert.equal(r.results[0].minimum_seller_allowed_price_eur,50);
assert.equal(r.results[0].observed_price_above_max,true);
assert.equal(r.results[0].explicit_19038,true);
assert.deepEqual(r.results[0].pricing_issue_codes,["19038"]);
assert.equal(r.provider_mutations,0);assert.equal(r.price_changed,false);
assert.equal(count,1);
assert(!JSON.stringify(r).includes("user@example.com"));
for(const bad of [{marketplace:"XX",skus:[sku]},{marketplace:"IT",skus:[sku,sku]},
 {marketplace:"IT",skus:[]},{marketplace:"IT",skus:[sku],price:90}])
 await assert.rejects(()=>read(bad,env,deps),/amazon_price_bounds_request_invalid/);
const absent=await read({marketplace:"IT",skus:[sku]},env,{...deps,fetch:async()=>new Response("",{status:404})});
assert.equal(absent.results[0].state,"VERIFIED_ABSENT");
const noBounds=await read({marketplace:"IT",skus:[sku]},env,{...deps,fetch:async()=>{
 return new Response(JSON.stringify({...data,attributes:{}}),{status:200,headers:{"content-type":"application/json"}});
}});
assert.equal(noBounds.results[0].price_max_not_observed,true);
assert.equal(noBounds.results[0].observed_price_above_max,false);
const mismatch=await read({marketplace:"IT",skus:[sku]},env,{...deps,fetch:async()=>{
 return new Response(JSON.stringify({...data,summaries:[{asin:"B0GW7X2HLH",marketplaceId:"OTHER"}]}),{status:200,headers:{"content-type":"application/json"}});
}});
assert.equal(mismatch.results[0].state,"IDENTITY_UNVERIFIED");
console.log("Amazon EU price bounds reader: fail-closed read-only PASS");
