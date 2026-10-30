import assert from "node:assert/strict";
import {build} from "esbuild";
const z=await build({entryPoints:["src/marketplace-amazon-generic-ean-preview.ts"],
  bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {previewAmazonGenericEanValidation:preview}=await import("data:text/javascript;base64,"+
 Buffer.from(z.outputFiles[0].text).toString("base64"));
const sku="RFR_B31908_MA9083_A00010_UN",ean="8058136861080",market="APJ6JRA9NG5V4";
const ptd={source_scope:"Clark Hat B31908 MA9083 A00010 WHITE ONLY",catalog_product_type:"HAT",
 manufacturer_brand_operator:"RefrigiWear Distribution S.r.l.",
 manufacturer_status:"LEGAL_BRAND_OPERATOR_PUBLICLY_VERIFIED_NOT_FACTORY_OF_ORIGIN",
 department:"Unisex",age_range_description:"Adulto",item_type_name:"Berretto in maglia",
 care_instructions:"Consultare le istruzioni di lavaggio riportate sull'etichetta del prodotto",
 style:"Berretto con risvolto",weave_type:"Maglia",outer_material:"Acrilico",
 headwear_size:"Taglia Unica",batteries_required:false,
 supplier_declared_dg_hz_regulation:"not_applicable",
 logistics_defaults:{source:"MERCHANT_GLOBAL_DEFAULT_FROM_2026_10_28_MARKETPLACE_PROJECT",
  item_package_dimensions_cm:{length:30,width:30,height:5},item_package_weight_kg:0.5}};
const source={ok:true,status:"REQUIREMENTS_REVIEW_REQUIRED",marketplace:"IT",sku,product_type:"HAT",
 seller_listing_state:"VERIFIED_ABSENT",ean_match_state:"NO_EXACT_MATCH",
 ean_absence_not_catalog_absence_proof:true,read_only:true,provider_mutations:0,can_publish:false,
 product_payload_constructed:false,validation_preview_sent:false,schema_enforced:true,
 schema_requirements:"LISTING",full_schema_validated:false,brand_authorization_proven:false,
 gpsr_compliance_proven:false,title_category_conflict_detected:false,
 required_attribute_names:["item_name","brand","manufacturer"],
 available_schema_attribute_names:["item_name","brand","model_name","country_of_origin","target_gender",
 "color","product_description","bullet_point","externally_assigned_product_identifier",
 "manufacturer","department","age_range_description","item_type_name","care_instructions",
 "style","weave_type","outer","headwear_size","special_size_type","batteries_required",
 "supplier_declared_dg_hz_regulation","item_package_dimensions","item_package_weight","list_price"],
 shopify:{product_title:"Berretto Clark White",brand:"Refrigiwear",
 amazon_listing_brand:"Refrigiwear",ean,shopify_available:3,
 variant_id:"gid://shopify/ProductVariant/54765197197653"}};
let sent=null;
const r=await preview({marketplace:"IT",sku,product_type:"HAT"},
 {AMAZON_SP_API_SELLER_ID:"A1234567891234",AMAZON_OFFER_PREVIEW_ENABLED:"true"},
 {research:async()=>source,
 readShopify:async(_e,q,_v)=>q.includes("metaobject(id:")?
  {metaobject:{id:"gid://shopify/Metaobject/100",type:"product_feature_color",displayName:"White",
    fields:[{key:"name",type:"single_line_text_field",value:"White"}]}}:
  {productVariant:{id:"gid://shopify/ProductVariant/54765197197653",sku,barcode:ean,
    price:"29.61",compareAtPrice:"32.90",selectedOptions:[{name:"Taglia",value:"Taglia Unica"}],
    inventoryItem:{countryCodeOfOrigin:null},product:{title:"Berretto Clark White",
     description:"Berretto Clark White di Refrigiwear in maglia con logo frontale.",
     vendor:"Refrigiwear",status:"ACTIVE",
     amazonPtd:{type:"json",value:JSON.stringify({amazon_ptd_evidence:ptd})},
     colorRef:null,model:{type:"single_line_text_field",value:"Clark Hat"},
     gender:{type:"list.single_line_text_field",value:JSON.stringify(["Unisex"])},
     fabric:{type:"single_line_text_field",value:"100% Acrilico"},
     bullets:{type:"list.single_line_text_field",value:JSON.stringify(["Berretto in maglia morbida","Logo frontale Refrigiwear"])}}}},
 getAccessToken:async()=>"TEST_TOKEN",
 fetch:async(url,init)=>{
  const u=new URL(url);assert.equal(u.searchParams.get("mode"),"VALIDATION_PREVIEW");
  sent=JSON.parse(init.body);
  return new Response(JSON.stringify({sku,status:"INVALID",submissionId:"preview-001",
   issues:[{code:"90220",severity:"ERROR",attributeNames:["country_of_origin"]}]}),
   {status:200,headers:{"content-type":"application/json"}});
 }});
assert.equal(r.ok,true);
const attrs=sent.attributes;
assert.equal(attrs.manufacturer[0].value,"RefrigiWear Distribution S.r.l.");
assert.equal(attrs.item_package_weight[0].value,0.5);
assert.equal(attrs.item_package_dimensions[0].length.value,30);
assert.equal(attrs.item_package_dimensions[0].height.value,5);
assert.equal(attrs.list_price[0].value_with_tax,32.9);
assert.equal(attrs.headwear_size[0].size,"Taglia unica");
assert.equal(attrs.special_size_type[0].value,"One size fits all");
assert.equal(attrs.country_of_origin,undefined);
assert.equal(attrs.purchasable_offer,undefined);
assert.equal(attrs.fulfillment_availability,undefined);
assert.equal(attrs.outer[0].material[0].value,"Acrilico");
console.log("Refrigiwear PTD preview evidence test passed");
