import assert from "node:assert/strict";
import { build } from "esbuild";
const compiled=await build({entryPoints:["src/marketplace-amazon-generic-ean-preview.ts"],
  bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {previewAmazonGenericEanValidation:run}=await import("data:text/javascript;base64,"+
  Buffer.from(compiled.outputFiles[0].text).toString("base64"));
// Source-backed fabric evidence must total 100% with approved components.
const {validatedRefrigiwearFabric:validRfrFabric,
 validatedKwayLayeredFabric:validKwayLayers}=await import("data:text/javascript;base64,"+
  Buffer.from(compiled.outputFiles[0].text).toString("base64"));
for(const value of ["100% Nylon","98% Cotone, 2% Elastan",
 "65% Poliestere, 35% Cotone","80% Cotone, 20% Poliestere",
 "50% Poliestere, 50% Acrilico","95% Poliestere, 5% Elastan",
 "76% Poliestere, 24% Poliuretano"])
  assert.equal(validRfrFabric(value),true,value);
for(const value of ["100% Seta","90% Cotone, 5% Poliestere",
 "120% Nylon","100% Cotone, 1% Cotone","90% Poliestere, 10% Unknown",
 "80% Cotone; 20% Poliestere","0% Nylon, 100% Cotone",
 "75% Poliestere, 24% Poliuretano"])
  assert.equal(validRfrFabric(value),false,value);
// Multi-shell fabrics: percentages apply to separate panels, not a blend.
assert.equal(validKwayLayers("Shell A: 100% Nylon; Shell B: 100% Poliestere"),true);
for(const value of ["100% Nylon","Shell A: 100% Nylon; Shell B: 90% Poliestere",
 "Shell A: 100% Nylon; Shell B: 100% Cotone",
 "Shell B: 100% Poliestere; Shell A: 100% Nylon"])
  assert.equal(validKwayLayers(value),false,value);
// K-Way: DE/FR/ES must use only source-scoped locale-neutral verified fields.
const {refrigiwearEvidenceAttrs:kwayEvidence}=await import("data:text/javascript;base64,"+
  Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const activeKwayId="gid://shopify/Product/11523512729941";
const kwayFields={source_scope:"K-WAY_PRODUCT_VERIFIED_BY_MERCHANT",
  water_resistance_level:"Impermeabile",batteries_required:false,
  manufacturer_brand_operator:"K-Way S.p.A.",
  manufacturer_status:"LEGAL_BRAND_OPERATOR_PUBLICLY_VERIFIED_NOT_FACTORY_OF_ORIGIN",
  department:"Unisex",fabric_type:"100% Nylon",
  logistics_defaults:{source:"MERCHANT_GLOBAL_DEFAULT_FROM_2026_10_28_MARKETPLACE_PROJECT",
    item_package_dimensions_cm:{length:30,width:30,height:5},item_package_weight_kg:0.5}};
const euKwayProduct={id:activeKwayId,vendor:"K-Way",amazonPtd:{type:"json",
  value:JSON.stringify({source_product_id:activeKwayId,amazon_ptd_evidence:kwayFields})}};
const neutralFields=["water_resistance_level","batteries_required",
  "item_package_dimensions","item_package_weight"];
for(const market of ["DE","FR","ES"]){
 const marketId={DE:"A1PA6795UKMFR9",FR:"A13V1IB3VIYZZH",ES:"A1RKKUPIHCS9HS"}[market];
 const attrs=kwayEvidence(euKwayProduct,{},"KWAY_K6131ZW_USY_S","COAT",
    market,marketId,[...neutralFields,"manufacturer","department","fabric_type"]);
 assert.deepEqual(Object.keys(attrs).sort(),neutralFields.sort(),market);
 assert.deepEqual(attrs.water_resistance_level,[{value:"waterproof",marketplace_id:marketId}]);
 assert.deepEqual(attrs.batteries_required,[{value:false,marketplace_id:marketId}]);
 assert.ok(!attrs.manufacturer&&!attrs.department&&!attrs.fabric_type);
}
assert.deepEqual(kwayEvidence({...euKwayProduct,id:"gid://shopify/Product/1"}, {},
 "KWAY_K6131ZW_USY_S","COAT","DE","A1PA6795UKMFR9",neutralFields),{});
// Preserve the verified main-fabric blend verbatim and keep lining separate.
const rayonBlend="81% Poliestere, 15% Rayon, 4% Elastan";
const rayonProductId="gid://shopify/Product/42";
const rayonFields={source_scope:"K-WAY_PRODUCT_VERIFIED_BY_MERCHANT",
  fabric_type:rayonBlend,lining_description:"100% Poliestere",
  manufacturer_brand_operator:"Example Brand Operator",
  manufacturer_status:"LEGAL_BRAND_OPERATOR_PUBLICLY_VERIFIED_NOT_FACTORY_OF_ORIGIN"};
const rayonProduct=(fields=rayonFields)=>({
  id:rayonProductId,vendor:"K-Way",amazonPtd:{type:"json",value:JSON.stringify({
    source_product_id:rayonProductId,amazon_ptd_evidence:fields
  })}
});
const rayonAllow=["fabric_type","lining_description","manufacturer","country_of_origin",
  "purchasable_offer","fulfillment_availability"];
const rayonAttrs=(product=rayonProduct(),sku="KWAY_TEST_RAYON_M",available=rayonAllow)=>
  kwayEvidence(product,{},sku,"COAT","IT","APJ6JRA9NG5V4",available);
assert.deepEqual(rayonAttrs(),{
  fabric_type:[{value:rayonBlend,language_tag:"it_IT",marketplace_id:"APJ6JRA9NG5V4"}],
  lining_description:[{value:"100% Poliestere",language_tag:"it_IT",marketplace_id:"APJ6JRA9NG5V4"}]
},"main fabric must not be renamed, flattened with the lining, or grant legal/offer attributes");
for(const invalidBlend of [
  "81% Poliestere, 15% Rayon", // incomplete main fabric
  "81% Poliestere, 15% Rayon, 5% Elastan", // exceeds 100%
  "81% Poliestere, 15% Rayon, 4% Rayon", // repeated component
  "81% Poliestere, 15% Rayon, 4% Elastan, 100% Poliestere", // combined lining
  "Tessuto principale: 81% Poliestere, 15% Rayon, 4% Elastan; Fodera: 100% Poliestere"
]){
  const attrs=rayonAttrs(rayonProduct({...rayonFields,fabric_type:invalidBlend}));
  assert.ok(!attrs.fabric_type,invalidBlend);
  assert.equal(attrs.lining_description[0].value,"100% Poliestere");
}
for(const product of [
  {...rayonProduct(),id:"gid://shopify/Product/43"},
  {...rayonProduct(),vendor:"Other Brand"},
  rayonProduct({...rayonFields,source_scope:"UNVERIFIED_SOURCE"})
]) assert.deepEqual(rayonAttrs(product),{},"unmatched source must not emit fabric or lining");
assert.deepEqual(rayonAttrs(rayonProduct(),"RFR_TEST_RAYON_M"),{});
assert.deepEqual(rayonAttrs(rayonProduct(),"KWAY_TEST_RAYON_M",[]),{});
for(const [market,marketId] of Object.entries({
  DE:"A1PA6795UKMFR9",FR:"A13V1IB3VIYZZH",ES:"A1RKKUPIHCS9HS"
})) assert.deepEqual(kwayEvidence(rayonProduct(),{},"KWAY_TEST_RAYON_M",
  "COAT",market,marketId,rayonAllow),{},"Italian fabric text must not populate another locale");

const sku="RSX_64228G_V4928_-_ESPRESSO",ean="8300193548467";
const variantId="gid://shopify/ProductVariant/52554517676373";
const markets={IT:"APJ6JRA9NG5V4",DE:"A1PA6795UKMFR9",FR:"A13V1IB3VIYZZH",ES:"A1RKKUPIHCS9HS"};
const TYPES=["SOCKS","HANDBAG","SHIRT","COAT","HAT","BOOT","BACKPACK","COSMETIC_CASE","STORAGE_BAG"];
const env={AMAZON_OFFER_PREVIEW_ENABLED:"true",AMAZON_SP_API_SELLER_ID:"A1234567891234"};
const request=(pt="SOCKS",marketplace="IT")=>({marketplace,sku,product_type:pt});
function research(r={},pt="SOCKS",marketplace="IT"){
 return {ok:true,status:"REQUIREMENTS_REVIEW_REQUIRED",marketplace,sku,product_type:pt,
  seller_listing_state:"VERIFIED_ABSENT",ean_match_state:"NO_EXACT_MATCH",
  ean_absence_not_catalog_absence_proof:true,read_only:true,provider_mutations:0,
  can_publish:false,product_payload_constructed:false,validation_preview_sent:false,
  schema_enforced:true,schema_requirements:"LISTING",
  full_schema_validated:false,brand_authorization_proven:false,gpsr_compliance_proven:false,
  title_category_conflict_detected:pt==="SOCKS",
  product_type_discovery_source:pt==="SOCKS"?"AMAZON_KEYWORDS_SHOPIFY_SOCKS":"AMAZON_ITEM_NAME",
  required_attribute_names:["item_name","brand","manufacturer"],
  available_schema_attribute_names:["item_name","brand","model_name","country_of_origin","target_gender","color","product_description","bullet_point","externally_assigned_product_identifier"],
  shopify:{product_title:"Calza lunga uomo",brand:"Red Sox",amazon_listing_brand:"Red Sox",
   ean,shopify_available:2,variant_id:variantId},
  ...r};
}
function privateData(){
 return {productVariant:{id:variantId,sku,barcode:ean,
  selectedOptions:[{name:"Taglia",value:"M"}],
  inventoryItem:{countryCodeOfOrigin:"IT"},
  product:{title:"Calza lunga uomo",description:"Calze uomo morbide e calde, con disegno geometrico.",vendor:"Red Sox",status:"ACTIVE",
   bullets:{type:"list.single_line_text_field",value:JSON.stringify(["Calze uomo con trama jacquard","Collezione invernale Red Sox"])},
   colorRef:{type:"metaobject_reference",value:"gid://shopify/Metaobject/299395514709"},
   model:{type:"single_line_text_field",value:"Jacquard Zig Zag"},
   gender:{type:"list.single_line_text_field",value:JSON.stringify(["Uomo"])}}}};
}
let calls=0;
function deps(pt,marketplace,overrides={}){
 return {research:async input=>{assert.deepEqual(input,request(pt,marketplace));return research({},pt,marketplace);},
  readShopify:async (_env,query,variables)=>{
   if(query.includes("metaobject(id:")){
    assert.deepEqual(variables,{colorId:"gid://shopify/Metaobject/299395514709"});
    return {metaobject:{id:variables.colorId,type:"product_feature_color",
      displayName:"Marrone",
      fields:[{key:"name",type:"single_line_text_field",value:"Marrone"}]}};
   }
   assert.match(query,/barcode/);assert.match(query,/navigation_gender/);
   assert.match(query,/colorRef/);assert.deepEqual(variables,{variantId});
   return privateData();
  },
  getAccessToken:async()=>"FAKE_TEST_TOKEN",
  fetch:async(url,init)=>{
   calls++;
   const u=new URL(url);
   assert.equal(u.hostname,"sellingpartnerapi-eu.amazon.com");
   assert.equal(u.searchParams.get("mode"),"VALIDATION_PREVIEW");
   assert.equal(u.searchParams.get("marketplaceIds"),markets[marketplace]);
   assert.equal(init.method,"PUT");
   assert.equal(init.redirect,"manual");
   const body=JSON.parse(init.body);
   assert.equal(body.productType,pt);
   assert.equal(body.requirements,"LISTING");
   assert.deepEqual(Object.keys(body.attributes).sort(),
    (marketplace==="IT"?["item_name","brand","externally_assigned_product_identifier","model_name","country_of_origin","target_gender","color","product_description","bullet_point"]:["item_name","brand","externally_assigned_product_identifier","model_name","country_of_origin","target_gender","color"]).sort());
   if(marketplace==="IT")assert.deepEqual(body.attributes.product_description,[{value:"Calze uomo morbide e calde, con disegno geometrico.",marketplace_id:markets[marketplace],language_tag:"it_IT"}]);
   if(marketplace==="IT")assert.equal(body.attributes.bullet_point.length,2);
   if(marketplace!=="IT"){assert.ok(!body.attributes.product_description);assert.ok(!body.attributes.bullet_point);}
   assert.deepEqual(body.attributes.externally_assigned_product_identifier,
    [{value:ean,type:"ean",marketplace_id:markets[marketplace]}]);
   assert.deepEqual(body.attributes.country_of_origin,
    [{value:"IT",marketplace_id:markets[marketplace]}]);
   assert.deepEqual(body.attributes.target_gender,
    [{value:"male",marketplace_id:markets[marketplace]}]);
   assert.deepEqual(body.attributes.color,[{value:"Marrone",marketplace_id:markets[marketplace]}]);
   assert.ok(!JSON.stringify(body).includes("fulfillment_availability"));
   assert.ok(!JSON.stringify(body).includes("purchasable_offer"));
   assert.ok(!JSON.stringify(body).includes("quantity"));
   assert.ok(!JSON.stringify(body).includes("manufacturer"));
   return new Response(JSON.stringify({sku,status:"INVALID",submissionId:"preview-123",
    issues:[{code:"90220",severity:"ERROR",attributeNames:["manufacturer"],
     message:"PRIVATE_PROVIDER_TEXT_DO_NOT_RETURN"}]}),
    {status:200,headers:{"content-type":"application/json"}});
  },...overrides};
}
for(const pt of TYPES){
 const result=await run(request(pt),env,deps(pt,"IT"));
 assert.equal(result.ok,true);
 assert.equal(result.provider_validation_status,"INVALID");
 assert.equal(result.product_type,pt);
 assert.equal(result.identifier_type,"EAN");
 assert.equal(result.issue_count,1);
 assert.deepEqual(result.issues,[{code:"90220",severity:"ERROR",attribute_names:["manufacturer"]}]);
 assert.equal(result.provider_mutations,0);
 assert.equal(result.product_created,false);
 assert.equal(result.can_publish,false);
 assert.ok(!JSON.stringify(result).includes("PRIVATE_PROVIDER_TEXT"));
}
// Size diagnostics retain actionable rejection/missing-field details without exposing contacts or IDs.
for(const code of ["90004205","90248","99022"]){
 for(const [pt,field] of [["COAT","apparel_size"],["HAT","headwear_size"]]){
  const rawMessage=`The 'xx_l' on the field '${field}.size' does not match [${field}.size_system]. Contact example42@example.invalid at https://example.invalid/private?token=hidden reference 1234567890123. `+
    "Additional size context. ".repeat(40);
  const result=await run(request(pt),env,deps(pt,"IT",{
   fetch:async(url)=>{assert.equal(new URL(url).searchParams.get("mode"),"VALIDATION_PREVIEW");
    return new Response(JSON.stringify({sku,status:"INVALID",submissionId:"size-diagnostic",
     issues:[{code,severity:"ERROR",attributeNames:[field],message:rawMessage}]}),
     {status:200,headers:{"content-type":"application/json"}});}
  }));
  assert.deepEqual(result.issues,[{code,severity:"ERROR",attribute_names:[field]}]);
  assert.equal(result.provider_validation_status,"INVALID");
  assert.equal(result.can_publish,false);
  assert.equal(result.provider_mutations,0);
  assert.ok(Array.isArray(result.size_issue_hints),code+" must retain sanitized size hints");
  assert.equal(result.size_issue_hints.length,1);
  assert.equal(result.size_issue_hints[0].length,480);
  for(const marker of ["[url]","[email]","[id]"])assert.ok(result.size_issue_hints[0].includes(marker));
  assert.deepEqual(result.headwear_diagnostics,[{
    field:`${field}.size`,rejected_value:"xx_l",preconditions:[field]
  }]);
  for(const secret of ["example42@example.invalid","https://example.invalid","1234567890123"])
    assert.ok(!JSON.stringify(result).includes(secret),secret);
 }
}
// Numeric identifiers inside a rejected value must not bypass the hint redaction.
const redactedValue=await run(request("COAT"),env,deps("COAT","IT",{
 fetch:async()=>new Response(JSON.stringify({sku,status:"INVALID",submissionId:"size-private",
  issues:[{code:"90248",severity:"ERROR",attributeNames:["apparel_size"],
   message:"The '1234567890123' on the field 'apparel_size.size' is invalid."}]}),
  {status:200,headers:{"content-type":"application/json"}})
}));
assert.ok(redactedValue.size_issue_hints[0].includes("[id]"));
assert.ok(!redactedValue.headwear_diagnostics);
assert.ok(!JSON.stringify(redactedValue).includes("1234567890123"));
// The diagnostic allowlist and the upstream message-length limit stay bounded.
for(const issue of [
 {code:"90248",severity:"ERROR",attributeNames:["color"],message:"PRIVATE_OTHER_ATTRIBUTE"},
 {code:"99022",severity:"ERROR",attributeNames:["manufacturer"],message:"PRIVATE_OTHER_ATTRIBUTE"},
 {code:"99022",severity:"ERROR",attributeNames:["apparel_size"],message:"x".repeat(5000)},
 {code:"90220",severity:"ERROR",attributeNames:["apparel_size"],message:"PRIVATE_OTHER_CODE"},
 {code:"90248",severity:"ERROR",attributeNames:["apparel_size"],message:"x".repeat(5000)}
]){
 const result=await run(request("COAT"),env,deps("COAT","IT",{
  fetch:async()=>new Response(JSON.stringify({sku,status:"INVALID",submissionId:"size-bounded",
   issues:[issue]}),{status:200,headers:{"content-type":"application/json"}})
 }));
 assert.deepEqual(result.issues,[{code:issue.code,severity:"ERROR",attribute_names:issue.attributeNames}]);
 assert.ok(!result.size_issue_hints&&!result.headwear_diagnostics);
 assert.equal(result.can_publish,false);
}

for(const market of Object.keys(markets)){
 const result=await run(request("SOCKS",market),env,deps("SOCKS",market));
 assert.equal(result.ok,true);
 assert.equal(result.marketplace,market);
}
const initialCalls=calls;
await assert.rejects(run(request("SHOES"),env),/invalid_request/);
await assert.rejects(run({...request(),ean},env),/invalid_request/);
const disabled=await run(request(),{...env,AMAZON_OFFER_PREVIEW_ENABLED:"false"});
assert.equal(disabled.status,"BLOCKED_PREVIEW");
const reject=async (override)=>{
 const dep=deps("SOCKS","IT");
 const result=await run(request(),env,{...dep,
  research:async()=>research(override)});
 assert.equal(result.status,"BLOCKED_PREVIEW");
};
await reject({seller_listing_state:"PRESENT"});
await reject({ean_match_state:"EXACT_ONE"});
await reject({schema_enforced:false});
await reject({title_category_conflict_detected:true,product_type_discovery_source:"AMAZON_ITEM_NAME"});
await reject({shopify:{...research().shopify,ean:"8300193548460"}});
await reject({shopify:{...research().shopify,shopify_available:0}});
const rfrSku="RFR_TEST_SOCKS_BLACK_M";
const rfrProduct=privateData();
rfrProduct.productVariant.sku=rfrSku;
rfrProduct.productVariant.product.vendor="Refrigiwear";
const rfrDeps=deps("SOCKS","IT");
const rfrZero=await run({...request(),sku:rfrSku},env,{...rfrDeps,
 research:async()=>({...research(),sku:rfrSku,
  shopify:{...research().shopify,brand:"Refrigiwear",
   amazon_listing_brand:"Refrigiwear",shopify_available:0}}),
 readShopify:async(e,q,v)=>q.includes("metaobject(id:")?
  rfrDeps.readShopify(e,q,v):rfrProduct,
 fetch:async()=>new Response(JSON.stringify({sku:rfrSku,status:"INVALID",
  submissionId:"preview-rfr-zero",issues:[{code:"90220",severity:"ERROR",
   attributeNames:["manufacturer"]}]}),{status:200,
  headers:{"content-type":"application/json"}})});
assert.equal(rfrZero.provider_validation_status,"INVALID",JSON.stringify(rfrZero));
assert.equal(rfrZero.issue_count,1);
const privateCases=[
 d=>{d.productVariant.sku="MISMATCH";},
 d=>{d.productVariant.barcode="8300193548460";},
 d=>{d.productVariant.product.title="Wrong item";},
 d=>{d.productVariant.inventoryItem.countryCodeOfOrigin="ITALY";},
 d=>{d.productVariant.product.model.value="<invalid>";},
 d=>{d.productVariant.product.gender={type:"single_line_text_field",value:"Uomo"};},
 d=>{d.productVariant.product.gender.value="not-json";},
 d=>{d.productVariant.product.gender.value=JSON.stringify(["Invalid"]);},
 d=>{d.productVariant.product.colorRef.type="single_line_text_field";},
 d=>{d.productVariant.product.colorRef.value="wrong";},
 d=>{d.productVariant.selectedOptions=[{name:"Colore",value:"Blu"}];},
 d=>{d.productVariant.selectedOptions=null;},
 d=>{d.productVariant.product.bullets.type="single_line_text_field";},
 d=>{d.productVariant.product.bullets.value="not json";},
];
for(const mutate of privateCases){
 const d=privateData();mutate(d);
 const r=await run(request(),env,deps("SOCKS","IT",{readShopify:async()=>d}));
 assert.equal(r.status,"BLOCKED_PREVIEW");
}
assert.equal(calls,initialCalls,"Failed preflight must not reach Amazon PUT");
// When a product has no curated feature color, never create one from title/copy.
const noColor=privateData();
delete noColor.productVariant.product.colorRef;
const missingColor=await run(request(),env,deps("SOCKS","IT",{
 readShopify:async()=>noColor,
 fetch:async(url,init)=>{
  assert.equal(new URL(url).searchParams.get("mode"),"VALIDATION_PREVIEW");
  const payload=JSON.parse(init.body);
  assert.equal(Object.hasOwn(payload.attributes,"color"),false);
  return new Response(JSON.stringify({sku,status:"INVALID",submissionId:"preview-no-color",
    issues:[{code:"90220",severity:"ERROR",attributeNames:["color"]}]}),
    {status:200,headers:{"content-type":"application/json"}});
 }
}));
assert.equal(missingColor.ok,true);
assert.ok(!missingColor.attributes_submitted.includes("color"));
// Incorrect Shopify feature metadata must stop before any provider PUT.
const badColorSources=[
 {id:"gid://shopify/Metaobject/299395514709",type:"other",
  displayName:"Marrone",fields:[{key:"name",type:"single_line_text_field",value:"Marrone"}]},
 {id:"gid://shopify/Metaobject/299395514709",type:"product_feature_color",
  displayName:"Marrone",fields:[{key:"name",type:"single_line_text_field",value:"Blu"}]},
];
for(const meta of badColorSources){
 const p=await run(request(),env,deps("SOCKS","IT",{
  readShopify:async(_env,query)=>query.includes("metaobject(id:")?{metaobject:meta}:privateData()
 }));
 assert.equal(p.status,"BLOCKED_PREVIEW");
}

// Multi-valued gender is a navigation facet, never a certified Amazon gender.
const multi=privateData();
multi.productVariant.product.gender.value=JSON.stringify(["Uomo","Donna","Unisex"]);
delete multi.productVariant.product.colorRef;
const ambiguous=await run(request(),env,deps("SOCKS","IT",{
 readShopify:async()=>multi,
 fetch:async(url,init)=>{
  assert.equal(new URL(url).searchParams.get("mode"),"VALIDATION_PREVIEW");
  const payload=JSON.parse(init.body);
  assert.equal(Object.hasOwn(payload.attributes,"target_gender"),false);
  return new Response(JSON.stringify({sku,status:"INVALID",submissionId:"preview-ambiguous",
   issues:[{code:"90220",severity:"ERROR",attributeNames:["target_gender"]}]}),
   {status:200,headers:{"content-type":"application/json"}});
 }
}));
assert.equal(ambiguous.ok,true);
assert.ok(!ambiguous.attributes_submitted.includes("target_gender"));
const absent=privateData();
delete absent.productVariant.product.gender;
delete absent.productVariant.product.colorRef;
const missing=await run(request(),env,deps("SOCKS","IT",{
 readShopify:async()=>absent,
 fetch:async(_url,init)=>{
  const payload=JSON.parse(init.body);
  assert.ok(!Object.hasOwn(payload.attributes,"target_gender"));
  return new Response(JSON.stringify({sku,status:"INVALID",submissionId:"preview-missing",
   issues:[{code:"90220",severity:"ERROR",attributeNames:["target_gender"]}]}),
   {status:200,headers:{"content-type":"application/json"}});
 }
}));
assert.equal(missing.ok,true);
assert.ok(!missing.attributes_submitted.includes("target_gender"));
// A product-bound department fills Amazon gender without collapsing the
// storefront navigation or replacing a valid single-value merchant gender.
const genderProductId="gid://shopify/Product/100";
const genderVariantId="gid://shopify/ProductVariant/100";
const genderSku="KWAY_TEST_DEPARTMENT_M",genderEan="0000000000017";
const genderDossier=(department="Unisex")=>({
 source_scope:"K-WAY_PRODUCT_VERIFIED_BY_MERCHANT",department,
 field_provenance:{department:{status:"DOCUMENTED_LIVE_SHOPIFY_METAOBJECT",
  source_product_id:genderProductId}}
});
const genderFixture=(department="Unisex",navigation=["Uomo","Donna","Unisex"])=>({
 productVariant:{id:genderVariantId,sku:genderSku,barcode:genderEan,
  selectedOptions:[],inventoryItem:{countryCodeOfOrigin:"CN"},
  product:{id:genderProductId,title:"Synthetic K-Way jacket",vendor:"K-Way",status:"ACTIVE",
   ...(navigation===null?{}:{gender:{type:"list.single_line_text_field",value:JSON.stringify(navigation)}}),
   amazonPtd:{type:"json",value:JSON.stringify({source_product_id:genderProductId,
    amazon_ptd_evidence:genderDossier(department)})}}}
});
const inspectGenderPreview=async(market,data,expected,available=true)=>{
 let sent=0;
 const result=await run({marketplace:market,sku:genderSku,product_type:"COAT"},env,{
  research:async()=>research({sku:genderSku,
   available_schema_attribute_names:["item_name","brand","externally_assigned_product_identifier",
    ...(available?["target_gender"]:[])],
   shopify:{product_title:data.productVariant.product.title,brand:data.productVariant.product.vendor,
    amazon_listing_brand:data.productVariant.product.vendor,ean:genderEan,shopify_available:1,
    variant_id:genderVariantId}},"COAT",market),
  readShopify:async()=>data,getAccessToken:async()=>"FAKE_TEST_TOKEN",
  fetch:async(url,init)=>{
   sent++;
   assert.equal(new URL(url).searchParams.get("mode"),"VALIDATION_PREVIEW");
   assert.equal(new URL(url).searchParams.get("marketplaceIds"),markets[market]);
   const payload=JSON.parse(init.body);
   assert.deepEqual(payload.attributes.target_gender,
    expected?[{value:expected,marketplace_id:markets[market]}]:undefined);
   return new Response(JSON.stringify({sku:genderSku,status:expected?"VALID":"INVALID",
    submissionId:"synthetic-gender-preview",issues:expected?[]:[{
     code:"90220",severity:"ERROR",attributeNames:["target_gender"]}]}),
    {status:200,headers:{"content-type":"application/json"}});
  }
 });
 assert.equal(sent,1);assert.equal(result.ok,true);
 assert.equal(result.attributes_submitted.includes("target_gender"),Boolean(expected));
};
for(const market of Object.keys(markets)){
 for(const [department,expected] of [["Uomo","male"],["Donna","female"],["Unisex","unisex"]]){
  for(const navigation of [["Uomo","Donna","Unisex"],null])
   await inspectGenderPreview(market,genderFixture(department,navigation),expected);
 }
 for(const [navigation,expected] of [[["Uomo"],"male"],[["Donna"],"female"]])
  await inspectGenderPreview(market,genderFixture("Unisex",navigation),expected);
 for(const alter of [
  d=>{delete d.amazon_ptd_evidence.department;},
  d=>{d.amazon_ptd_evidence.department="Other";},
  d=>{d.amazon_ptd_evidence.department="constructor";},
  d=>{d.amazon_ptd_evidence.department="__proto__";},
  d=>{delete d.amazon_ptd_evidence.field_provenance;},
  d=>{d.amazon_ptd_evidence.field_provenance.department.status="UNVERIFIED";},
  d=>{d.amazon_ptd_evidence.field_provenance.department.source_product_id="gid://shopify/Product/999";},
  d=>{d.source_product_id="gid://shopify/Product/999";},
  d=>{d.amazon_ptd_evidence.source_scope="OTHER_PRODUCT";}
 ]){
  const data=genderFixture(),dossier=JSON.parse(data.productVariant.product.amazonPtd.value);
  alter(dossier);data.productVariant.product.amazonPtd.value=JSON.stringify(dossier);
  await inspectGenderPreview(market,data,undefined);
 }
 const wrongProduct=genderFixture();wrongProduct.productVariant.product.id="gid://shopify/Product/999";
 await inspectGenderPreview(market,wrongProduct,undefined);
 const otherBrand=genderFixture();otherBrand.productVariant.product.vendor="Other Brand";
 await inspectGenderPreview(market,otherBrand,undefined);
 await inspectGenderPreview(market,genderFixture(),undefined,false);
}

// Official PTD size-system enum differs by marketplace. Never infer IT as6
// for DE as3, or FR/ES as4. The Shopify selected option supplies only size.
const sizeSystems={IT:"as6",DE:"as3",FR:"as4",ES:"as4"};
const sizeShape=(field,system)=>({[field]:{
 type:"array",items:{type:"object",properties:{
  size:{type:"string"},size_class:{type:"string",enum:["alpha","numeric"]},
  size_system:{type:"string",enum:[system]},
 },required:["size_class","size_system"]}}});
const sizeResearch=(pt,market,field,sizeSystemsOverride)=>research({
  available_schema_attribute_names:[...research({},pt,market).available_schema_attribute_names,field],
  ptd_size_shapes:sizeShape(field,sizeSystemsOverride||sizeSystems[market]),
  ptd_size_shapes_are_read_only:true,
  ptd_size_shapes_not_schema_validation:true,
  ptd_size_mapping_not_performed:true,
},pt,market);
for(const market of Object.keys(sizeSystems)){
 const pt="SHIRT",field="shirt_size";
 const x=await run(request(pt,market),env,deps(pt,market,{
  research:async()=>sizeResearch(pt,market,field),
  fetch:async(url,init)=>{
   assert.equal(new URL(url).searchParams.get("mode"),"VALIDATION_PREVIEW");
   const body=JSON.parse(init.body);
   assert.deepEqual(body.attributes[field],[{
     size:"M",size_class:"alpha",size_system:sizeSystems[market],
     marketplace_id:markets[market]}]);
   return new Response(JSON.stringify({sku,status:"INVALID",submissionId:"preview-size-"+market,
    issues:[{code:"90220",severity:"ERROR",attributeNames:["manufacturer"]}]}),
    {status:200,headers:{"content-type":"application/json"}});
  },
 }));
 assert.equal(x.ok,true);
 assert.ok(x.attributes_submitted.includes(field));
}
for(const market of Object.keys(sizeSystems)){
 const pt="COAT",field="apparel_size";
 const defaultDeps=deps(pt,market);
 const x=await run(request(pt,market),env,{...defaultDeps,
  research:async()=>sizeResearch(pt,market,field),
  readShopify:async(e,q,v)=>{
   const data=await defaultDeps.readShopify(e,q,v);
   if(!q.includes("metaobject(id:"))
     data.productVariant.selectedOptions=[{name:"Taglia",value:"40"}];
   return data;
  },
  fetch:async(url,init)=>{
   assert.equal(new URL(url).searchParams.get("mode"),"VALIDATION_PREVIEW");
   const body=JSON.parse(init.body);
   assert.deepEqual(body.attributes[field],[{
     size:"40",size_class:"numeric",size_system:sizeSystems[market],
     marketplace_id:markets[market]}]);
   return new Response(JSON.stringify({sku,status:"INVALID",submissionId:"preview-coat-"+market,
    issues:[{code:"90220",severity:"ERROR",attributeNames:["manufacturer"]}]}),
    {status:200,headers:{"content-type":"application/json"}});
  },
 });
 assert.equal(x.ok,true);
 assert.ok(x.attributes_submitted.includes(field));
}
// Optional body/height enums do not authorize these fields for every market.
// DE live validation rejects both qualifiers with90248 despite regular in the
// broad PTD enum. Preserve IT behavior and exact PTD size tokens in every market.
for(const market of Object.keys(sizeSystems)){
 for(const pt of ["COAT","SHIRT","SWEATER","SWEATSHIRT"]){
  for(const [prefix,brand] of [["KWAY_","K-Way"],["RFR_","Refrigiwear"]]){
   for(const [label,wire,sizeClass] of [["M","m","alpha"],["XXL","xx_l","alpha"],["40","40","numeric"]]){
    const field=pt==="SHIRT"?"shirt_size":"apparel_size";
    const fixtureSku=prefix+"TEST_MARKET_SIZE_"+label;
    const data=privateData();data.productVariant.sku=fixtureSku;
    data.productVariant.selectedOptions=[{name:"Taglia",value:label}];
    data.productVariant.product.vendor=brand;
    const fixtureResearch=sizeResearch(pt,market,field);
    fixtureResearch.sku=fixtureSku;
    fixtureResearch.shopify={...fixtureResearch.shopify,brand,amazon_listing_brand:brand};
    fixtureResearch.ptd_alpha_size_tokens={[field]:["m","xx_l"]};
    fixtureResearch.ptd_alpha_size_label_tokens={[field]:{M:"m",XXL:"xx_l"}};
    Object.assign(fixtureResearch.ptd_size_shapes[field].items.properties,{
     body_type:{type:"string",enum:["regular","slim"]},
     height_type:{type:"string",enum:["regular","tall"]}
    });
    const result=await run({marketplace:market,sku:fixtureSku,product_type:pt},env,{
     ...deps(pt,market),research:async()=>fixtureResearch,
     readShopify:async(e,q,v)=>q.includes("metaobject(id:")?deps(pt,market).readShopify(e,q,v):data,
     fetch:async(url,init)=>{
      assert.equal(new URL(url).searchParams.get("mode"),"VALIDATION_PREVIEW");
      const body=JSON.parse(init.body);
      assert.deepEqual(body.attributes[field],[{
       size:wire,size_class:sizeClass,size_system:sizeSystems[market],
       ...(market==="IT"?{body_type:"regular",height_type:"regular"}:{}),
       marketplace_id:markets[market]
      }],market+" "+pt+" "+fixtureSku);
      return new Response(JSON.stringify({sku:fixtureSku,status:"VALID",
       submissionId:"market-size-fixture",issues:[]}),
       {status:200,headers:{"content-type":"application/json"}});
     }
    });
    assert.equal(result.provider_validation_status,"VALID",JSON.stringify(result));
    assert.equal(result.provider_mutations,0);
    assert.equal(result.product_created,false);
   }
  }
 }
}

// FR/ES missing-qualifier recovery is tied to the exact Standard adult dossier,
// not a general extension of IT defaults. All fixtures below are synthetic.
async function captureStandardAdultSize(market,pt,label="M",alter=()=>{}){
 const field=pt==="SHIRT"?"shirt_size":"apparel_size";
 const fixtureSku="KWAY_TEST_STANDARD_SIZE_"+label;
 const productId="gid://shopify/Product/100";
 const data=privateData();
 data.productVariant.sku=fixtureSku;
 data.productVariant.selectedOptions=[{name:"Taglia",value:label}];
 Object.assign(data.productVariant.product,{id:productId,vendor:"K-Way"});
 const dossier={source_product_id:productId,amazon_ptd_evidence:{
  source_scope:"K-WAY_PRODUCT_VERIFIED_BY_MERCHANT",
  special_size_type:"Standard",
  special_size_type_status:"INFERRED_STANDARD_ADULT_CATALOG_SIZING",
  age_range_description:"Adulto"
 }};
 const fixtureResearch=sizeResearch(pt,market,field);
 fixtureResearch.ptd_alpha_size_tokens={[field]:["m"]};
 fixtureResearch.ptd_alpha_size_label_tokens={[field]:{XXL:"xx_l"}};
 Object.assign(fixtureResearch.ptd_size_shapes[field].items.properties,{
  body_type:{type:"string",enum:["regular","slim"]},
  height_type:{type:"string",enum:["regular","tall"]}
 });
 alter({data,dossier,research:fixtureResearch,field});
 data.productVariant.product.amazonPtd??={type:"json",value:JSON.stringify(dossier)};
 fixtureResearch.sku=data.productVariant.sku;
 fixtureResearch.shopify={...fixtureResearch.shopify,
  brand:data.productVariant.product.vendor,amazon_listing_brand:data.productVariant.product.vendor};
 let body;
 const result=await run({marketplace:market,sku:data.productVariant.sku,product_type:pt},env,{
  ...deps(pt,market),research:async()=>fixtureResearch,
  readShopify:async(e,q,v)=>q.includes("metaobject(id:")?deps(pt,market).readShopify(e,q,v):data,
  fetch:async(url,init)=>{
   assert.equal(new URL(url).searchParams.get("mode"),"VALIDATION_PREVIEW");
   body=JSON.parse(init.body);
   return new Response(JSON.stringify({sku:data.productVariant.sku,status:"VALID",
    submissionId:"standard-size-fixture",issues:[]}),
    {status:200,headers:{"content-type":"application/json"}});
  }
 });
 assert.equal(result.provider_validation_status,"VALID",JSON.stringify(result));
 assert.equal(result.provider_mutations,0);
 assert.equal(result.product_created,false);
 assert.equal(result.can_publish,false);
 assert.ok(!body.attributes.purchasable_offer&&!body.attributes.fulfillment_availability);
 return body.attributes[field][0];
}
for(const market of ["IT","DE","FR","ES"]){
 for(const pt of ["COAT","SHIRT","SWEATER","SWEATSHIRT"]){
  for(const [label,wire,sizeClass] of [["M","m","alpha"],["XXL","xx_l","alpha"],["40","40","numeric"]]){
   const value=await captureStandardAdultSize(market,pt,label);
   assert.deepEqual(value,{size:wire,size_class:sizeClass,size_system:sizeSystems[market],
    // K-Way DE SWEATSHIRT alpha previews return 90248 for both regular qualifiers.
    ...(market!=="DE"?{body_type:"regular",height_type:"regular"}:{}),
    marketplace_id:markets[market]},market+" "+pt+" "+label);
  }
 }
}
const standardSizeNegatives=[
 ["wrong product",({dossier})=>{dossier.source_product_id="gid://shopify/Product/101";}],
 ["unverified scope",({dossier})=>{dossier.amazon_ptd_evidence.source_scope="UNVERIFIED";}],
 ["missing status",({dossier})=>{delete dossier.amazon_ptd_evidence.special_size_type_status;}],
 ["nonstandard profile",({dossier})=>{dossier.amazon_ptd_evidence.special_size_type="Petite";}],
 ["nonadult profile",({dossier})=>{dossier.amazon_ptd_evidence.age_range_description="Bambino";}],
 ["conflicting market profile",({dossier})=>{dossier.amazon_ptd_evidence.special_size_type_by_market={FR:"Tall",ES:"Tall",DE:"Tall"};}],
 ["other brand",({data})=>{data.productVariant.product.vendor="Other Brand";}],
 ["other sku scope",({data})=>{data.productVariant.sku="RFR_TEST_STANDARD_SIZE_M";data.productVariant.product.vendor="Refrigiwear";}],
 ["malformed dossier",({data})=>{data.productVariant.product.amazonPtd={type:"json",value:"{"};}],
 ["untyped dossier",({data,dossier})=>{data.productVariant.product.amazonPtd={type:"single_line_text_field",value:JSON.stringify(dossier)};}],
 ["body token not exposed",({research,field})=>{research.ptd_size_shapes[field].items.properties.body_type.enum=["slim"];}],
 ["height token not exposed",({research,field})=>{research.ptd_size_shapes[field].items.properties.height_type.enum=["tall"];}]
];
for(const market of ["FR","ES","DE"]){
 for(const pt of ["COAT","SWEATSHIRT"]){
  for(const [reason,alter] of standardSizeNegatives){
   const value=await captureStandardAdultSize(market,pt,"M",alter);
   assert.deepEqual(value,{size:"m",size_class:"alpha",size_system:sizeSystems[market],
    marketplace_id:markets[market]},market+" "+pt+" "+reason);
  }
 }
}

// Amazon PTD enum codes can differ from the merchant-facing size label.
// When the live PTD explicitly exposes lowercase "s", transmit the wire token.
const alphaBase=deps("SHIRT","IT");
const alphaResult=await run(request("SHIRT"),env,{...alphaBase,
 research:async()=>({
  ...sizeResearch("SHIRT","IT","shirt_size"),
  ptd_alpha_size_tokens:{shirt_size:["s","m","l","xl"]}
 }),
 readShopify:async(e,q,v)=>{
  const data=await alphaBase.readShopify(e,q,v);
  if(!q.includes("metaobject(id:"))
    data.productVariant.selectedOptions=[{name:"Taglia",value:"S"}];
  return data;
 },
 fetch:async(_url,init)=>{
  const body=JSON.parse(init.body);
  assert.equal(body.attributes.shirt_size[0].size,"s");
  assert.equal(body.attributes.shirt_size[0].size_class,"alpha");
  return new Response(JSON.stringify({sku,status:"VALID",submissionId:"size-wire-accepted",issues:[]}),
    {status:200,headers:{"content-type":"application/json"}});
 }
});
assert.equal(alphaResult.provider_validation_status,"VALID");

// XL maps to the actual Amazon PTD enum by its display label, not a guess.
const xlBase=deps("SHIRT","IT");
const xlTest=await run(request("SHIRT"),env,{...xlBase,
 research:async()=>({...sizeResearch("SHIRT","IT","shirt_size"),
   ptd_alpha_size_label_tokens:{shirt_size:{XL:"x_l"}}}),
 readShopify:async(e,q,v)=>{
   const data=await xlBase.readShopify(e,q,v);
   if(!q.includes("metaobject(id:"))
     data.productVariant.selectedOptions=[{name:"Taglia",value:"XL"}];
   return data;
 },
 fetch:async(_url,init)=>{
   const body=JSON.parse(init.body);
   assert.deepEqual(body.attributes.shirt_size,[{
     size:"x_l",size_class:"alpha",size_system:"as6",marketplace_id:markets.IT}]);
   return new Response(JSON.stringify({sku,status:"VALID",submissionId:"xl-wire",issues:[]}),
     {status:200,headers:{"content-type":"application/json"}});
 }
});
assert.equal(xlTest.provider_validation_status,"VALID");
const xlMissing=await run(request("SHIRT"),env,{...xlBase,
 research:async()=>sizeResearch("SHIRT","IT","shirt_size"),
 readShopify:async(e,q,v)=>{
   const data=await xlBase.readShopify(e,q,v);
   if(!q.includes("metaobject(id:"))
     data.productVariant.selectedOptions=[{name:"Taglia",value:"XL"}];
   return data;
 },
 fetch:async()=>{throw Error("XL must be blocked without exact PTD token");}
});
assert.equal(xlMissing.status,"BLOCKED_PREVIEW");

// Accept the exact research-bound XXXL token without loosening every
// digit-leading size or changing market-specific body/height behavior.
for(const market of Object.keys(markets)){
 for(const pt of ["COAT","SHIRT","SWEATER","SWEATSHIRT"]){
  const value=await captureStandardAdultSize(market,pt,"XXXL",({research,field})=>{
   research.ptd_alpha_size_label_tokens[field].XXXL="3x_l";
  });
  assert.deepEqual(value,{size:"3x_l",size_class:"alpha",size_system:sizeSystems[market],
   ...(market!=="DE"?{body_type:"regular",height_type:"regular"}:{}),
   marketplace_id:markets[market]},market+" "+pt+" XXXL");
 }
}
for(const [label,mapping] of [
 ["XXXL",{}],["XXXL",{XXL:"3x_l"}],["XXL",{XXL:"3x_l"}],
 ["XXXL",{XXXL:"4x_l"}],["XXL",{XXL:"2x_l"}],["XXS",{XXS:"2x_s"}],
 ["XXXL",{XXXL:"3X_L"}],["XXXL",{XXXL:"3x_l "}],
]){
 const base=deps("SWEATSHIRT","IT"),fixture=sizeResearch("SWEATSHIRT","IT","apparel_size");
 fixture.ptd_alpha_size_label_tokens={apparel_size:mapping};
 // Raw diagnostics or a token list alone must not create a merchant binding.
 fixture.ptd_alpha_size_tokens={apparel_size:["3x_l","2x_l","2x_s"]};
 fixture.ptd_alpha_size_enum_pairs={apparel_size:{pairs:[{token:"3x_l",label:"3XL"}]}};
 let sent=0;
 const result=await run(request("SWEATSHIRT"),env,{...base,
  research:async()=>fixture,
  readShopify:async(e,q,v)=>{
   const data=await base.readShopify(e,q,v);
   if(!q.includes("metaobject(id:"))data.productVariant.selectedOptions=[{name:"Taglia",value:label}];
   return data;
  },
  fetch:async()=>{sent++;throw Error("Unbound or different size token must not reach Amazon");},
 });
 assert.equal(sent,0,label+" "+JSON.stringify(mapping));
 assert.equal(result.status,"BLOCKED_PREVIEW");
}

// Bad PTD size structure cannot reach Amazon PUT.
const invalidSize=await run(request("COAT"),env,deps("COAT","IT",{
 research:async()=>research({
  available_schema_attribute_names:[...research().available_schema_attribute_names,"apparel_size"],
  ptd_size_shapes:sizeShape("apparel_size","as6"),
  ptd_size_shapes_are_read_only:false,
  ptd_size_shapes_not_schema_validation:true,ptd_size_mapping_not_performed:true,
 }, "COAT","IT"),
 fetch:async()=>{throw new Error("must never send preview");},
}));
assert.equal(invalidSize.status,"BLOCKED_PREVIEW");

// BOOT: the variant states its own exact EU size, while Amazon's PTD
// provides the marketplace-specific structure. No SKU or US/UK inference.
const bootShape=(system="eu_footwear_size_system")=>({footwear_size:{
  type:"array",items:{type:"object",properties:{
    size:{type:"string"},size_class:{type:"string",enum:["numeric","alpha"]},
    size_system:{type:"string",enum:[system]},
    marketplace_id:{reference_resolution_required:true}
  },required:["size","size_class","size_system"]}}});
for(const market of Object.keys(markets)){
 const baseDeps=deps("BOOT",market);
 const result=await run(request("BOOT",market),env,{...baseDeps,
  research:async()=>research({
   available_schema_attribute_names:[...research({},"BOOT",market).available_schema_attribute_names,"footwear_size"],
   ptd_size_shapes:bootShape(),ptd_size_shapes_are_read_only:true,
   ptd_size_shapes_not_schema_validation:true,ptd_size_mapping_not_performed:true,
  },"BOOT",market),
  readShopify:async(e,q,v)=>{
   const data=await baseDeps.readShopify(e,q,v);
   if(!q.includes("metaobject(id:"))
     data.productVariant.selectedOptions=[{name:"Numero",value:"37 EU"}];
   return data;
  },
  fetch:async(url,init)=>{
   assert.equal(new URL(url).searchParams.get("mode"),"VALIDATION_PREVIEW");
   const body=JSON.parse(init.body);
   assert.deepEqual(body.attributes.footwear_size,[{size:"37",size_class:"numeric",
     size_system:"eu_footwear_size_system",marketplace_id:markets[market]}]);
   assert.ok(!JSON.stringify(body).includes("purchasable_offer"));
   return new Response(JSON.stringify({sku,status:"INVALID",submissionId:"boot-"+market,
     issues:[{code:"90220",severity:"ERROR",attributeNames:["manufacturer"]}]}),
     {status:200,headers:{"content-type":"application/json"}});
  },
 });
 assert.equal(result.ok,true);
 assert.equal(result.preview_only,true);
 assert.ok(result.attributes_submitted.includes("footwear_size"));
}
const bootResearch=(system="eu_footwear_size_system")=>research({
 available_schema_attribute_names:[...research({},"BOOT","IT").available_schema_attribute_names,"footwear_size"],
 ptd_size_shapes:bootShape(system),ptd_size_shapes_are_read_only:true,
 ptd_size_shapes_not_schema_validation:true,ptd_size_mapping_not_performed:true,
},"BOOT","IT");
const badBoot=deps("BOOT","IT"),bootCheck={name:"Numero",value:"37 EU"};
for(const invalidOptions of [
 [{name:"Numero",value:"37 EU"},bootCheck],null
]){
 const blocked=await run(request("BOOT"),env,{...badBoot,
  research:async()=>bootResearch(),
  readShopify:async(e,q,v)=>{
   const d=await badBoot.readShopify(e,q,v);
   if(!q.includes("metaobject(id:"))d.productVariant.selectedOptions=invalidOptions;
   return d;
  },fetch:async()=>{throw new Error("must not call Amazon PUT");},
 });
 assert.equal(blocked.status,"BLOCKED_PREVIEW");
}
const badBootSchema=await run(request("BOOT"),env,{...badBoot,
 research:async()=>bootResearch("uk_footwear_size_system"),
 readShopify:async(e,q,v)=>{
  const d=await badBoot.readShopify(e,q,v);
  if(!q.includes("metaobject(id:"))d.productVariant.selectedOptions=[bootCheck];
  return d;
 },
 fetch:async()=>{throw new Error("must not call Amazon PUT");}
});
assert.equal(badBootSchema.status,"BLOCKED_PREVIEW");
// A UK-labeled merchant option must NOT be silently converted into EU.
const unverifiedUnit=await run(request("BOOT"),env,{...badBoot,
 research:async()=>bootResearch(),
 readShopify:async(e,q,v)=>{
  const d=await badBoot.readShopify(e,q,v);
  if(!q.includes("metaobject(id:"))
   d.productVariant.selectedOptions=[{name:"Numero",value:"37 UK"}];
  return d;
 },
 fetch:async(_url,init)=>{
  assert.ok(!JSON.parse(init.body).attributes.footwear_size);
  return new Response(JSON.stringify({sku,status:"INVALID",submissionId:"boot-no-unit",
   issues:[{code:"90220",severity:"ERROR",attributeNames:["footwear_size"]}]}),
   {status:200,headers:{"content-type":"application/json"}});
 }
});
assert.equal(unverifiedUnit.ok,true);
assert.equal(unverifiedUnit.attributes_submitted.includes("footwear_size"),false);

// Technical fabric field only from merchant-authored single-component
// marketplace.fabric_composition and verified live Amazon PTD structure.
const fabShape={fabric_type:{type:"array",items:{type:"object",properties:{
 value:{type:"string"},language_tag:{reference_resolution_required:true},
 marketplace_id:{reference_resolution_required:true},
},required:["value","language_tag"]}}};
const fabResearch=(market)=>research({
 available_schema_attribute_names:[...research({},"SHIRT",market).available_schema_attribute_names,"fabric_type"],
 ptd_technical_shapes:fabShape,ptd_technical_shapes_read_only:true,
 ptd_technical_shapes_no_values_supplied:true,
},"SHIRT",market);
for(const market of Object.keys(markets)){
 const base=deps("SHIRT",market);
 const x=await run(request("SHIRT",market),env,{...base,
  research:async()=>fabResearch(market),
  readShopify:async(e,q,v)=>{
   const data=await base.readShopify(e,q,v);
   if(!q.includes("metaobject(id:"))data.productVariant.product.fabric={
    type:"single_line_text_field",value:"100% cotone"};
   return data;
  },
  fetch:async(url,init)=>{
   assert.equal(new URL(url).searchParams.get("mode"),"VALIDATION_PREVIEW");
   const body=JSON.parse(init.body);
   if(market==="IT")assert.deepEqual(body.attributes.fabric_type,[{
     value:"100% cotone",language_tag:"it_IT",marketplace_id:markets.IT}]);
   else assert.ok(!body.attributes.fabric_type);
   return new Response(JSON.stringify({sku,status:"INVALID",submissionId:"fabric-"+market,
     issues:[{code:"90220",severity:"ERROR",attributeNames:["manufacturer"]}]}),
     {status:200,headers:{"content-type":"application/json"}});
  },
 });
 assert.equal(x.ok,true);
 assert.equal(x.attributes_submitted.includes("fabric_type"),market==="IT");
}
const complexFabricDeps=deps("SHIRT","IT");
const complexFab=await run(request("SHIRT"),env,{...complexFabricDeps,
 research:async()=>fabResearch("IT"),
 readShopify:async(e,q,v)=>{
  const data=await complexFabricDeps.readShopify(e,q,v);
  if(!q.includes("metaobject(id:"))data.productVariant.product.fabric={
    type:"single_line_text_field",value:"Esterno: 70% poliammide; fodera 100% poliestere"};
  return data;
 },
 fetch:async(url,init)=>{
  assert.ok(!JSON.parse(init.body).attributes.fabric_type);
  return new Response(JSON.stringify({sku,status:"INVALID",submissionId:"fabric-complex",
   issues:[{code:"90220",severity:"ERROR",attributeNames:["fabric_type"]}]}),
   {status:200,headers:{"content-type":"application/json"}});
 }
});
assert.equal(complexFab.ok,true);
assert.ok(!complexFab.attributes_submitted.includes("fabric_type"));
for(const invalidFabric of [
 {type:"single_line_text_field",value:"<script>unsafe</script>"},
 {type:"list.single_line_text_field",value:"100% cotone"}
]){
 const blockedFab=await run(request("SHIRT"),env,{...complexFabricDeps,
  research:async()=>fabResearch("IT"),
  readShopify:async(e,q,v)=>{
   const data=await complexFabricDeps.readShopify(e,q,v);
   if(!q.includes("metaobject(id:"))data.productVariant.product.fabric=invalidFabric;
   return data;
  },fetch:async()=>{throw Error("must never reach Amazon");}
 });
 assert.equal(blockedFab.status,"BLOCKED_PREVIEW");
}

// K-Way accessories: only exact product-GID-bound merchant evidence can
// enrich a preview. Brand-operator contact alone cannot assert manufacturer.
const {refrigiwearEvidenceAttrs:merchantAccessoryAttrs}=await import(
  "data:text/javascript;base64,"+
  Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const kwayProductId="gid://shopify/Product/11523528294741";
const accessoryFields={
  source_scope:"K-WAY_PRODUCT_VERIFIED_BY_MERCHANT",
  number_of_compartments:2,number_of_pockets:3,
  inner_material:"Poliestere",size_info:"Taglia unica",
  manufacturer_brand_operator:"K-Way S.p.A.",
  manufacturer_status:"LEGAL_BRAND_OPERATOR_PUBLICLY_VERIFIED_NOT_FACTORY_OF_ORIGIN",
  item_dimensions_cm:{height:38,width:32,depth:12},
  model_number:"K4136NW",part_number:"K4136NW-USY",
  batteries_required:false
};
const kwayProduct=(productId=kwayProductId,fields=accessoryFields)=>({
  id:productId,vendor:"K-Way",amazonPtd:{type:"json",value:JSON.stringify({
    source_product_id:kwayProductId,amazon_ptd_evidence:fields
  })}
});
const accessoryAllow=["number_of_compartments","number_of_pockets",
  "inner","size_info","model_number","part_number","manufacturer"];
for(const pt of ["TOTE_BAG","DUFFEL_BAG","WAIST_PACK"]){
  const attrs=merchantAccessoryAttrs(kwayProduct(),{}, "KWAY_K4136NW_USY",
    pt,"IT",markets.IT,accessoryAllow);
  if(pt==="TOTE_BAG"||pt==="DUFFEL_BAG"){
    assert.deepEqual(merchantAccessoryAttrs(kwayProduct(),{},
      "KWAY_K4136NW_USY",pt,"IT",markets.IT,
      ["item_length_width_height"]).item_length_width_height,[{
      length:{value:32,unit:"centimeters"},
      width:{value:12,unit:"centimeters"},
      height:{value:38,unit:"centimeters"},
      marketplace_id:markets.IT
    }]);
  }
  assert.equal(attrs.number_of_compartments[0].value,2);
  assert.equal(attrs.number_of_pockets[0].value,3);
  assert.equal(attrs.inner[0].material[0].value,"Poliestere");
  assert.equal(attrs.size_info[0].display_name[0].value,"Taglia unica");
  assert.equal(attrs.model_number[0].value,"K4136NW");
  assert.equal(attrs.part_number[0].value,"K4136NW-USY");
  assert.ok(!attrs.manufacturer,"public brand operator is NOT confirmed manufacturer");
  assert.deepEqual(merchantAccessoryAttrs(kwayProduct(),{},"KWAY_K4136NW_USY",
    pt,"DE",markets.DE,accessoryAllow),{},
    "untranslated IT-only merchant dossier must not populate DE");
  assert.deepEqual(merchantAccessoryAttrs(kwayProduct("gid://shopify/Product/77"),{},
    "KWAY_K4136NW_USY",pt,"IT",markets.IT,accessoryAllow),{},
    "different Shopify product must never inherit an accessory dossier");
  assert.deepEqual(merchantAccessoryAttrs(kwayProduct(),{},"KWAY_K4136NW_USY",
    pt,"IT",markets.IT,[]),{},
    "no attribute may be sent without live Amazon PTD availability");
}
const labelVerified={...accessoryFields,
 manufacturer_status:"PRODUCT_MANUFACTURER_ROLE_VERIFIED_FROM_OFFICIAL_PRODUCT_LABEL"};
const labelAttrs=merchantAccessoryAttrs(kwayProduct(kwayProductId,labelVerified),{},
  "KWAY_K4136NW_USY","TOTE_BAG","IT",markets.IT,accessoryAllow);
assert.equal(labelAttrs.manufacturer[0].value,"K-Way S.p.A.");

// Official same-variant source can fill descriptive color and absent MSRP,
// without granting manufacturer, country of origin, or GPSR status.
const ferimyOfficial={
  ...accessoryFields,
  official_product_source_url:
   "https://www.k-way.com/it/products/bags-unisex-ferimy-black-pure-k4146jw-no-team-usy",
  official_product_style_code:"K4146JW",
  color:"Black Pure",official_msrp_eur:60
};
const officialFerimy=(f=ferimyOfficial)=>({
  ...kwayProduct(kwayProductId,f),
  title:"Marsupio Ferimy Black Pure"
});

// The verified accessory dossier carries market-neutral style codes and localized material.
for(const [market,material] of [["DE","Nylon"],["FR","nylon"],["ES","nailon"]]){
  const fields={...ferimyOfficial,model_number:"K4146JW",part_number:"K4146JW",
    material:"Nylon",localized_marketplace_fields_status:"MODEL_GROUP_TRANSLATION_FROM_PRODUCT_SOURCE",
    localized_marketplace_fields:{[market]:{material}}};
  const outgoing=(changes={},available=["material","model_number","part_number"])=>merchantAccessoryAttrs(
    officialFerimy({...fields,...changes}),{},"KWAY_K4146JW_USY","WAIST_PACK",market,markets[market],available);
  assert.equal(outgoing().model_number[0].value,"K4146JW");
  assert.equal(outgoing().part_number[0].value,"K4146JW");
  assert.equal(outgoing().material[0].value,material);
  assert.ok(!outgoing({localized_marketplace_fields:{}}).material);
  assert.ok(!outgoing({part_number:"another-model"}).part_number);
  assert.deepEqual(outgoing({},[]),{});
}

const offerless=merchantAccessoryAttrs(officialFerimy(),{},
  "KWAY_K4146JW_USY","WAIST_PACK","IT",markets.IT,
  ["color","list_price","manufacturer","country_of_origin"]);
assert.deepEqual(offerless.color,[{value:"Black Pure",marketplace_id:markets.IT}]);
assert.deepEqual(offerless.list_price,[{
 currency:"EUR",value_with_tax:60,marketplace_id:markets.IT
}]);
assert.ok(!offerless.manufacturer);
assert.ok(!offerless.country_of_origin);
const priorMsrp=merchantAccessoryAttrs(officialFerimy(),{compareAtPrice:"70.00"},
  "KWAY_K4146JW_USY","WAIST_PACK","IT",markets.IT,["list_price"]);
assert.equal(priorMsrp.list_price[0].value_with_tax,70);
for(const changes of [
 {official_product_source_url:"https://third-party.example/ferimy-k4146jw"},
 {official_product_style_code:"K4136RW"},
 {official_msrp_eur:1000000},
]){
 const attrs=merchantAccessoryAttrs(officialFerimy({...ferimyOfficial,...changes}),{},
   "KWAY_K4146JW_USY","WAIST_PACK","IT",markets.IT,["color","list_price"]);
 if(changes.official_msrp_eur){
   assert.ok(!attrs.list_price,"unverified MSRP must never be sent");
 }else{
   assert.ok(!attrs.color&&!attrs.list_price,
     "wrong official source or manufacturer style must fail closed");
 }
}
assert.deepEqual(merchantAccessoryAttrs(officialFerimy(),{},
 "KWAY_K4146JW_USY","WAIST_PACK","DE",markets.DE,
 ["color","list_price"]),{list_price:[{currency:"EUR",value_with_tax:60,marketplace_id:markets.DE}]},
 "verified EUR reference price may cross markets; Italian color evidence must not");

// Source-traced commercial/category inferences are reusable across K-Way
// models and markets without becoming label, factory, GPSR or live-write proof.
const commercialFields={
 source_scope:"K-WAY_PRODUCT_VERIFIED_BY_MERCHANT",
 manufacturer_brand_operator:"K-Way S.p.A.",
 manufacturer_status:"COMMERCIAL_BRAND_MANUFACTURER_INFERRED_FROM_OFFICIAL_BRAND_SOURCE",
 manufacturer_commercial_source:{source_type:"OFFICIAL_BRAND_OWNER_SELLER",
  brand:"K-Way",source_url:"https://www.k-way.com/it/pages/general-terms-and-conditions-of-sale"},
 special_size_type:"Standard",
 special_size_type_status:"INFERRED_STANDARD_ADULT_CATALOG_SIZING",
 supplier_declared_dg_hz_regulation:"not_applicable",
 batteries_required:false,batteries_included:false,
 fit_type:"Regolare",department:"Uomo",fabric_type:"100% Lana",
 country_of_origin:"CN",gpsr_safety_attestation:true
};
// New inference fixtures are fully synthetic and never identify live products.
const inferenceProductId="gid://shopify/Product/100";
const inferenceProduct=(productId=inferenceProductId,fields=commercialFields)=>({
 id:productId,vendor:"K-Way",amazonPtd:{type:"json",value:JSON.stringify({
  source_product_id:inferenceProductId,amazon_ptd_evidence:fields
 })}
});
const commercialAllow=["manufacturer","special_size_type",
 "supplier_declared_dg_hz_regulation","batteries_required","batteries_included",
 "country_of_origin","gpsr_safety_attestation","purchasable_offer","fulfillment_availability"];
const localeByMarket={IT:"it_IT",DE:"de_DE",FR:"fr_FR",ES:"es_ES"};
const specialShape=(values)=>({special_size_type:{type:"array",items:{type:"object",
 properties:{value:{type:"string",enum:values}}}}});
const commercialAttrs=(market="IT",fields=commercialFields,pt="SWEATER",shapes={})=>
 merchantAccessoryAttrs(inferenceProduct(inferenceProductId,fields),{},"KWAY_TEST_STANDARD_APPAREL_M",
  pt,market,markets[market],commercialAllow,{},shapes);
for(const market of Object.keys(markets)){
 for(const pt of ["SWEATER","COAT","TOTE_BAG"]){
  const attrs=commercialAttrs(market,commercialFields,pt);
  assert.deepEqual(attrs.manufacturer,[{value:"K-Way S.p.A.",
   language_tag:localeByMarket[market],marketplace_id:markets[market]}]);
  assert.deepEqual(attrs.special_size_type,[{value:"Standard",
   language_tag:localeByMarket[market],marketplace_id:markets[market]}]);
  assert.deepEqual(attrs.supplier_declared_dg_hz_regulation,[{
   value:"not_applicable",marketplace_id:markets[market]}]);
  assert.deepEqual(attrs.batteries_required,[{value:false,marketplace_id:markets[market]}]);
  assert.equal(attrs.batteries_included,undefined,
   "unpublished battery evidence must not exceed the deployed publisher contract");
  assert.ok(!attrs.country_of_origin&&!attrs.gpsr_safety_attestation&&
   !attrs.purchasable_offer&&!attrs.fulfillment_availability,
   "commercial/category evidence cannot create origin, safety or offer proof");
 }
 for(const fields of [
  {...commercialFields,manufacturer_commercial_source:undefined},
  {...commercialFields,manufacturer_brand_operator:"Other Company"},
  {...commercialFields,manufacturer_status:"LEGAL_BRAND_OPERATOR_PUBLICLY_VERIFIED_NOT_FACTORY_OF_ORIGIN"},
  {...commercialFields,manufacturer_commercial_source:{...commercialFields.manufacturer_commercial_source,brand:"Other Brand"}},
  {...commercialFields,manufacturer_commercial_source:{...commercialFields.manufacturer_commercial_source,source_type:"UNVERIFIED_CONTACT"}},
  {...commercialFields,manufacturer_commercial_source:{...commercialFields.manufacturer_commercial_source,source_url:"https://www.k-way.com.attacker.invalid/it/pages/faq"}},
  {...commercialFields,manufacturer_commercial_source:{...commercialFields.manufacturer_commercial_source,source_url:"https://www.k-way.com/it/products/knitwear-man-sebastien-merino-black-pure-k2142ew-usy"}}
 ]) assert.ok(!commercialAttrs(market,fields).manufacturer,
  "brand contact, wrong company, wrong source or wrong evidence status cannot assert manufacturer");
 const noCategoryValues={source_scope:commercialFields.source_scope,fit_type:"Regolare"};
 assert.deepEqual(commercialAttrs(market,noCategoryValues),{},
  "regular fit and brand scope alone supply no standard size, battery or hazard declaration");
 const enumAttrs=commercialAttrs(market,commercialFields,"SWEATER",specialShape(["standard","petite"]));
 assert.equal(enumAttrs.special_size_type[0].value,"standard",
  "use the exact token exposed by this market's PTD");
 assert.ok(!commercialAttrs(market,commercialFields,"SWEATER",specialShape(["Petite"])).special_size_type,
  "a conflicting exposed enum must not fall back to Standard");
 assert.deepEqual(merchantAccessoryAttrs(inferenceProduct("gid://shopify/Product/999",commercialFields),{},
  "KWAY_TEST_STANDARD_APPAREL_M","SWEATER",market,markets[market],commercialAllow),{},
  "commercial evidence remains bound to the exact source product");
 assert.deepEqual(merchantAccessoryAttrs(inferenceProduct(inferenceProductId,commercialFields),{},
  "KWAY_TEST_STANDARD_APPAREL_M","SWEATER",market,markets[market],[]),{},
  "even inferred fields need availability in the market's PTD");
}
for(const market of ["DE","FR","ES"]){
 assert.ok(!commercialAttrs(market,{...commercialFields,
  special_size_type_status:undefined}).special_size_type,
  "an Italian Standard string alone is not an approved cross-market category inference");
 assert.ok(!commercialAttrs(market,{...commercialFields,
  supplier_declared_dg_hz_regulation:"Non pericoloso"}).supplier_declared_dg_hz_regulation,
  "an Italian phrase is not a neutral hazard token");
}
assert.equal(commercialAttrs("ES",{...commercialFields,
 special_size_type_by_market:{ES:"Estándar"}},"SWEATER",
 specialShape(["Estándar","Grande"])).special_size_type[0].value,"Estándar");
assert.ok(!commercialAttrs("ES",{...commercialFields,
 special_size_type_by_market:{ES:"<invalid>"}}).special_size_type,
 "an invalid explicit market override must not silently revert to Standard");
assert.ok(!commercialAttrs("IT",{...commercialFields,headwear_size:"Taglia Unica"},
 "HAT",specialShape(["Petite"])).special_size_type,
 "the legacy headwear fallback must not overwrite a conflicting explicit size inference");

// Explicit model/source translations may enrich only their own locale.
const localizedFields={...commercialFields,fabric_type:"81% Poliestere, 15% Rayon, 4% Elastan",
 item_type_name:"Giacca",style:"Giacca reversibile",closure:"Cerniera",outer_material:"Poliestere",
 localized_marketplace_fields_status:"MODEL_GROUP_TRANSLATION_FROM_PRODUCT_SOURCE",
 localized_marketplace_fields:{
  DE:{item_type_name:"Jacke",department:"Herren",age_range_description:"Erwachsene",
   care_instructions:"Schonwaschgang bei 30 °C",style:"Wendejacke",weave_type:"Interlock",
   closure:"Reißverschluss",fit_type:"Normal",outer_material:"Polyester",
   lining_description:"100% Polyester",fabric_type:"81% Polyester, 15% Rayon, 4% Elasthan"},
  FR:{item_type_name:"Veste",department:"Homme",age_range_description:"Adulte",
   care_instructions:"Lavage délicat à 30 °C",style:"Veste réversible",weave_type:"Interlock",
   closure:"Fermeture éclair",fit_type:"Coupe normale",outer_material:"Polyester",
   lining_description:"100% Polyester",fabric_type:"81 % Polyester, 15 % Rayonne, 4 % Élasthanne"},
  ES:{item_type_name:"Chaqueta",department:"Hombre",age_range_description:"Adulto",
   care_instructions:"Lavado delicado a 30 °C",style:"Chaqueta reversible",weave_type:"Interlock",
   closure:"Cremallera",fit_type:"Corte regular",outer_material:"Poliéster",
   lining_description:"100% Poliéster",fabric_type:"81% Poliéster, 15% Rayón, 4% Elastano"}
 }};
const localizedAllow=[...commercialAllow,"item_type_name","department","age_range_description",
 "care_instructions","style","weave_type","closure","fit_type","outer","lining_description","fabric_type"];
const localizedAttrs=(market,fields=localizedFields)=>merchantAccessoryAttrs(
 inferenceProduct(inferenceProductId,fields),{},"KWAY_TEST_LAYERED_JACKET_M","COAT",market,
 markets[market],localizedAllow);
for(const market of ["DE","FR","ES"]){
 const attrs=localizedAttrs(market),local=localizedFields.localized_marketplace_fields[market];
 for(const field of ["item_type_name","department","age_range_description","care_instructions",
  "style","weave_type","fit_type","lining_description","fabric_type"])
  assert.deepEqual(attrs[field],[{value:local[field],language_tag:localeByMarket[market],marketplace_id:markets[market]}]);
 assert.equal(attrs.closure[0].type[0].value,local.closure);
 assert.equal(attrs.outer[0].material[0].value,local.outer_material);
 for(const change of [{localized_marketplace_fields_status:undefined},{localized_marketplace_fields:{}}]){
  const missing=localizedAttrs(market,{...localizedFields,...change});
  for(const field of ["item_type_name","department","fabric_type","closure","outer","style","fit_type"])
   assert.ok(!missing[field],"Italian text must never fill an absent/unapproved translation: "+field);
  assert.ok(missing.manufacturer&&missing.batteries_required,"neutral fields remain independently available");
 }
 const onlyDepartment=localizedAttrs(market,{...localizedFields,
  localized_marketplace_fields:{[market]:{department:local.department}}});
 assert.ok(onlyDepartment.department&&!onlyDepartment.fabric_type&&!onlyDepartment.style&&
  !onlyDepartment.fit_type&&!onlyDepartment.closure,"missing individual fields have no Italian fallback");
}
for(const [source,fabric] of [
 [localizedFields.fabric_type,"80 % Polyester, 16 % Rayonne, 4 % Élasthanne"],
 ["81% Poliestere, 15% Rayon","81 % Polyester, 15 % Rayonne"],
 [localizedFields.fabric_type,"81 % Coton, 15 % Rayonne, 4 % Élasthanne"],
 [localizedFields.fabric_type,"81 % Polyester, 15 % Viscose, 4 % Élasthanne"],
 [localizedFields.fabric_type,"Polyester"]
]) assert.ok(!localizedAttrs("FR",{...localizedFields,fabric_type:source,
 localized_marketplace_fields:{FR:{fabric_type:fabric}}}).fabric_type,
 "translation must preserve a complete 100% composition and each source material");
const twoShellFields={...localizedFields,fabric_type:"Shell A: 100% Nylon; Shell B: 100% Poliestere",
 localized_marketplace_fields:{FR:{fabric_type:"Couche A: 100% Nylon; Couche B: 100% Polyester"}}};
assert.equal(localizedAttrs("FR",twoShellFields).fabric_type[0].value,
 "Couche A: 100% Nylon; Couche B: 100% Polyester");
assert.ok(!localizedAttrs("FR",{...twoShellFields,
 localized_marketplace_fields:{FR:{fabric_type:"50% Nylon, 50% Polyester"}}}).fabric_type,
 "two 100% shells cannot become a single invented 50/50 blend");

// An unquantified textile descriptor is a different evidence kind. It cannot
// launder an incomplete composition or invent percentages during translation.
const descriptorFields=(value="Misto")=>({...localizedFields,fabric_type:value,
 fabric_type_status:"INFERRED_USER_AUTHORIZED",
 fabric_type_kind:"TEXTILE_DESCRIPTION_WITHOUT_COMPOSITION_PERCENTAGES",
 fabric_type_source:{source_type:"SHOPIFY_PRODUCT_FIELD",source_product_id:inferenceProductId,
  source_field:"material",source_descriptor:value},
 localized_marketplace_fields:{DE:{fabric_type:"Mischgewebe"},FR:{fabric_type:"Tissu mélangé"},
  ES:{fabric_type:"Tejido mixto"}}});
for(const market of Object.keys(markets)){
 const f=descriptorFields(),attrs=localizedAttrs(market,f);
 assert.equal(attrs.fabric_type[0].value,market==="IT"?"Misto":f.localized_marketplace_fields[market].fabric_type);
 for(const changed of [
  {...f,fabric_type_status:undefined},
  {...f,fabric_type_kind:"PERCENTAGE_COMPOSITION"},
  {...f,fabric_type_source:{...f.fabric_type_source,source_product_id:"gid://shopify/Product/999"}},
  {...f,fabric_type_source:{...f.fabric_type_source,source_descriptor:"Nylon"}},
  {...f,fabric_type_source:{...f.fabric_type_source,source_type:"UNVERIFIED_SOURCE"}},
  descriptorFields("80% Poliestere"),descriptorFields("80 Poliestere"),descriptorFields("Misto ignoto")
 ])assert.ok(!localizedAttrs(market,changed).fabric_type,
  "unquantified evidence needs explicit status, exact product/source and a recognized descriptor");
}
assert.equal(localizedAttrs("DE",{...descriptorFields("Poliestere e cotone"),
 localized_marketplace_fields:{DE:{fabric_type:"Polyester und Baumwolle"}}}).fabric_type[0].value,
 "Polyester und Baumwolle");
for(const fabric of ["100% Polyester","Nylon"])
 assert.ok(!localizedAttrs("DE",{...descriptorFields("Poliestere"),
  localized_marketplace_fields:{DE:{fabric_type:fabric}}}).fabric_type,
  "a descriptor translation cannot add a percentage or substitute another material");
for(const [market,fabric] of Object.entries({
 DE:"76% Polyester, 24% Polyurethan",FR:"76% Polyester, 24% Polyuréthane",ES:"76% Poliéster, 24% Poliuretano"
})) assert.equal(localizedAttrs(market,{...localizedFields,
 fabric_type:"76% Poliestere, 24% Poliuretano",
 localized_marketplace_fields:{[market]:{fabric_type:fabric}}}).fabric_type[0].value,fabric);
const translatedAccessory={...localizedFields,localized_marketplace_fields:{FR:{
 strap_type:"Bandoulière réglable",inner_material:"Polyester",size_info:"Taille unique"}}};
for(const pt of ["HANDBAG","COAT"]){
 const attrs=merchantAccessoryAttrs(inferenceProduct(inferenceProductId,translatedAccessory),{},
  "KWAY_TEST_ACCESSORY_UN",pt,"FR",markets.FR,["strap_type","inner","size_info"]);
 assert.equal(attrs.strap_type[0].value,"Bandoulière réglable");
 if(pt==="HANDBAG"){
  assert.equal(attrs.inner[0].material[0].value,"Polyester");
  assert.equal(attrs.size_info[0].display_name[0].value,"Taille unique");
 }else assert.ok(!attrs.inner&&!attrs.size_info,"accessory nested attributes retain their category scope");
}

// Exercise the complete preview path with CN supplied by InventoryItem.
// Provider VALID/INVALID, qualification and missing-battery errors are retained; no live write.
for(const market of Object.keys(markets)){
 for(const [providerStatus,providerIssues] of [
  ["VALID",[]],
  ["INVALID",[{code:"100632",severity:"ERROR",attributeNames:["brand"]}]],
  ["INVALID",[{code:"90220",severity:"ERROR",attributeNames:["batteries_included"]}]]
 ]){
  const kwaySku="KWAY_TEST_STANDARD_APPAREL_M";
  const details=privateData();
  details.productVariant.sku=kwaySku;
  details.productVariant.inventoryItem.countryCodeOfOrigin="CN";
  details.productVariant.product={...details.productVariant.product,
   ...inferenceProduct(inferenceProductId,commercialFields)};
  const result=await run({marketplace:market,sku:kwaySku,product_type:"SWEATER"},env,{
   research:async()=>research({sku:kwaySku,title_category_conflict_detected:false,
    available_schema_attribute_names:[...research().available_schema_attribute_names,...commercialAllow],
    ptd_technical_shapes:specialShape(["standard"]),
    shopify:{...research().shopify,brand:"K-Way",amazon_listing_brand:"K-Way"}},"SWEATER",market),
   readShopify:async(e,q,v)=>q.includes("metaobject(id:")?
    deps("SWEATER",market).readShopify(e,q,v):details,
   getAccessToken:async()=>"FAKE_TEST_TOKEN",
   fetch:async(url,init)=>{
    assert.equal(new URL(url).searchParams.get("mode"),"VALIDATION_PREVIEW");
    const body=JSON.parse(init.body);
    assert.deepEqual(body.attributes.country_of_origin,[{value:"CN",marketplace_id:markets[market]}]);
    assert.equal(body.attributes.manufacturer[0].value,"K-Way S.p.A.");
    assert.equal(body.attributes.special_size_type[0].value,"standard");
    assert.deepEqual(body.attributes.batteries_required,[{value:false,marketplace_id:markets[market]}]);
    assert.equal(body.attributes.batteries_included,undefined);
    assert.ok(!body.attributes.gpsr_safety_attestation&&!body.attributes.purchasable_offer);
    return new Response(JSON.stringify({sku:kwaySku,status:providerStatus,
     submissionId:"commercial-inference-"+market+"-"+providerStatus,
     issues:providerIssues}),
     {status:200,headers:{"content-type":"application/json"}});
   }
  });
  assert.equal(result.provider_validation_status,providerStatus,JSON.stringify(result));
  assert.deepEqual(result.issues,providerIssues.map(({attributeNames,...issue})=>
   ({...issue,attribute_names:attributeNames})));
  for(const field of ["can_publish","listing_write_enabled","brand_authorization_proven",
   "gpsr_compliance_proven","full_schema_validated","product_created"])
   assert.equal(result[field],false,field);
  assert.equal(result.provider_mutations,0);
 }
}

// Explicit product/model-bound localized copy is distinct from canonical IT
// text. Reference list_price is never derived from the selling price.
const euCopy={
 DE:{product_description:"Synthetische K-Way Jacke mit dokumentiertem Material und geradem Schnitt.",
  bullet_point:["Synthetische K-Way Jacke.","Dokumentiertes Material.","Pflegehinweise auf dem Etikett beachten."]},
 FR:{product_description:"Veste K-Way de test avec une matière documentée et une coupe droite.",
  bullet_point:["Veste K-Way de test.","Matière documentée.","Suivre les indications sur l’étiquette."]},
 ES:{product_description:"Chaqueta K-Way de prueba con material documentado y corte recto.",
  bullet_point:["Chaqueta K-Way de prueba.","Material documentado.","Seguir las indicaciones de la etiqueta."]}
};
const euContentFields=()=>({source_scope:"K-WAY_PRODUCT_VERIFIED_BY_MERCHANT",
 model_number:"K0001AA",localized_marketplace_fields_status:"MODEL_GROUP_TRANSLATION_FROM_PRODUCT_SOURCE",
 localized_product_content_status:"MODEL_GROUP_LOCALIZED_COPY_FROM_PRODUCT_DOSSIER",
 localized_product_content_source:{source_type:"SHOPIFY_PRODUCT_DOSSIER_LOCALIZED_FACTS",
  source_product_id:inferenceProductId,source_model:"K0001AA"},
 localized_marketplace_fields:structuredClone(euCopy)});
const euContentAllow=["product_description","bullet_point","list_price"];
const euContentAttrs=(market,fields=euContentFields(),variant={},productChanges={},available=euContentAllow)=>
 merchantAccessoryAttrs({...inferenceProduct(inferenceProductId,fields),...productChanges},variant,
  "KWAY_TEST_LOCALIZED_M","COAT",market,markets[market],available);
for(const market of ["DE","FR","ES"]){
 const attrs=euContentAttrs(market,euContentFields(),{compareAtPrice:"125.50",price:"99.95"});
 assert.deepEqual(attrs.product_description,[{value:euCopy[market].product_description,
  language_tag:localeByMarket[market],marketplace_id:markets[market]}]);
 assert.deepEqual(attrs.bullet_point,euCopy[market].bullet_point.map(value=>({value,
  language_tag:localeByMarket[market],marketplace_id:markets[market]})));
 assert.deepEqual(attrs.list_price,[{currency:"EUR",value_with_tax:125.5,marketplace_id:markets[market]}]);
 assert.equal(euContentAttrs(market,euContentFields(),{price:"99.95"}).list_price,undefined);
 const numericModel=euContentFields();
 numericModel.model_number=numericModel.localized_product_content_source.source_model="K00011A";
 assert.equal(euContentAttrs(market,numericModel).product_description[0].value,
  euCopy[market].product_description,"model suffix may contain a documented digit");
 for(const alter of [
  f=>{delete f.localized_product_content_status;},
  f=>{f.localized_product_content_status="UNVERIFIED";},
  f=>{delete f.localized_product_content_source;},
  f=>{f.localized_product_content_source.source_type="UNVERIFIED";},
  f=>{f.localized_product_content_source.source_product_id="gid://shopify/Product/999";},
  f=>{f.localized_product_content_source.source_model="K9999ZZ";},
  f=>{delete f.model_number;},
  f=>{f.model_number=f.localized_product_content_source.source_model="UNVERIFIED";},
  f=>{delete f.localized_marketplace_fields[market];},
  f=>{f.localized_marketplace_fields_status="UNVERIFIED";},
  f=>{f.source_scope="OTHER_PRODUCT";},
  f=>{f.localized_marketplace_fields[market]={product_description:"<unsafe>",bullet_point:["<unsafe>"]};},
  f=>{f.localized_marketplace_fields[market]={product_description:"short",bullet_point:["Duplicate","Duplicate"]};}
 ]){
  const fields=euContentFields();alter(fields);
  const rejected=euContentAttrs(market,fields);
  assert.equal(rejected.product_description,undefined);
  assert.equal(rejected.bullet_point,undefined);
 }
 assert.deepEqual(euContentAttrs(market,euContentFields(),{},
  {id:"gid://shopify/Product/999"}),{});
 assert.deepEqual(euContentAttrs(market,euContentFields(),{},
  {vendor:"Other Brand"}),{});
 assert.deepEqual(euContentAttrs(market,euContentFields(),{}, {},[]),{});
 const official=merchantAccessoryAttrs(officialFerimy(),{compareAtPrice:"70.00",price:"49.00"},
  "KWAY_K4146JW_USY","WAIST_PACK",market,markets[market],["list_price"]);
 assert.equal(official.list_price[0].value_with_tax,70,"existing compare-at takes precedence over official MSRP");
 for(const providerStatus of ["VALID","INVALID"]){
  const fixtureSku="KWAY_TEST_LOCALIZED_M";
  const data=privateData();Object.assign(data.productVariant,{id:genderVariantId,sku:fixtureSku,
   barcode:genderEan,compareAtPrice:"125.50",price:"99.95",selectedOptions:[]});
  data.productVariant.product={...data.productVariant.product,
   ...inferenceProduct(inferenceProductId,euContentFields()),title:"Synthetic K-Way jacket",
   colorRef:null,model:null,gender:null};
  const result=await run({marketplace:market,sku:fixtureSku,product_type:"COAT"},env,{
   research:async()=>research({sku:fixtureSku,
    available_schema_attribute_names:["item_name","brand","externally_assigned_product_identifier",...euContentAllow],
    shopify:{product_title:"Synthetic K-Way jacket",brand:"K-Way",amazon_listing_brand:"K-Way",
     ean:genderEan,shopify_available:1,variant_id:genderVariantId}},"COAT",market),
   readShopify:async()=>data,getAccessToken:async()=>"FAKE_TEST_TOKEN",
   fetch:async(url,init)=>{
    assert.equal(new URL(url).searchParams.get("mode"),"VALIDATION_PREVIEW");
    const body=JSON.parse(init.body);
    assert.deepEqual(body.attributes.product_description,attrs.product_description);
    assert.deepEqual(body.attributes.bullet_point,attrs.bullet_point);
    assert.deepEqual(body.attributes.list_price,attrs.list_price);
    assert.ok(!body.attributes.purchasable_offer&&!body.attributes.fulfillment_availability);
    return new Response(JSON.stringify({sku:fixtureSku,status:providerStatus,
     submissionId:"synthetic-eu-content",issues:providerStatus==="VALID"?[]:[{
      code:"90220",severity:"ERROR",attributeNames:["list_price"]}]}),
     {status:200,headers:{"content-type":"application/json"}});
   }
  });
  assert.equal(result.provider_validation_status,providerStatus);
  assert.equal(result.provider_mutations,0);assert.equal(result.can_publish,false);
  if(providerStatus==="INVALID")assert.deepEqual(result.issues,[{
   code:"90220",severity:"ERROR",attribute_names:["list_price"]}]);
 }
}
assert.deepEqual(euContentAttrs("IT"),{},"localized EU copy must not replace canonical Italian text");
const refrigiwearEu=merchantAccessoryAttrs({...inferenceProduct(inferenceProductId,euContentFields()),
 vendor:"Refrigiwear"},{compareAtPrice:"125.50"},"RFR_TEST_LOCALIZED_M","COAT","DE",markets.DE,
 euContentAllow);
assert.deepEqual(refrigiwearEu,{},"new EU copy/reference-price behavior is scoped to K-Way");

console.log("amazon generic EAN preview mocked and fail-closed tests: PASS");

