import assert from "node:assert/strict";
import {build} from "esbuild";
const b=await build({entryPoints:["src/marketplace-amazon-generic-ean-preview.ts"],
  bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
const {refrigiwearEvidenceAttrs:map}=await import("data:text/javascript;base64,"+
  Buffer.from(b.outputFiles[0].text).toString("base64"));
const id="gid://shopify/Product/10452559462741";
const sku="KWAY_K3123TW_K89_M";
const lines=[
  "Slim fit, leggero e tecnico, ideale per mezza stagione o come strato intermedio.",
  "Il cappuccio ripiegabile a scomparsa nel colletto rende il capo estremamente versatile.",
  "Chiusura con zip",
  "2 tasche laterali con zip"
];
const description="Gilet uomo Blue Depth. "+lines.join(" ");
const f={source_scope:"K-WAY_PRODUCT_VERIFIED_BY_MERCHANT",
  model_number:"K3123TW",bullet_point:lines,
  field_provenance:{bullet_point:{
    status:"DOCUMENTED_EXACT_LIVE_SHOPIFY_DESCRIPTION_SUBSTRINGS",
    source_product_id:id,source_model:"K3123TW",
    source_field:"product.description",source_quoted_substrings:true}}};
const make=(fields=f,productId=id,desc=description,vendor="K-Way")=>
 ({id:productId,vendor,description:desc,
  amazonPtd:{type:"json",value:JSON.stringify({
   source_product_id:id,amazon_ptd_evidence:fields})}});
const attrs=(p=make(),s=sku,marketplace="IT")=>
 map(p,{},s,"COAT",marketplace,"APJ6JRA9NG5V4",["bullet_point"]);
const actual=attrs();
assert.deepEqual(actual.bullet_point,lines.map(value=>({
  value,language_tag:"it_IT",marketplace_id:"APJ6JRA9NG5V4"})));
assert.deepEqual(attrs(make(), "KWAY_K3123TW_K89_XL").bullet_point,actual.bullet_point);
for(const bad of [
 attrs(make(f,"gid://shopify/Product/999")),
 attrs(make(f,id,description,"Other")),
 attrs(make(f,id,"Different description")),
 attrs(make({...f,model_number:"K0000ZZ"})),
 attrs(make({...f,field_provenance:{bullet_point:{
   ...f.field_provenance.bullet_point,source_product_id:"gid://shopify/Product/999"}}})),
 attrs(make({...f,bullet_point:[...lines,"Invented hydrostatic claims"]})),
 attrs(make({...f,bullet_point:[lines[0],lines[0]]})),
 attrs(make(),"KWAY_K9999ZZ_K89_M"),
 attrs(make(),sku,"DE")
]) assert.equal(bad.bullet_point,undefined);
console.log("K-Way exact source bullets across model sizes: PASS");
