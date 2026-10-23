import assert from "node:assert/strict";
import {build} from "esbuild";
const built=await build({entryPoints:["src/marketplace-amazon-accessory-upc-preview.ts"],
 bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
const {previewAmazonAccessoryUpcValidation:run}=await import(
 "data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));
const sku="SPR_910K9304NSZ",marketplace="DE",product_type="KEYCHAIN",upc="195029074399";
const request={marketplace,sku,product_type};
const env={AMAZON_OFFER_PREVIEW_ENABLED:"true",AMAZON_SP_API_SELLER_ID:"A1234567891234"};
const research=()=>({
 ok:true,status:"REQUIREMENTS_REVIEW_REQUIRED",marketplace,sku,product_type,
 seller_listing_state:"VERIFIED_ABSENT",upc_match_state:"NO_EXACT_MATCH",
 upc_absence_not_catalog_absence_proof:true,
 read_only:true,provider_mutations:0,can_publish:false,product_payload_constructed:false,
 validation_preview_sent:false,schema_enforced:true,schema_requirements:"LISTING",
 full_schema_validated:false,brand_authorization_proven:false,gpsr_compliance_proven:false,
 required_attribute_names:["brand","item_name","manufacturer"],
 available_schema_attribute_names:["externally_assigned_product_identifier","brand","item_name"],
 shopify:{product_title:"Sharks In Paris Backpack Keychain",amazon_listing_brand:"Sprayground",
  upc,ean:null,identifier_type:"UPC",shopify_available:10,
  variant_id:"gid://shopify/ProductVariant/54372526260565"},
});

const privateData=()=>({productVariant:{
 id:"gid://shopify/ProductVariant/54372526260565",sku,
 inventoryItem:{countryCodeOfOrigin:"CN"},
 product:{title:"Sharks In Paris Backpack Keychain",vendor:"Sprayground",status:"ACTIVE",
  model:{type:"single_line_text_field",value:"Sharks In Paris"}},
}});
let calls=0;
const fake={research:async q=>{assert.deepEqual(q,request);return research();},
 readShopify:async(_env,query,variables)=>{assert.match(query,/productVariant/);assert.deepEqual(variables,{variantId:research().shopify.variant_id});return privateData();},
 getAccessToken:async()=> "SAFE_FAKE_TOKEN",
 fetch:async (url,init)=>{
   calls++;
   const u=new URL(url);
   assert.equal(u.hostname,"sellingpartnerapi-eu.amazon.com");
   assert.equal(u.searchParams.get("mode"),"VALIDATION_PREVIEW");
   assert.equal(u.searchParams.get("marketplaceIds"),"A1PA6795UKMFR9");
   assert.equal(init.method,"PUT");
   assert.equal(init.redirect,"manual");
   const b=JSON.parse(init.body);
   assert.equal(b.productType,"KEYCHAIN");
   assert.equal(b.requirements,"LISTING");
   assert.deepEqual(Object.keys(b.attributes).sort(),
     ["brand","item_name","externally_assigned_product_identifier","model_name","country_of_origin"].sort());
   assert.deepEqual(b.attributes.model_name,[{value:"Sharks In Paris",marketplace_id:"A1PA6795UKMFR9"}]);
   assert.deepEqual(b.attributes.country_of_origin,[{value:"CN",marketplace_id:"A1PA6795UKMFR9"}]);
   assert.deepEqual(b.attributes.externally_assigned_product_identifier,
     [{value:upc,type:"upc",marketplace_id:"A1PA6795UKMFR9"}]);
   assert.ok(!JSON.stringify(b).includes("fulfillment_availability"));
   assert.ok(!JSON.stringify(b).includes("purchasable_offer"));
   assert.ok(!JSON.stringify(b).includes("quantity"));
   assert.ok(!JSON.stringify(b).includes("manufacturer"));
   return new Response(JSON.stringify({sku,status:"INVALID",submissionId:"preview-123",
    issues:[{code:"90220",severity:"ERROR",attributeNames:["manufacturer"],
      message:"never return provider issue text"}]}),
    {status:200,headers:{"content-type":"application/json"}});
 }};
const result=await run(request,env,fake);
assert.equal(calls,1);
assert.equal(result.ok,true);
assert.equal(result.provider_validation_status,"INVALID");
assert.equal(result.issue_count,1);
assert.deepEqual(result.issues,[{code:"90220",severity:"ERROR",attribute_names:["manufacturer"]}]);
assert.ok(!JSON.stringify(result).includes("never return"));
assert.ok(!JSON.stringify(result).includes("Sharks In Paris"));
assert.equal(result.product_created,false);
assert.equal(result.can_publish,false);
assert.equal(result.provider_mutations,0);
assert.equal(result.brand_authorization_proven,false);
assert.equal(result.gpsr_compliance_proven,false);
assert.equal(result.validation_mode,"VALIDATION_PREVIEW");
assert.ok(result.attributes_submitted.includes("model_name"));
assert.ok(result.attributes_submitted.includes("country_of_origin"));
const expectSourceBlocked=async (modify)=>{
 const data=privateData();modify(data);
 const r=await run(request,env,{...fake,readShopify:async()=>data});
 assert.equal(r.status,"BLOCKED_PREVIEW");
};
await expectSourceBlocked(s=>{s.productVariant.sku="OTHER";});
await expectSourceBlocked(s=>{s.productVariant.product.title="Other product";});
await expectSourceBlocked(s=>{s.productVariant.inventoryItem.countryCodeOfOrigin="China";});
await expectSourceBlocked(s=>{s.productVariant.product.model.value="<h1>Bad</h1>";});

const reject=async(overrides)=>{
 const r=await run(request,env,{...fake,research:async()=>({...research(),...overrides})});
 assert.equal(r.ok,false);assert.equal(r.status,"BLOCKED_PREVIEW");
};
await reject({seller_listing_state:"PRESENT"});
await reject({upc_match_state:"EXACT_ONE"});
await reject({schema_enforced:false});
await reject({title_category_conflict_detected:true});
await reject({shopify:{...research().shopify,upc:"195029074390"}});
await reject({shopify:{...research().shopify,shopify_available:0}});
await reject({shopify:{...research().shopify,ean:"0195029074399"}});
assert.equal(calls,1);
await assert.rejects(run({...request,product_type:"SHOES"},env,fake),/invalid_request/);
await assert.rejects(run({...request,upc},env,fake),/invalid_request/);
console.log("amazon accessory UPC preview: PASS");
