import assert from "node:assert/strict";
import { build } from "esbuild";
const bundle=await build({entryPoints:["src/marketplace-amazon-generic-ean-preview.ts"],
  bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {refrigiwearEvidenceAttrs:map}=await import("data:text/javascript;base64,"+
  Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const productId="gid://shopify/Product/10426395263317";
const sku="KWAY_K4136RW USY",marketId="APJ6JRA9NG5V4";
const text="Scomparto principale chiuso con zip";
const fields={source_scope:"K-WAY_PRODUCT_VERIFIED_BY_MERCHANT",
  model_number:"K4136RW",compartment_description:text,
  field_provenance:{compartment_description:{
    status:"DOCUMENTED_EXACT_SHOPIFY_PRODUCT_DESCRIPTION",
    source_product_id:productId,source_model:"K4136RW",
    source_field:"product.description"}}};
const make=(f=fields,id=productId)=>({id,vendor:"K-Way",
  amazonPtd:{type:"json",value:JSON.stringify({
    source_product_id:id,amazon_ptd_evidence:f})}});
const shape={compartment:{type:"array",items:{type:"object",
  properties:{description:{type:"array",items:{type:"object",
    properties:{value:{type:"string"},language_tag:{reference_resolution_required:true}},
    required:["language_tag","value"]}},marketplace_id:{reference_resolution_required:true}},
  required:["description"]}}};
const out=(product=make(),schema=shape,pt="DUFFEL_BAG",id=sku)=>
  map(product,{},id,pt,"IT",marketId,["compartment"],{},schema);
assert.deepEqual(out().compartment,[{description:[{value:text,language_tag:"it_IT"}],
  marketplace_id:marketId}]);
assert.deepEqual(out(make(fields,"gid://shopify/Product/5")),{}); // ID bound
assert.deepEqual(out({...make(),vendor:"Not K-Way"}),{});
assert.deepEqual(out(make(),"not_an_object"),{});
assert.deepEqual(out(make(),{}),{});
assert.deepEqual(out(make(),shape,"BACKPACK"),{});
assert.deepEqual(out(make(),shape,"DUFFEL_BAG","KWAY_OTHER_MODEL"),{});
const unproven={...fields,field_provenance:{compartment_description:{
  ...fields.field_provenance.compartment_description,source_model:"K0000ZZ"}}};
assert.deepEqual(out(make(unproven)),{});
const guessed={...fields,field_provenance:{compartment_description:{
  ...fields.field_provenance.compartment_description,status:"INFERRED_USER_AUTHORIZED"}}};
assert.deepEqual(out(make(guessed)),{});
const unsupported={compartment:{...shape.compartment,items:{type:"object",
  properties:{description:{type:"array",items:{type:"object",
    properties:{value:{type:"number"},language_tag:{}}},
  },marketplace_id:{}}}}};
assert.deepEqual(out(make(),unsupported),{});
assert.deepEqual(out(make({ ...fields,compartment_description:"" })),{});
const localShape={
  compartment:shape.compartment,
  item_length_width_height:{type:"array",items:{type:"object"}}
};
const localFields={...fields,part_number:"K4136RW",material:"Nylon",
  item_dimensions_cm:{width:43,height:32,depth:22},
  localized_marketplace_fields_status:"MODEL_GROUP_TRANSLATION_FROM_PRODUCT_SOURCE",
  localized_marketplace_fields:{
    DE:{compartment_description:"Hauptfach mit Reißverschluss",material:"Nylon"},
    FR:{compartment_description:"Compartiment principal avec fermeture éclair",material:"nylon"},
    ES:{compartment_description:"Compartimento principal con cremallera",material:"nailon"}
  },
  localized_compartment_description_provenance:{
    status:"TRANSLATED_FROM_EXACT_SHOPIFY_PRODUCT_DESCRIPTION",
    source_product_id:productId,source_sku:sku,source_model:"K4136RW",
    translations:["DE","FR","ES"]
  }
};
for(const [market,lang,material] of [
  ["DE","de_DE","Nylon"],["FR","fr_FR","nylon"],["ES","es_ES","nailon"]]){
  const mId={DE:"A1PA6795UKMFR9",FR:"A13V1IB3VIYZZH",ES:"A1RKKUPIHCS9HS"}[market];
  const attrs=map(make(localFields),{},sku,"DUFFEL_BAG",market,mId,
    ["compartment","item_length_width_height","model_number","part_number","material"],{},localShape);
  assert.deepEqual(attrs.compartment,[{description:[{
    value:localFields.localized_marketplace_fields[market].compartment_description,
    language_tag:lang}],marketplace_id:mId}]);
  assert.deepEqual(attrs.item_length_width_height,[{
    length:{value:43,unit:"centimeters"},width:{value:22,unit:"centimeters"},
    height:{value:32,unit:"centimeters"},marketplace_id:mId}]);
  assert.deepEqual(attrs.model_number,[{value:"K4136RW",language_tag:lang,marketplace_id:mId}]);
  assert.deepEqual(attrs.part_number,[{value:"K4136RW",language_tag:lang,marketplace_id:mId}]);
  assert.deepEqual(attrs.material,[{value:material,language_tag:lang,marketplace_id:mId}]);
}
const unsafe={...localFields,localized_compartment_description_provenance:{
  ...localFields.localized_compartment_description_provenance,source_product_id:"gid://shopify/Product/999"}};
const u=map(make(unsafe),{},sku,"DUFFEL_BAG","DE","A1PA6795UKMFR9",
  ["compartment"],{},localShape);
assert.equal(u.compartment,undefined);
const changed=map(make(localFields),{},"KWAY_K0000ZZ_USY","DUFFEL_BAG","DE","A1PA6795UKMFR9",
  ["compartment","model_number","material","part_number"],{},localShape);
assert.equal(changed.compartment,undefined);
console.log("K-Way exact duffel compartment PTD mapping, IT DE FR ES: PASS");
