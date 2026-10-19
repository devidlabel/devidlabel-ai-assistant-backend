import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const built=await build({entryPoints:["src/marketplace-amazon-shoes-cross-source-readiness.ts"],
  bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
const {reconcileAmazonShoesEvidence:join,readAmazonShoesCrossSourceReadiness:run} =
  await import("data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));
const market="DE",sku="SAMPLE_SHOES_42";
const required=["age_range_description","brand","item_name","footwear_size",
  "model_name","model_number","outer","sole_material","color","target_gender",
  "country_of_origin","manufacturer","closure","lifestyle","bullet_point"];
function amazon(){
  const attrs=required.map(attribute=>({
    attribute,status:attribute==="brand"||attribute==="item_name"?"SOURCE_VERIFIED":
      ["footwear_size","model_name","model_number","color","target_gender"].includes(attribute)?"TRANSFORM_REVIEW":"MISSING",
    source_path:null,
  }));
  return {ok:true,status:"REQUIREMENTS_REVIEW_REQUIRED",marketplace:market,sku,
    product_type:"SHOES",seller_listing_state:"VERIFIED_ABSENT",
    ean_match_state:"NO_EXACT_MATCH",ean_absence_not_catalog_absence_proof:true,
    read_only:true,provider_mutations:0,can_publish:false,product_payload_constructed:false,
    validation_preview_sent:false,required_attribute_names:required,
    attribute_gap_report:{report_status:"GAPS_REQUIRE_REVIEW",product_type:"SHOES",
      read_only:true,provider_mutations:0,ready_for_validation_preview:false,
      ready_for_publication:false,brand_authorization_proven:false,gpsr_compliance_proven:false,
      required_attribute_count:required.length,attributes:attrs,
      required_status_counts:{SOURCE_VERIFIED:2,TRANSFORM_REVIEW:5,MISSING:8},
      conditional_requirements:[{attribute:"unmapped_schema_conditions",status:"CONDITIONAL_UNRESOLVED"}]},
  };
}
function shopify(){
  return {ok:true,status:"STRUCTURED_EVIDENCE_REVIEW_REQUIRED",sku,
    shopify_state:"ACTIVE_IN_STOCK",read_only:true,provider_mutations:0,
    values_exported:false,reference_values_resolved:false,manufacturer_verified:false,
    fields:[
      {shopify_path:"variant.mm-google-shopping.age_group",
        amazon_attribute_candidate:"age_range_description",evidence_state:"TRANSFORM_REVIEW",
        manufacturer_verified:false},
      {shopify_path:"product.custom.marketplace_model_name",
        amazon_attribute_candidate:"model_name",evidence_state:"TRANSFORM_REVIEW",
        manufacturer_verified:false},
      {shopify_path:"product.features.material",amazon_attribute_candidate:null,
        evidence_state:"REFERENCE_REVIEW",manufacturer_verified:false},
      {shopify_path:"variant.mm-google-shopping.gender",amazon_attribute_candidate:"target_gender",
        evidence_state:"TRANSFORM_REVIEW",manufacturer_verified:false},
    ],
  };
}
const report=join(amazon(),shopify(),market,sku);
assert.equal(report.ok,true);
assert.equal(report.status,"DOCUMENTATION_AND_SCHEMA_GATES_OPEN");
assert.equal(report.original_ptd_status_counts.MISSING,8);
assert.equal(report.missing_source_hint_count,1);
assert.equal(report.missing_with_new_shopify_source_hints[0].attribute,"age_range_description");
assert.equal(report.missing_with_new_shopify_source_hints[0].amazon_original_status,"MISSING");
assert.equal(report.missing_without_hint_count,7);
assert.equal(report.original_missing_attributes.length,8);
assert.deepEqual(report.existing_review_attributes_with_structured_hints,["model_name","target_gender"]);
assert.equal(report.conditional_requirements_unresolved,true);
for(const key of ["ready_for_validation_preview","ready_for_publication","can_publish",
  "brand_authorization_proven","gpsr_compliance_proven","full_schema_validated",
  "schema_checksum_verified","values_exported","listing_payload_constructed"])assert.equal(report[key],false,key);
assert.equal(report.provider_mutations,0);
assert.equal(report.read_only,true);
assert.equal(report.can_transfer_writer_ownership,false);
assert.deepEqual(join(amazon(),shopify(),market,sku),report);
assert.ok(!JSON.stringify(report).includes("Brand Model"));
assert.ok(!JSON.stringify(report).includes("SAMPLE-MPN-SECRET"));

let amazonCalls=0,shopifyCalls=0;
const deps={
  readAmazon:async (input)=>{
    amazonCalls++;
    assert.deepEqual(input,{marketplace:market,sku,product_type:"SHOES"});
    return amazon();
  },
  readShopifyEvidence:async input=>{
    shopifyCalls++;assert.deepEqual(input,{sku});return shopify();
  },
};
const live=await run({marketplace:market,sku},{},deps);
assert.equal(live.ok,true);
assert.equal(amazonCalls,1);
assert.equal(shopifyCalls,1);

const existing={...amazon(),seller_listing_state:"PRESENT_ATTRIBUTES_UNKNOWN"};
const noNew=await run({marketplace:market,sku},{},{
  readAmazon:async()=>existing,
  readShopifyEvidence:async()=>{throw Error("should never query Shopify after unsafe Amazon result");},
});
assert.equal(noNew.ok,false);
assert.equal(noNew.blocker,"amazon_new_asin_research_not_eligible");
assert.equal(noNew.provider_mutations,0);
const unsafeShop={...shopify(),provider_mutations:1};
assert.equal(join(amazon(),unsafeShop,market,sku).blocker,"shopify_evidence_not_safe");
const alteredAmazon={...amazon(),ean_absence_not_catalog_absence_proof:false};
assert.equal(join(alteredAmazon,shopify(),market,sku).blocker,"amazon_ptd_or_identity_not_safe");
const alteredGap=amazon();
alteredGap.attribute_gap_report.required_status_counts.MISSING=7;
assert.equal(join(alteredGap,shopify(),market,sku).blocker,"attribute_gap_count_inconsistent");
const dup=amazon();
dup.attribute_gap_report.attributes[0].attribute="model_name";
assert.equal(join(dup,shopify(),market,sku).blocker,"attribute_gap_structure_invalid");
const malformed={...shopify(),fields:[{shopify_path:"product.bad:path",
  amazon_attribute_candidate:"manufacturer",evidence_state:"TRANSFORM_REVIEW",manufacturer_verified:false}]};
assert.equal(join(amazon(),malformed,market,sku).blocker,"shopify_source_structure_unverified");
for(const bad of [{},{marketplace:market,sku,extra:"x"},{marketplace:"US",sku},{marketplace:market,sku:"../bad"}])
  await assert.rejects(()=>run(bad,{},deps),/amazon_shoes_readiness_invalid_request/);
const source=readFileSync("src/marketplace-amazon-shoes-cross-source-readiness.ts","utf8");
assert.equal(/(?:putListing|submitFeed|confirmShipment|updateInventory|createListing)/.test(source),false);
assert.equal(/method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)/.test(source),false);
console.log("Amazon SHOES cross-source readiness fail-closed tests passed.");
