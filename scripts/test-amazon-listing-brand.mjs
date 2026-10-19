import assert from "node:assert/strict";
import { build } from "esbuild";
const result=await build({entryPoints:["src/marketplace-amazon-listing-brand.ts"],
  bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
const {resolveAmazonListingBrand:resolve}=await import(
  "data:text/javascript;base64,"+Buffer.from(result.outputFiles[0].text).toString("base64"));
for(const vendor of ["Back70","BACK70","back70"]){
  const x=resolve(vendor);
  assert.equal(x.amazon_brand,"Back 70 Streetwear");
  assert.equal(x.shopify_vendor,vendor,"Shopify vendor must not be mutated");
  assert.equal(x.source,"MERCHANT_CONFIRMED_MAPPING");
  assert.equal(x.requires_amazon_brand_eligibility_check,true);
  assert.equal(x.listing_write_authorized,false);
}
assert.equal(resolve("County Of Milan").amazon_brand,"County Of Milan");
assert.equal(resolve("Pro-Keds").amazon_brand,"Pro-Keds");
assert.equal(resolve("Pro-Keds").source,"SHOPIFY_VENDOR_UNVERIFIED");
assert.equal(resolve("Back 70 Streetwear").source,"SHOPIFY_VENDOR_UNVERIFIED",
  "Do not broaden alias patterns implicitly");
for(const x of ["",null,{},[]," Back70","Back70 ","Back70\n","x".repeat(101)])
  assert.equal(resolve(x),null);
console.log("Amazon merchant-confirmed brand mapping safety tests passed.");
