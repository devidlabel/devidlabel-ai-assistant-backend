import assert from "node:assert/strict";
import {build} from "esbuild";
const bundle=await build({entryPoints:["src/marketplace-amazon-generic-ean-preview.ts"],
  bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {refrigiwearEvidenceAttrs:map}=await import("data:text/javascript;base64,"+
  Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const id="gid://shopify/Product/10426376421717",sku="RFR_F95000_FG9009_G06000_XL";
const market="APJ6JRA9NG5V4",descr="Tessuto tecnico caldo e traspirante";
const sourceDescription="Realizzata in tessuto tecnico caldo e traspirante, in un look urbano sportivo.";
const attrsSource={
  fabric_type:descr,fabric_type_kind:"TEXTILE_DESCRIPTION_WITHOUT_COMPOSITION_PERCENTAGES",
  fabric_type_status:"DOCUMENTED_SHOPIFY_PRODUCT_DESCRIPTION",
  outer_material:"Tessuto tecnico",weave_type:"Fleece",style:"Sportivo",
  special_size_type:"Standard",
  field_provenance:{fabric_type:{
    status:"DOCUMENTED_SHOPIFY_PRODUCT_DESCRIPTION",source_product_id:id,
    source_field:"description",source_text:descr,no_composition_percentages:true}}
};
function product(f=attrsSource,{productId=id,description=sourceDescription,vendor="Refrigiwear"}={}){
  return {id:productId,vendor,description,title:"Nevada Fleece Black",
    amazonPtd:{type:"json",value:JSON.stringify({
      source_product_id:id,amazon_ptd_evidence:f})}};
}
const output=(p)=>map(p,{},sku,"SWEATSHIRT","IT",market,
  ["fabric_type","outer","style","weave_type","special_size_type"],{},{});
const ok=output(product());
assert.deepEqual(ok.fabric_type,[{value:descr,language_tag:"it_IT",marketplace_id:market}]);
assert.deepEqual(ok.outer,[{material:[{value:"Tessuto tecnico",language_tag:"it_IT"}],
  marketplace_id:market}]);
assert.deepEqual(ok.style,[{value:"Sportivo",language_tag:"it_IT",marketplace_id:market}]);
assert.deepEqual(ok.weave_type,[{value:"Fleece",language_tag:"it_IT",marketplace_id:market}]);
assert.deepEqual(ok.special_size_type,[{value:"Standard",language_tag:"it_IT",marketplace_id:market}]);
for(const unsafe of [
  product(attrsSource,{productId:"gid://shopify/Product/999"}),
  product(attrsSource,{vendor:"Different Brand"}),
  product(attrsSource,{description:"No verifiable textile description"}),
  product({...attrsSource,fabric_type_kind:"UNVERIFIED"}),
  product({...attrsSource,field_provenance:{fabric_type:{
    ...attrsSource.field_provenance.fabric_type,source_product_id:"gid://shopify/Product/999"}}}),
  product({...attrsSource,field_provenance:{fabric_type:{
    ...attrsSource.field_provenance.fabric_type,source_text:"100% Poliestere"}}})
]){
  const got=output(unsafe);
  assert.equal(got.fabric_type,undefined,"No unverified descriptive fabric may publish");
}
console.log("Refrigiwear descriptive fleece source mapping: PASS");
