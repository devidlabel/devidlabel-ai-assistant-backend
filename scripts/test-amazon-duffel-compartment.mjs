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
console.log("K-Way exact duffel compartment PTD mapping: PASS");
