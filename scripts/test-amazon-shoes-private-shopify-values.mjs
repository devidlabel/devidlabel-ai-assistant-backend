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
    googleAgeGroup:{type:"single_line_text_field",value:"adult"},
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
// Inventory origin may be sent only from the exact merchant-origin fields.
const inventoryDeclared=source();
inventoryDeclared.productVariant.inventoryItem={countryCodeOfOrigin:"IT"};
const inventoryOrigin=await read(expected,{},{queryShopify:async()=>inventoryDeclared});
assert.equal(inventoryOrigin.ok,true);
assert.equal(inventoryOrigin.country_of_origin,"IT");
assert.ok(inventoryOrigin.verified_paths.includes("variant.inventoryItem.countryCodeOfOrigin"));
const originOverride=source();
originOverride.productVariant.inventoryItem={countryCodeOfOrigin:"IT"};
originOverride.productVariant.product.metafields.nodes.push({
 namespace:"amazon_ptd_shoes",key:"country_of_origin",type:"single_line_text_field",value:"IT"
});
const overrideResult=await read(expected,{},{queryShopify:async()=>originOverride});
assert.equal(overrideResult.country_of_origin,"IT");
assert.ok(overrideResult.verified_paths.includes("product.amazon_ptd_shoes.country_of_origin"));
assert.ok(!overrideResult.verified_paths.includes("variant.inventoryItem.countryCodeOfOrigin"));
const originConflict=source();
originConflict.productVariant.inventoryItem={countryCodeOfOrigin:"IT"};
originConflict.productVariant.product.metafields.nodes.push({
 namespace:"amazon_ptd_shoes",key:"country_of_origin",type:"single_line_text_field",value:"CN"
});
const conflict=await read(expected,{},{queryShopify:async()=>originConflict});
assert.equal(conflict.ok,false);
assert.equal(conflict.reason,"shopify_origin_sources_conflict");
for(const value of ["it","ITALY","", " IT","I1"]){
 const invalidOrigin=source();
 invalidOrigin.productVariant.inventoryItem={countryCodeOfOrigin:value};
 const result=await read(expected,{},{queryShopify:async()=>invalidOrigin});
 assert.equal(result.ok,false);
 assert.equal(result.reason,"shopify_inventory_origin_invalid");
}
const missingOrigin=source();
missingOrigin.productVariant.inventoryItem={countryCodeOfOrigin:null};
const noOrigin=await read(expected,{},{queryShopify:async()=>missingOrigin});
assert.equal(noOrigin.ok,true);
assert.equal(noOrigin.country_of_origin,undefined);

assert.equal(ok.age_range_description,"adult");
assert.ok(ok.verified_paths.includes("variant.mm-google-shopping.age_group"));
const conflictingAmazonAge=source();
conflictingAmazonAge.productVariant.product.metafields.nodes.push({
 namespace:"amazon_ptd_shoes",key:"age_range_description",type:"single_line_text_field",value:"teen"
});
const conflictedAge=await read(expected,{},{queryShopify:async()=>conflictingAmazonAge});
assert.equal(conflictedAge.ok,true);
assert.equal(conflictedAge.age_range_description,undefined,"Merchant Amazon override blocks Google Shopping fallback");
const explicitAmazonAge=source();
explicitAmazonAge.productVariant.googleAgeGroup=undefined;
explicitAmazonAge.productVariant.product.metafields.nodes.push({
 namespace:"amazon_ptd_shoes",key:"age_range_description",type:"single_line_text_field",value:"adult"
});
const verifiedExplicitAge=await read(expected,{},{queryShopify:async()=>explicitAmazonAge});
assert.equal(verifiedExplicitAge.age_range_description,"adult");
assert.ok(verifiedExplicitAge.verified_paths.includes("product.amazon_ptd_shoes.age_range_description"));
assert.ok(!verifiedExplicitAge.verified_paths.includes("variant.mm-google-shopping.age_group"));

for(const [type,value] of [["single_line_text_field","kids"],["single_line_text_field","Adult"],["boolean","adult"],["single_line_text_field"," adult"]]){
 const candidate=source();candidate.productVariant.googleAgeGroup={type,value};
 const r=await read(expected,{},{queryShopify:async()=>candidate});
 assert.equal(r.ok,true);
 assert.equal(r.age_range_description,undefined);
}
assert.equal(ok.color,"Camel/Butter");
assert.equal(ok.target_gender,"female");
assert.deepEqual(ok.footwear_size,{size:"37",size_class:"numeric",size_system:"eu_footwear_size_system"});
assert.equal(ok.ready_for_publication,false);
assert.equal(ok.public_storefront_access_used,false);
assert.equal(ok.draft_values_review_only,true);
assert.ok(!JSON.stringify(ok).includes("Donna"));
for(const selectedOptions of [[{name:"Numero",value:"37.5 EU"}],[{name:"Numero",value:"37 EU"},{name:"Color",value:"Camel"}],[{name:"Numero",value:"not-a-size"}]]){
  const s=source();s.productVariant.selectedOptions=selectedOptions;
  const result=await read(expected,{},{queryShopify:async()=>s});
  assert.equal(result.ok,true);
  assert.equal(result.footwear_size,undefined);
}
// A merchant's structured Shopify data may be used as candidate values for
// validation only when no amazon_ptd_shoes override exists. No storefront write.
const fallbackExpected={sku:"4B12_HYPER_D4006_38_EU",
  variantId:"gid://shopify/ProductVariant/52635806433621",
  productTitle:"Sneaker Hyper-d4006",shopifyVendor:"4B12",amazonBrand:"4B12"};
const fallback=source();
fallback.productVariant.googleAgeGroup=undefined;
fallback.productVariant.id=fallbackExpected.variantId;
fallback.productVariant.sku=fallbackExpected.sku;
fallback.productVariant.product.title=fallbackExpected.productTitle;
fallback.productVariant.product.vendor=fallbackExpected.shopifyVendor;
fallback.productVariant.product.metafields.nodes=[];
fallback.productVariant.product.fallbackModel={type:"single_line_text_field",value:"Hyper"};
fallback.productVariant.product.fallbackGender={type:"list.single_line_text_field",value:'["Donna"]'};
fallback.productVariant.product.fallbackColorRef={type:"metaobject_reference",value:"gid://shopify/Metaobject/299395449173"};
fallback.productVariant.product.descriptionHtml='<h2>4B12 Hyper D4006</h2><p>Una sneaker da donna nella colorazione bianca, con dettagli specifici del modello e suola per uso quotidiano.</p><ul><li>Modello: Hyper D4006</li><li>Codice modello: HYPER-D4006</li><li>Chiusura con lacci</li></ul>';
fallback.productVariant.selectedOptions=[{name:"Numero",value:"38 EU"}];
let fallbackHits=0;
const fallbackQuery=async (_env,query,vars)=>{
  fallbackHits++;
  if(query.includes("metaobject(id:$colorId)")){
    assert.deepEqual(vars,{colorId:"gid://shopify/Metaobject/299395449173"});
    return {metaobject:{id:vars.colorId,type:"product_feature_color",
      displayName:"Bianco",fields:[{key:"name",type:"single_line_text_field",value:"Bianco"}]}};
  }
  assert.deepEqual(vars,{variantId:fallbackExpected.variantId});
  return fallback;
};
const fallbackOk=await read(fallbackExpected,{}, {queryShopify:fallbackQuery});
assert.equal(fallbackHits,2);
assert.equal(fallbackOk.ok,true);
assert.equal(fallbackOk.model_name,"Hyper");
assert.equal(fallbackOk.color,"Bianco");
assert.equal(fallbackOk.target_gender,"female");
assert.equal(fallbackOk.model_number,"HYPER-D4006");
assert.equal(fallbackOk.bullet_point,"Hyper D4006");
assert.equal(fallbackOk.closure_laces,true);
assert.match(fallbackOk.product_description,/4B12 Hyper D4006/);
assert.ok(!fallbackOk.product_description.includes("<h2>"));
assert.ok(fallbackOk.verified_paths.includes("product.descriptionHtml"));
assert.deepEqual(fallbackOk.footwear_size,{size:"38",size_class:"numeric",size_system:"eu_footwear_size_system"});
assert.equal(fallbackOk.ready_for_publication,false);
assert.equal(fallbackOk.public_storefront_access_used,false);
assert.ok(fallbackOk.verified_paths.includes("product.features.color.metaobject.name"));

// 4B12 PlayNew D2045 canary: conditional PTD EU size must include age_group,
// gender and shoe width. This is a labelled regular-width assumption limited
// to the exact four women's SKU variants (not a global shoe-width guess).
const playExpected={
  sku:"4B12_PLAYNEW_D2045_39_EU",
  variantId:"gid://shopify/ProductVariant/54713971048789",
  productTitle:"PlayNew D-2045 White/Bronze",
  shopifyVendor:"4B12",amazonBrand:"4B12"
};
const playSource=structuredClone(fallback);
playSource.productVariant.id=playExpected.variantId;
playSource.productVariant.sku=playExpected.sku;
playSource.productVariant.selectedOptions=[{name:"Numero",value:"39 EU"}];
playSource.productVariant.product.title=playExpected.productTitle;
playSource.productVariant.product.fallbackModel={
  type:"single_line_text_field",value:"PlayNew D-2045"
};
const playQuery=async (_env,q,vars)=>q.includes("metaobject(id:$colorId)")?
  {metaobject:{id:vars.colorId,type:"product_feature_color",
    displayName:"Bianco",fields:[{key:"name",type:"single_line_text_field",value:"Bianco"}]}}:
  playSource;
const play=await read(playExpected,{},{queryShopify:playQuery});
assert.equal(play.ok,true);
assert.equal(play.age_range_description,"adult");
assert.deepEqual(play.footwear_size,{
  size:"39",size_class:"numeric",size_system:"eu_footwear_size_system",
  age_group:"adult",gender:"women",width:"medium"
});
assert.deepEqual(play.pilot_assumptions,[
  "EU_REGULAR_WIDTH_MEDIUM","ADULT_FROM_WOMENS_DEPARTMENT","NUMERIC_SHOE_SIZE_DIRECT_FROM_SHOPIFY"
]);

// Reject HTML carrying executable elements. No hidden body fields are inferred.
const dangerous=structuredClone(fallback);
dangerous.productVariant.product.descriptionHtml='<script>alert(1)</script>'+fallback.productVariant.product.descriptionHtml;
const descriptionQuery=async (_env,q,v)=>q.includes("metaobject(id:$colorId)")?
  {metaobject:{id:v.colorId,type:"product_feature_color",
    displayName:"Bianco",fields:[{key:"name",type:"single_line_text_field",value:"Bianco"}]}}:
  dangerous;
const dangerousRead=await read(fallbackExpected,{}, {queryShopify:descriptionQuery});
assert.equal(dangerousRead.ok,true);
assert.equal(dangerousRead.product_description,undefined);
assert.equal(dangerousRead.model_number,undefined);
assert.equal(dangerousRead.bullet_point,undefined);
assert.equal(dangerousRead.closure_laces,undefined);
const ambiguous=structuredClone(fallback);
ambiguous.productVariant.product.descriptionHtml+=
  '<li>Codice modello: HYPER-OTHER</li>';
const ambiguityRead=await read(fallbackExpected,{}, {queryShopify:async (_env,q,v)=>
  q.includes("metaobject(id:$colorId)")?
    {metaobject:{id:v.colorId,type:"product_feature_color",
      displayName:"Bianco",fields:[{key:"name",type:"single_line_text_field",value:"Bianco"}]}}:ambiguous});
assert.equal(ambiguityRead.ok,true);
assert.equal(ambiguityRead.model_number,undefined);
const ambiguousBullet=structuredClone(fallback);
ambiguousBullet.productVariant.product.descriptionHtml+='<li>Modello: Another Model</li>';
const ambiguousBulletRead=await read(fallbackExpected,{}, {queryShopify:async (_env,q,v)=>
  q.includes("metaobject(id:$colorId)")?
    {metaobject:{id:v.colorId,type:"product_feature_color",
      displayName:"Bianco",fields:[{key:"name",type:"single_line_text_field",value:"Bianco"}]}}:ambiguousBullet});
assert.equal(ambiguousBulletRead.ok,true);
assert.equal(ambiguousBulletRead.bullet_point,undefined);
const modelWithoutBullet=structuredClone(fallback);
modelWithoutBullet.productVariant.product.descriptionHtml=
  modelWithoutBullet.productVariant.product.descriptionHtml.replace('<li>Modello: Hyper D4006</li>','');
const noBulletRead=await read(fallbackExpected,{}, {queryShopify:async (_env,q,v)=>
  q.includes("metaobject(id:$colorId)")?
    {metaobject:{id:v.colorId,type:"product_feature_color",
      displayName:"Bianco",fields:[{key:"name",type:"single_line_text_field",value:"Bianco"}]}}:modelWithoutBullet});
assert.equal(noBulletRead.bullet_point,undefined);

assert.ok(ambiguityRead.product_description);
// Merchant closure must be one exact, unambiguous HTML list statement.
for(const extra of ['<li>Chiusura con velcro</li>','<li>Chiusura con lacci</li>']){
  const ambiguousClosure=structuredClone(fallback);
  ambiguousClosure.productVariant.product.descriptionHtml+=extra;
  const candidate=await read(fallbackExpected,{}, {queryShopify:async (_env,q,v)=>
    q.includes("metaobject(id:$colorId)")?
      {metaobject:{id:v.colorId,type:"product_feature_color",
        displayName:"Bianco",fields:[{key:"name",type:"single_line_text_field",value:"Bianco"}]}}:ambiguousClosure});
  assert.equal(candidate.ok,true);
  assert.equal(candidate.closure_laces,undefined);
}
const noClosure=structuredClone(fallback);
noClosure.productVariant.product.descriptionHtml=
  noClosure.productVariant.product.descriptionHtml.replace('<li>Chiusura con lacci</li>','');
const noClosureRead=await read(fallbackExpected,{}, {queryShopify:async (_env,q,v)=>
  q.includes("metaobject(id:$colorId)")?
    {metaobject:{id:v.colorId,type:"product_feature_color",
      displayName:"Bianco",fields:[{key:"name",type:"single_line_text_field",value:"Bianco"}]}}:noClosure});
assert.equal(noClosureRead.closure_laces,undefined);
// Exact Shopify rich-text editor layout: <li><p>Label: value</p></li>.
// 4B12 Hyper U-3027 uses this layout for all three model/closure fields.
const nestedHtml=fallback.productVariant.product.descriptionHtml
  .replace('<li>Modello: Hyper D4006</li>','<li><p>Modello: Hyper U-3027</p></li>')
  .replace('<li>Codice modello: HYPER-D4006</li>',
    '<li><p>Codice modello: HYPER-U3027</p></li>')
  .replace('<li>Chiusura con lacci</li>','<li><p>Chiusura con lacci</p></li>');
const nestedRead=async descriptionHtml=>{
  const product=structuredClone(fallback);
  product.productVariant.product.descriptionHtml=descriptionHtml;
  return read(fallbackExpected,{}, {queryShopify:async (_env,q,v)=>
    q.includes("metaobject(id:$colorId)")?
      {metaobject:{id:v.colorId,type:"product_feature_color",
        displayName:"Bianco",fields:[{key:"name",type:"single_line_text_field",value:"Bianco"}]}}:
      product});
};
const nested=await nestedRead(nestedHtml);
assert.equal(nested.ok,true);
assert.equal(nested.model_number,"HYPER-U3027");
assert.equal(nested.bullet_point,"Hyper U-3027");
assert.equal(nested.closure_laces,true);
assert.equal(nested.ready_for_publication,false);
const duplicated=await nestedRead(nestedHtml+
  '<li>Modello: Fake</li><li>Codice modello: WRONG</li><li>Chiusura con velcro</li>');
assert.equal(duplicated.bullet_point,undefined);
assert.equal(duplicated.model_number,undefined);
assert.equal(duplicated.closure_laces,undefined);
// Unsupported nested markup cannot be promoted to a trusted model attribute.
const malformed=await nestedRead(nestedHtml.replace(
  '<li><p>Modello: Hyper U-3027</p></li>',
  '<li><strong>Modello: Hyper U-3027</strong></li>'));
assert.equal(malformed.bullet_point,undefined);
const escapedBad=await nestedRead(nestedHtml.replace("HYPER-U3027",
  "HYPER-U3027&amp;X"));
assert.equal(escapedBad.model_number,undefined);
const mixed=await nestedRead(nestedHtml.replace(
  '<li><p>Chiusura con lacci</p></li>',
  '<li>Chiusura con lacci</li>'));
assert.equal(mixed.closure_laces,true);

const euTaglia=structuredClone(fallback);
euTaglia.productVariant.selectedOptions=[{name:"Taglia",value:"41"}];
euTaglia.productVariant.googleSizeSystem={type:"single_line_text_field",value:"EU"};
const euTagliaResult=await read(fallbackExpected,{},{queryShopify:async (_env,q,v)=>
  q.includes("metaobject(id:$colorId)")?{metaobject:{id:v.colorId,type:"product_feature_color",
    displayName:"Bianco",fields:[{key:"name",type:"single_line_text_field",value:"Bianco"}]}}:
    euTaglia});
assert.equal(euTagliaResult.ok,true);
assert.deepEqual(euTagliaResult.footwear_size,{size:"41",size_class:"numeric",size_system:"eu_footwear_size_system"});
assert.ok(euTagliaResult.verified_paths.includes("variant.mm-google-shopping.size_system"));
for(const sizeSystem of [undefined,{type:"single_line_text_field",value:"US"},{type:"boolean",value:"EU"}]){
  const candidate=structuredClone(euTaglia);
  candidate.productVariant.googleSizeSystem=sizeSystem;
  const actual=await read(fallbackExpected,{},{queryShopify:async (_env,q,v)=>
    q.includes("metaobject(id:$colorId)")?{metaobject:{id:v.colorId,type:"product_feature_color",
      displayName:"Bianco",fields:[{key:"name",type:"single_line_text_field",value:"Bianco"}]}}:candidate});
  assert.equal(actual.ok,true);
  assert.equal(actual.footwear_size,undefined,"No unitless EU inference without explicit Shopify evidence");
}
// A brand with a different confirmed Amazon mapping can never silently use vendor.
const missingMappedBrand=source();
missingMappedBrand.productVariant.product.metafields.nodes=[];
assert.equal((await read(expected,{}, {queryShopify:async()=>missingMappedBrand})).reason,
  "shopify_brand_field_mismatch");
const colorConflict=structuredClone(fallback);
colorConflict.productVariant.product.fallbackColorText={type:"single_line_text_field",value:"Verde"};
assert.equal((await read(fallbackExpected,{}, {queryShopify:async (_env,q,v)=>
  q.includes("metaobject")?{metaobject:{id:v.colorId,type:"product_feature_color",
    displayName:"Bianco",fields:[{key:"name",type:"single_line_text_field",value:"Bianco"}]}}:
    colorConflict})).reason,"shopify_color_sources_conflict");
const badRef=structuredClone(fallback);
assert.equal((await read(fallbackExpected,{}, {queryShopify:async (_env,q,v)=>
  q.includes("metaobject")?{metaobject:{id:v.colorId,type:"wrong",
    displayName:"Bianco",fields:[{key:"name",type:"single_line_text_field",value:"Bianco"}]}}:
    badRef})).reason,"shopify_color_reference_unverified");
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
// Genuine-style D-4006 merchant copy: no "Modello:" or "Codice modello:"
// labels, but model ID explicitly repeated, and technical characteristics
// explicitly list platform sole and TWO lace descriptions. Validation only.
const dSeriesHtml=[
 "<p>Sneaker 4B12 Hyper D-4006 da donna, dettagli laminati oro e suola platform effetto vintage.</p>",
 "<p>Il modello D-4006 da donna combina volumi importanti e dettagli luminosi, per uso quotidiano.</p>",
 "<h3>Dettagli distintivi</h3>",
 "<ul><li><p>Lacci con finitura brillante</p></li>",
 "<li><p>Suola platform effetto vintage</p></li></ul>",
 "<h3>Caratteristiche tecniche</h3>",
 "<ul><li><p>Tomaia in pelle</p></li><li><p>Lacci brillanti</p></li></ul>"
].join("");
async function fromDSeriesHtml(html,identity=fallbackExpected){
 const fixture=structuredClone(fallback);
 fixture.productVariant.product.descriptionHtml=html;
 return read(identity,{}, {queryShopify:async (_env,q,v)=>
   q.includes("metaobject(id:$colorId)")?
     {metaobject:{id:v.colorId,type:"product_feature_color",
       displayName:"Bianco",fields:[{key:"name",type:"single_line_text_field",value:"Bianco"}]}}:
     fixture});
}
const dRead=await fromDSeriesHtml(dSeriesHtml);
assert.equal(dRead.ok,true);
assert.equal(dRead.model_number,"D-4006");
assert.equal(dRead.bullet_point,"Suola platform effetto vintage");
assert.equal(dRead.closure_laces,true);
assert.equal(dRead.ready_for_publication,false);
assert.equal(dRead.manufacturer,undefined);
assert.equal(dRead.country_of_origin,undefined);
assert.equal(dRead.list_price,undefined);
for(const html of [
 dSeriesHtml.replace("Il modello D-4006","Il modello D-5006"),
 dSeriesHtml.replace("<li><p>Lacci brillanti</p></li>",""),
 dSeriesHtml.replace("<li><p>Lacci brillanti</p></li>","<li><p>Velcro</p></li>"),
 dSeriesHtml.replace("<li><p>Suola platform effetto vintage</p></li>",""),
 dSeriesHtml.replace("<h3>Caratteristiche tecniche</h3>",""),
 dSeriesHtml+"<li>Chiusura con velcro</li>",
 dSeriesHtml+"<script>alert(1)</script>"
]){
 const q=await fromDSeriesHtml(html);
 assert.equal(q.model_number,undefined);
 assert.equal(q.bullet_point,undefined);
 assert.equal(q.closure_laces,undefined);
}
const unrelated=await fromDSeriesHtml(dSeriesHtml,{...fallbackExpected,sku:"4B12_HYPER_U3027_41_EU"});
assert.equal(unrelated.ok,false,"Unexpected variant identity must fail before description extraction");
console.log("Shopify admin-only Amazon SHOES field read regression tests passed.");
