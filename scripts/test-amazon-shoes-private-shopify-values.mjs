import assert from "node:assert/strict";
import { build } from "esbuild";

const built=await build({entryPoints:["src/marketplace-amazon-shoes-private-shopify-values.ts"],
  bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
const {readAmazonShoesPrivateShopifyValues:read}=await import(
  "data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));

const expected={
  sku:"BK70_108051-000016_37_EU",
  variantId:"gid://shopify/ProductVariant/54462478319957",
  productTitle:"Sneaker Mohair Leo Camel/Butter",
  shopifyVendor:"Back70",amazonBrand:"Back 70 Streetwear"
};
const source=()=>{
  const values=[["target_gender","Donna"],["color","Camel/Butter"],
    ["model_name","Mohair"],["amazon_brand","Back 70 Streetwear"]];
  return {productVariant:{id:expected.variantId,sku:expected.sku,selectedOptions:[{name:"Numero",value:"37 EU"}],
    product:{id:"gid://shopify/Product/11464876097877",
      title:expected.productTitle,vendor:expected.shopifyVendor,status:"ACTIVE",
      productType:"Sneakers",metafields:{
        nodes:values.map(([key,value])=>({namespace:"amazon_ptd_shoes",
          key,type:"single_line_text_field",value})),
        pageInfo:{hasNextPage:false}}}}};
};
let hits=0;
const queryShopify=async (_env,query,variables)=>{
  hits++;
  assert.match(query,/productVariant\(id:\$variantId\)/);
  assert.match(query,/amazon_ptd_shoes/);
  assert.deepEqual(variables,{variantId:expected.variantId});
  return source();
};
const ok=await read(expected,{}, {queryShopify});
assert.equal(hits,1);
assert.equal(ok.ok,true);
assert.equal(ok.model_name,"Mohair");
assert.equal(ok.color,"Camel/Butter");
assert.equal(ok.eu_footwear_size,"37");
assert.equal(ok.amazon_target_gender,"female");
assert.equal(ok.ready_for_publication,false);
assert.equal(ok.public_storefront_access_used,false);
assert.equal(ok.draft_values_review_only,true);
assert.ok(!JSON.stringify(ok).includes("Donna"));
const wrongBrand=await read({...expected,amazonBrand:"Back70"},{},{queryShopify});
assert.equal(wrongBrand.ok,false);
assert.equal(wrongBrand.reason,"amazon_brand_mapping_unverified");
assert.equal(hits,1,"Fail before reaching Shopify");
const changes=[
 ["shopify_identity_changed",a=>{a.productVariant.product.vendor="Not Back70";}],
 ["shopify_identity_changed",a=>{a.productVariant.sku="OTHER_SKU";}],
 ["shopify_identity_changed",a=>{a.productVariant.product.status="DRAFT";}],
 ["shopify_metafields_incomplete",a=>{a.productVariant.product.metafields.pageInfo.hasNextPage=true;}],
 ["shopify_metafields_unverified",a=>{a.productVariant.product.metafields.nodes.push(a.productVariant.product.metafields.nodes[0]);}],
 ["shopify_metafields_unverified",a=>{a.productVariant.product.metafields.nodes[0].namespace="storefront";}],
 ["shopify_brand_field_mismatch",a=>{a.productVariant.product.metafields.nodes[3].value="Back70";}],
 ["shopify_pilot_model_or_color_missing",a=>{a.productVariant.product.metafields.nodes[1].value="";}],
 ["shopify_pilot_model_or_color_missing",a=>{a.productVariant.product.metafields.nodes[2].value="<script>";}],
 ["shopify_shoes_gender_unverified",a=>{a.productVariant.product.metafields.nodes[0].value="altro";}],
 ["shopify_shoes_size_unverified",a=>{a.productVariant.selectedOptions[0].value="Taglia 37";}],
 ["shopify_shoes_size_unverified",a=>{a.productVariant.selectedOptions.push({name:"Taglia",value:"38 EU"});}],
];
for(const [reason,modify] of changes){
  const data=source();modify(data);
  const result=await read(expected,{}, {queryShopify:async()=>data});
  assert.equal(result.ok,false,reason);
  assert.equal(result.reason,reason);
}
const unavailable=await read(expected,{},{
  queryShopify:async()=>{throw Error("private missing token");}
});
assert.equal(unavailable.reason,"shopify_private_fields_unavailable");
assert.ok(!JSON.stringify(unavailable).includes("token"));
const invalid=await read({...expected,variantId:"gid://shopify/ProductVariant/../bad"},{},{
  queryShopify:async()=>{throw Error("should not be called");}
});
assert.equal(invalid.reason,"source_identity_invalid");
console.log("Shopify admin-only Amazon SHOES field read regression tests passed.");
