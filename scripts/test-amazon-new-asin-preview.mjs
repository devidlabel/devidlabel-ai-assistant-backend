import assert from "node:assert/strict";
import { build } from "esbuild";

const built=await build({entryPoints:["src/marketplace-amazon-new-asin-preview.ts"],
  bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
const {previewAmazonNewAsinShoesValidation:run}=await import(
  "data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));
const sku="MOCK_SNEAK_42_EU",marketplace="DE",ean="7427277372563";
const env={AMAZON_OFFER_PREVIEW_ENABLED:"true",AMAZON_SP_API_SELLER_ID:"A1234567891234"};
const request={marketplace,sku};
function research(){
  return {ok:true,status:"REQUIREMENTS_REVIEW_REQUIRED",marketplace,sku,
    seller_listing_state:"VERIFIED_ABSENT",ean_match_state:"NO_EXACT_MATCH",
    ean_absence_not_catalog_absence_proof:true,
    product_type:"SHOES",schema_enforced:true,schema_requirements:"LISTING",
    read_only:true,provider_mutations:0,product_payload_constructed:false,
    validation_preview_sent:false,can_publish:false,
    attribute_gap_report:{report_status:"GAPS_REQUIRE_REVIEW"},
    required_attribute_names:["brand","item_name","model_name","color"],
    shopify:{ean,product_title:"Mock Sneaker Ivory",
      variant_id:"gid://shopify/ProductVariant/55555",
      brand:"Back70",amazon_listing_brand:"Back 70 Streetwear",
      amazon_brand_mapping_source:"MERCHANT_CONFIRMED_MAPPING"}};
}
let calls=0;
const deps={
  research:async x=>{assert.deepEqual(x,{marketplace,sku,product_type:"SHOES"});return research();},
  readPrivateFields:async input=>{
    assert.equal(input.sku,sku);
    assert.equal(input.variantId,"gid://shopify/ProductVariant/55555");
    assert.equal(input.amazonBrand,"Back 70 Streetwear");
    return {ok:true,model_name:"Mohair",color:"Camel/Butter",target_gender:"female",
      model_number:"BK70-108051",age_range_description:"adult",
      bullet_point:"Mohair",
      closure_laces:true,
      product_description:"Sneaker in stile casual con finiture specifiche per la collezione del venditore, testo presente nel catalogo merchant.",
      footwear_size:{size:"37",size_class:"numeric",size_system:"eu_footwear_size_system"},
      draft_values_review_only:true,public_storefront_access_used:false,
      ready_for_publication:false};
  },
  getAccessToken:async()=> "MOCK_VALID_SPAPI_TOKEN",
  fetch:async (url,init)=>{
    calls++;
    const u=new URL(url);
    assert.equal(u.hostname,"sellingpartnerapi-eu.amazon.com");
    assert.equal(u.pathname,"/listings/2021-08-01/items/A1234567891234/MOCK_SNEAK_42_EU");
    assert.equal(u.searchParams.get("mode"),"VALIDATION_PREVIEW");
    assert.equal(u.searchParams.get("marketplaceIds"),"A1PA6795UKMFR9");
    assert.equal(init.method,"PUT");
    assert.equal(init.redirect,"manual");
    const body=JSON.parse(init.body);
    assert.equal(body.productType,"SHOES");
    assert.equal(body.requirements,"LISTING");
    assert.deepEqual(Object.keys(body.attributes).sort(),[
      "brand","externally_assigned_product_identifier","item_name","model_name","model_number",
      "product_description","bullet_point","closure","color","footwear_size","target_gender",
      "age_range_description"].sort());
    assert.equal(body.attributes.footwear_size[0].size,"37");
    assert.equal(body.attributes.target_gender[0].value,"female");
    assert.deepEqual(body.attributes.age_range_description,[{
      value:"Erwachsene",language_tag:"de_DE",marketplace_id:"A1PA6795UKMFR9",
    }]);
    assert.equal(body.attributes.model_name[0].value,"Mohair");
    assert.equal(body.attributes.color[0].value,"Camel/Butter");
    assert.equal(body.attributes.model_number[0].value,"BK70-108051");
    assert.equal(body.attributes.bullet_point[0].value,"Modell Back 70 Streetwear: Mohair");
    assert.equal(body.attributes.bullet_point[0].language_tag,"de_DE");
    assert.deepEqual(body.attributes.closure,[{type:[{value:"Schnürung",language_tag:"de_DE"}],marketplace_id:"A1PA6795UKMFR9"}]);
    assert.match(body.attributes.product_description[0].value,/Sneaker in stile casual/);
    assert.equal(body.attributes.product_description[0].language_tag,"de_DE");
    assert.equal(body.attributes.brand[0].value,"Back 70 Streetwear");
    assert.equal(body.attributes.item_name[0].value,"Mock Sneaker Ivory");
    assert.equal(body.attributes.externally_assigned_product_identifier[0].value,ean);
    assert.equal(body.attributes.externally_assigned_product_identifier[0].type,"ean");
    assert.ok(!JSON.stringify(body).includes("fulfillment_availability"));
    assert.ok(!JSON.stringify(body).includes("purchasable_offer"));
    assert.ok(!JSON.stringify(body).includes("quantity"));
    return new Response(JSON.stringify({
      sku,status:"INVALID",submissionId:"abc-123",
      issues:[{code:"90004100",severity:"ERROR",attributeNames:["country_of_origin"],
        message:"sensitive original provider diagnostic never expose"}],
    }),{status:200,headers:{"content-type":"application/json"}});
  },
};
const result=await run(request,env,deps);
assert.equal(calls,1);
assert.equal(result.ok,true);
assert.equal(result.provider_validation_status,"INVALID");
assert.equal(result.status,"VALIDATION_ONLY_REVIEW_REQUIRED");
assert.equal(result.product_created,false);
assert.equal(result.provider_mutations,0);
assert.equal(result.can_publish,false);
assert.equal(result.gpsr_compliance_proven,false);
assert.equal(result.validation_mode,"VALIDATION_PREVIEW");
assert.equal(result.preview_only,true);
assert.equal(result.private_shopify_metafields_used,true);
assert.equal(result.storefront_unchanged,true);
assert.ok(!JSON.stringify(result).includes("Camel/Butter"));
assert.ok(!JSON.stringify(result).includes("Mohair"));
assert.ok(!JSON.stringify(result).includes("BK70-108051"));
assert.ok(!JSON.stringify(result).includes("Modell Back 70 Streetwear"));
assert.ok(!JSON.stringify(result).includes("Schnürung"));
assert.ok(!JSON.stringify(result).includes("Sneaker in stile casual"));
assert.ok(result.attributes_submitted.includes("product_description"));
assert.ok(result.attributes_submitted.includes("model_number"));
assert.ok(result.attributes_submitted.includes("age_range_description"));
assert.ok(result.attributes_submitted.includes("bullet_point"));
assert.ok(result.attributes_submitted.includes("closure"));
assert.equal(result.issue_count,1);
assert.ok(result.attributes_submitted.includes("footwear_size"));
assert.ok(result.attributes_submitted.includes("target_gender"));
assert.deepEqual(result.issues[0],{
  code:"90004100",severity:"ERROR",attribute_names:["country_of_origin"]});
assert.equal(JSON.stringify(result).includes("sensitive original provider"),false);
assert.equal(JSON.stringify(result).includes(ean),false);
assert.equal(JSON.stringify(result).includes("Mock Sneaker Ivory"),false);

for(const bad of [{},{sku,marketplace,attributes:{}},{sku:"../bad",marketplace},{sku,marketplace:"US"}])
  await assert.rejects(()=>run(bad,env,deps),/amazon_new_asin_preview_invalid_request/);
const disabled=await run(request,{...env,AMAZON_OFFER_PREVIEW_ENABLED:"false"},deps);
assert.equal(disabled.ok,false);
assert.equal(disabled.reason,"amazon_validation_preview_disabled");
assert.equal(calls,1);

const unsafe=await run(request,env,{...deps,research:async()=>({...research(),seller_listing_state:"PRESENT"})});
assert.equal(unsafe.ok,false);
assert.equal(unsafe.reason,"read_only_research_or_listing_identity_unverified");
assert.equal(calls,1);
const matched=await run(request,env,{...deps,research:async()=>({...research(),ean_match_state:"EXACT_ONE"})});
assert.equal(matched.reason,"read_only_research_or_listing_identity_unverified");

const badProvider=await run(request,env,{...deps,fetch:async()=>new Response(JSON.stringify({
  sku,status:"INVALID",submissionId:"abc",issues:[{code:"123",severity:"ERROR",
    attributeNames:["bad/name"],message:"private"}]
}),{status:200,headers:{"content-type":"application/json"}})});
assert.equal(badProvider.reason,"amazon_preview_issues_invalid");
const tooBig=await run(request,env,{...deps,fetch:async()=>new Response("x".repeat(128001),{
  status:200,headers:{"content-type":"application/json"}})});
assert.equal(tooBig.reason,"amazon_preview_body_too_large");
console.log("Amazon new ASIN SHOES VALIDATION_PREVIEW safety tests passed.");

const mismatchedFields=await run(request,env,{...deps,readPrivateFields:async()=>({ok:false,reason:"shopify_brand_field_mismatch"})});
assert.equal(mismatchedFields.ok,false);
assert.equal(mismatchedFields.reason,"shopify_private_fields_not_verified");
assert.equal(calls,1);
