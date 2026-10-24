import assert from "node:assert/strict";
import { build } from "esbuild";
const compiled=await build({entryPoints:["src/marketplace-amazon-generic-ean-preview.ts"],
  bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {previewAmazonGenericEanValidation:run}=await import("data:text/javascript;base64,"+
  Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const sku="RSX_64228G_V4928_-_ESPRESSO",ean="8300193548467";
const variantId="gid://shopify/ProductVariant/52554517676373";
const markets={IT:"APJ6JRA9NG5V4",DE:"A1PA6795UKMFR9",FR:"A13V1IB3VIYZZH",ES:"A1RKKUPIHCS9HS"};
const TYPES=["SOCKS","HANDBAG","SHIRT","COAT","HAT","BOOT"];
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

console.log("amazon generic EAN preview mocked and fail-closed tests: PASS");
