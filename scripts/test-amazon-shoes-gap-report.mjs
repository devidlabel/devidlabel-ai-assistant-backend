import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const out = await build({
  entryPoints:["src/marketplace-amazon-shoes-gap-report.ts"],
  bundle:true, platform:"neutral", format:"esm", write:false, logLevel:"silent",
});
const {buildAmazonShoesGapReport:gap} = await import(
  "data:text/javascript;base64,"+Buffer.from(out.outputFiles[0].text).toString("base64")
);

const required = [
  "age_range_description","brand","bullet_point","closure","color","country_of_origin",
  "footwear_size","height_map","inner","item_name","leather_type","lifestyle",
  "manufacturer","model_name","model_number","outer","product_description","shaft",
  "sole_material","strap_type","style","target_gender","water_resistance_level",
];
const product = {
  status:"ACTIVE", product_type:"Sneakers",vendor:"Mock Sneaker Co",
  title:"Synthetic sample shoe",
  tags:["model:sample","color:camel","gender:donna","style:casual"],
  description_html:"<p>Only marketing description</p>",
};
const variant = {
  sku:"MOCK_SHOE_37_EU",title:"37 EU",
  selected_options:[{name:"Numero",value:"37 EU"}],
};
function byField(report) {
  return Object.fromEntries(report.attributes.map(x=>[x.attribute,x]));
}
const report=gap(product,variant,required,true,true);
assert.equal(report.report_status,"GAPS_REQUIRE_REVIEW");
assert.equal(report.required_attribute_count,23);
assert.equal(report.attributes.length,23);
assert.equal(new Set(report.attributes.map(x=>x.attribute)).size,23);
assert.equal(report.required_status_counts.SOURCE_VERIFIED,2);
assert.equal(report.required_status_counts.TRANSFORM_REVIEW,6);
assert.equal(report.required_status_counts.MISSING,15);
assert.equal(byField(report).brand.status,"SOURCE_VERIFIED");
assert.equal(byField(report).item_name.status,"SOURCE_VERIFIED");
for(const name of ["footwear_size","color","model_name","target_gender","style","product_description"])
  assert.equal(byField(report)[name].status,"TRANSFORM_REVIEW",name);
for(const name of ["manufacturer","country_of_origin","sole_material","outer","leather_type","closure","bullet_point"])
  assert.equal(byField(report)[name].status,"MISSING",name);
assert.equal(byField(report).country_of_origin.source_path,null);
assert.equal(report.conditional_requirements.length,1);
assert.equal(report.conditional_requirements[0].status,"CONDITIONAL_UNRESOLVED");
assert.equal(report.ready_for_validation_preview,false);
assert.equal(report.ready_for_publication,false);
assert.equal(report.brand_authorization_proven,false);
assert.equal(report.gpsr_compliance_proven,false);
assert.equal(report.full_schema_validated,false);
assert.equal(report.schema_checksum_verified,false);
assert.equal(report.provider_mutations,0);
assert.equal(report.values_sent_to_amazon,false);
assert.equal(report.technical_values_inferred,false);
assert.equal(report.read_only,true);
assert.ok(!JSON.stringify(report).includes("Synthetic sample shoe"));
assert.ok(!JSON.stringify(report).includes("Only marketing description"));
assert.deepEqual(gap(product,variant,required,true,true),report,"deterministic result");

const noEvidence=gap({
  status:"ACTIVE",product_type:"Sneakers",vendor:"Brand",title:"Name",
  tags:[],description_html:"",
}, {sku:"EXAMPLE",title:"Default Title",selected_options:[]}, required,true,false);
assert.equal(noEvidence.required_status_counts.SOURCE_VERIFIED,2);
assert.equal(noEvidence.required_status_counts.TRANSFORM_REVIEW,0);
assert.equal(noEvidence.required_status_counts.MISSING,21);
assert.equal(noEvidence.conditional_requirements.length,0);

for(const [p,v,fields,declared,reason] of [
  [product,variant,[],true,"required_attributes_invalid_or_empty"],
  [product,variant,["brand","brand"],true,"required_attributes_invalid_or_empty"],
  [product,variant,["brand","__proto__"],true,"required_attributes_invalid_or_empty"],
  [product,variant,required,false,"static_required_not_declared"],
  [{...product,status:"DRAFT"},variant,required,true,"shopify_sneaker_evidence_unverified"],
  [{...product,product_type:"Hats"},variant,required,true,"shopify_sneaker_evidence_unverified"],
  [product,{...variant,sku:""},required,true,"shopify_sneaker_evidence_unverified"],
]){
  const blocked=gap(p,v,fields,declared,true);
  assert.equal(blocked.report_status,"BLOCKED_SCHEMA_UNVERIFIED");
  assert.equal(blocked.reason,reason);
  assert.equal(blocked.ready_for_validation_preview,false);
  assert.equal(blocked.ready_for_publication,false);
  assert.equal(blocked.provider_mutations,0);
  assert.equal(blocked.conditional_requirements[0].status,"CONDITIONAL_UNRESOLVED");
}
const extra=gap(product,variant,[...required,"compliance_custom_future_field"],true,true);
assert.equal(extra.required_attribute_count,24);
assert.equal(byField(extra).compliance_custom_future_field.status,"MISSING");


const proKeds = {
  status:"ACTIVE",product_type:"Sneakers",vendor:"Pro-Keds",
  title:"Royal Classic Tundra/Ivory",tags:["COL:Sneakers","FW26"],
  description_html:[
    "<p>Marketing copy, not a manufacturer certificate</p>",
    "<ul><li><strong>Modello:</strong> Royal Classic</li>",
    "<li><strong>Genere:</strong> Uomo</li>",
    "<li><strong>Colore:</strong> Tundra/Ivory</li>",
    "<li><strong>Tomaia:</strong> 83% suede, 17% pelle</li>",
    "<li><strong>Suola:</strong> 100% gomma</li>",
    "<li><strong>Codice modello:</strong> RC426SLM</li></ul>",
  ].join(""),
};
const proReport=gap(proKeds,variant,required,true,true);
assert.deepEqual(proReport.required_status_counts,{
  SOURCE_VERIFIED:2,TRANSFORM_REVIEW:8,MISSING:13,
});
assert.equal(proReport.description_review_candidate_count,6);
assert.equal(proReport.description_evidence_not_manufacturer_verified,true);
for(const field of ["model_name","target_gender","color","outer","sole_material","model_number"]){
  const located=byField(proReport)[field];
  assert.equal(located.status,"TRANSFORM_REVIEW",field);
  assert.ok(located.source_path.startsWith("product.description_html:label:"),field);
}
for(const field of ["manufacturer","country_of_origin","inner","leather_type"])
  assert.equal(byField(proReport)[field].status,"MISSING",field);
assert.equal(proReport.ready_for_publication,false);
assert.equal(proReport.ready_for_validation_preview,false);
assert.equal(proReport.provider_mutations,0);
assert.equal(JSON.stringify(proReport).includes("Tundra/Ivory"),false);
assert.equal(JSON.stringify(proReport).includes("RC426SLM"),false);

const fessura = {...proKeds,vendor:"Fessura",title:"Trail Sbl Land Violet Lime",
  description_html:"<p>• Tomaia in mesh e rinforzi in gomma</p><p>• Battistrada in gomma</p>"};
const fessuraReport=gap(fessura,variant,required,true,true);
assert.deepEqual(fessuraReport.required_status_counts,{
  SOURCE_VERIFIED:2,TRANSFORM_REVIEW:3,MISSING:18,
});
assert.equal(byField(fessuraReport).outer.source_path,"product.description_html:bullet:tomaia");
assert.equal(byField(fessuraReport).sole_material.status,"MISSING",
  "Tread material alone must not prove full sole composition");

const untrusted = {...proKeds,description_html:
  "<script><strong>Suola:</strong> gomma</script>"+
  "<!-- <strong>Paese di origine:</strong> Italia -->"+
  "<strong>Colore:</strong> n/a "+
  "<style><strong>Produttore:</strong> Example</style>"};
const untrustedReport=gap(untrusted,variant,required,true,true);
for(const field of ["sole_material","country_of_origin","color","manufacturer"])
  assert.equal(byField(untrustedReport)[field].status,"MISSING",field);
assert.equal(untrustedReport.description_review_candidate_count,0);

const longMarkup={...proKeds,description_html:"a".repeat(24001)+proKeds.description_html};
const oversized=gap(longMarkup,variant,required,true,true);
assert.equal(oversized.description_review_candidate_count,0);
assert.equal(byField(oversized).outer.status,"MISSING");

const misleading={...proKeds, description_html:
  "<p>Sola suola in gomma secondo uno slogan pubblicitario</p>"+
  "<p><strong>Suola:</strong> non disponibile</p>"};
assert.equal(byField(gap(misleading,variant,required,true,true)).sole_material.status,"MISSING");
const descriptionSource=readFileSync("src/marketplace-amazon-shoes-description-evidence.ts","utf8");
assert.equal(/\b(?:fetch|XMLHttpRequest|putListing|submitFeed)\s*\(/.test(descriptionSource),false);
assert.equal(/method\s*:\s*["'](?:PUT|PATCH|POST|DELETE)/.test(descriptionSource),false);

const src=readFileSync("src/marketplace-amazon-shoes-gap-report.ts","utf8");
assert.equal(/\b(?:fetch|XMLHttpRequest|putListing|submitFeed)\s*\(/.test(src),false);
assert.equal(/method\s*:\s*["'](?:PUT|PATCH|POST|DELETE)/.test(src),false);
console.log("Amazon SHOES PTD evidence gap report safety tests passed.");
