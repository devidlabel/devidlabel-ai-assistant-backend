import { researchAmazonNewAsinProductType } from "./marketplace-amazon-new-asin-research.js";
import { readShopifySneakerStructuredEvidence } from "./marketplace-shopify-sneaker-structured-evidence.js";

/** Evidence LOCATION reconciliation only. Not a product builder, schema validator or writer. */
type Row = Record<string,unknown>;
type Env = Parameters<typeof researchAmazonNewAsinProductType>[1] &
           Parameters<typeof readShopifySneakerStructuredEvidence>[1];
export type ShoesReadinessDeps = {
  readAmazon?: typeof researchAmazonNewAsinProductType;
  readShopifyEvidence?: typeof readShopifySneakerStructuredEvidence;
};
const MARKETS=new Set(["IT","DE","FR","ES"]);
const SKU_RE=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const FIELD_RE=/^[a-z][a-z0-9_]{0,119}$/;
const SOURCE_RE=/^(?:product|variant)\.[a-z0-9_.-]{1,110}$/;
const STATUSES=new Set(["SOURCE_VERIFIED","TRANSFORM_REVIEW","MISSING"]);
const EVIDENCE_STATES=new Set(["TRANSFORM_REVIEW","REFERENCE_REVIEW"]);
function obj(x:unknown):Row{return x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Row:{};}
function blocked(marketplace:string,sku:string,reason:string):Row{
  return {ok:false,status:"BLOCKED",marketplace,sku,blocker:reason,
    ready_for_validation_preview:false,ready_for_publication:false,
    can_publish:false,can_transfer_writer_ownership:false,
    gpsr_compliance_proven:false,brand_authorization_proven:false,
    full_schema_validated:false,values_exported:false,
    provider_mutations:0,read_only:true};
}
function validRow(x:unknown):x is Row{return x!==null&&typeof x==="object"&&!Array.isArray(x);}
export function reconcileAmazonShoesEvidence(rawAmazon:unknown,rawShopify:unknown,
  marketplace:string,sku:string):Row{
  const amazon=obj(rawAmazon),shopify=obj(rawShopify);
  if(amazon.ok!==true||amazon.status!=="REQUIREMENTS_REVIEW_REQUIRED"||
     amazon.marketplace!==marketplace||amazon.sku!==sku||
     amazon.product_type!=="SHOES"||
     amazon.seller_listing_state!=="VERIFIED_ABSENT"||
     amazon.ean_match_state!=="NO_EXACT_MATCH"||
     amazon.ean_absence_not_catalog_absence_proof!==true||
     amazon.read_only!==true||amazon.provider_mutations!==0||
     amazon.can_publish!==false||amazon.product_payload_constructed!==false||
     amazon.validation_preview_sent!==false)
    return blocked(marketplace,sku,"amazon_ptd_or_identity_not_safe");
  if(shopify.ok!==true||shopify.status!=="STRUCTURED_EVIDENCE_REVIEW_REQUIRED"||
     shopify.sku!==sku||shopify.shopify_state!=="ACTIVE_IN_STOCK"||
     shopify.read_only!==true||shopify.provider_mutations!==0||
     shopify.values_exported!==false||shopify.manufacturer_verified!==false||
     shopify.reference_values_resolved!==false)
    return blocked(marketplace,sku,"shopify_evidence_not_safe");
  const gap=obj(amazon.attribute_gap_report);
  if(gap.report_status!=="GAPS_REQUIRE_REVIEW"||gap.product_type!=="SHOES"||
     gap.read_only!==true||gap.provider_mutations!==0||
     gap.ready_for_validation_preview!==false||gap.ready_for_publication!==false||
     gap.brand_authorization_proven!==false||gap.gpsr_compliance_proven!==false||
     !Array.isArray(gap.attributes)||gap.attributes.length===0||
     gap.attributes.length>1000||gap.required_attribute_count!==gap.attributes.length||
     !Array.isArray(amazon.required_attribute_names)||
     amazon.required_attribute_names.length!==gap.attributes.length||
     !Array.isArray(shopify.fields)||shopify.fields.length>32||
     !Array.isArray(gap.conditional_requirements))
    return blocked(marketplace,sku,"attribute_gap_report_invalid");
  const attr:Map<string,string>=new Map();
  for(const raw of gap.attributes){
    if(!validRow(raw)||typeof raw.attribute!=="string"||!FIELD_RE.test(raw.attribute)||
       typeof raw.status!=="string"||!STATUSES.has(raw.status)||
       attr.has(raw.attribute))return blocked(marketplace,sku,"attribute_gap_structure_invalid");
    attr.set(raw.attribute,raw.status);
  }
  const names=amazon.required_attribute_names;
  if(new Set(names).size!==names.length||names.some(n=>typeof n!=="string"||!attr.has(n)))
    return blocked(marketplace,sku,"required_attribute_identity_mismatch");
  const count=obj(gap.required_status_counts);
  for(const status of STATUSES){
    if(count[status]!==Array.from(attr.values()).filter(s=>s===status).length)
      return blocked(marketplace,sku,"attribute_gap_count_inconsistent");
  }
  const sources=new Map<string,Set<string>>();
  for(const raw of shopify.fields){
    if(!validRow(raw)||typeof raw.shopify_path!=="string"||
       !SOURCE_RE.test(raw.shopify_path)||typeof raw.evidence_state!=="string"||
       !EVIDENCE_STATES.has(raw.evidence_state)||raw.manufacturer_verified!==false)
      return blocked(marketplace,sku,"shopify_source_structure_unverified");
    const field=raw.amazon_attribute_candidate;
    if(field===null)continue;
    if(typeof field!=="string"||!FIELD_RE.test(field))
      return blocked(marketplace,sku,"shopify_field_mapping_invalid");
    if(!attr.has(field))continue;
    const current=sources.get(field)||new Set<string>();
    current.add(raw.shopify_path);
    sources.set(field,current);
  }
  // Neither Shopify-derived data nor unresolved references ever change a PTD
  // MISSING/REVIEW status. Return only where human review could look next.
  const newlyLocated=[...sources.entries()].filter(([field])=>attr.get(field)==="MISSING")
    .sort(([a],[b])=>a.localeCompare(b))
    .map(([attribute,paths])=>({
      attribute,shopify_paths:[...paths].sort(),evidence_state:"REVIEW_ONLY_SOURCE_HINT",
      amazon_original_status:"MISSING",manufacturer_verified:false,
    }));
  const alreadyReview=[...sources.keys()].filter(field=>attr.get(field)==="TRANSFORM_REVIEW").sort();
  const stillMissing=[...attr.entries()].filter(([,s])=>s==="MISSING")
    .map(([name])=>name).sort();
  const withoutHints=stillMissing.filter(name=>!sources.has(name));
  return {ok:true,status:"DOCUMENTATION_AND_SCHEMA_GATES_OPEN",
    marketplace,sku,product_type:"SHOES",
    static_required_attribute_count:attr.size,
    original_ptd_status_counts:{
      SOURCE_VERIFIED:count.SOURCE_VERIFIED,
      TRANSFORM_REVIEW:count.TRANSFORM_REVIEW,
      MISSING:count.MISSING,
    },
    original_missing_attributes:stillMissing,
    missing_with_new_shopify_source_hints:newlyLocated,
    missing_without_structured_source_hints:withoutHints,
    existing_review_attributes_with_structured_hints:alreadyReview,
    missing_source_hint_count:newlyLocated.length,
    missing_without_hint_count:withoutHints.length,
    note:"Source hints never resolve PTD missing fields or prove Amazon accepted values",
    conditional_requirements_unresolved:gap.conditional_requirements.length>0,
    ean_absence_not_catalog_absence_proof:true,
    full_schema_validated:false,schema_checksum_verified:false,
    manufacturer_technical_specifications_verified:false,
    gpsr_compliance_proven:false,brand_authorization_proven:false,
    ready_for_validation_preview:false,ready_for_publication:false,
    can_publish:false,can_transfer_writer_ownership:false,
    values_exported:false,listing_payload_constructed:false,
    provider_mutations:0,read_only:true};
}
export async function readAmazonShoesCrossSourceReadiness(
  rawInput:unknown,env:Env,deps:ShoesReadinessDeps={},
):Promise<Row>{
  const input=obj(rawInput);
  if(Object.keys(input).length!==2||typeof input.marketplace!=="string"||
     !MARKETS.has(input.marketplace)||typeof input.sku!=="string"||
     !SKU_RE.test(input.sku)||input.sku!==input.sku.trim())
    throw new Error("amazon_shoes_readiness_invalid_request");
  const marketplace=input.marketplace,sku=input.sku;
  let amazon:unknown;
  try{amazon=await(deps.readAmazon??researchAmazonNewAsinProductType)(
    {marketplace,sku,product_type:"SHOES"},env);
  }catch{return blocked(marketplace,sku,"amazon_ptd_lookup_failed");}
  // Do not call Shopify if seller listing is present, EAN matched or Amazon
  // could not establish a safe identity.
  const a=obj(amazon);
  if(a.ok!==true||a.status!=="REQUIREMENTS_REVIEW_REQUIRED"||
     a.marketplace!==marketplace||a.sku!==sku||a.seller_listing_state!=="VERIFIED_ABSENT"||
     a.ean_match_state!=="NO_EXACT_MATCH")
    return blocked(marketplace,sku,"amazon_new_asin_research_not_eligible");
  let shopify:unknown;
  try{shopify=await(deps.readShopifyEvidence??readShopifySneakerStructuredEvidence)(
    {sku},env);
  }catch{return blocked(marketplace,sku,"shopify_evidence_lookup_failed");}
  return reconcileAmazonShoesEvidence(amazon,shopify,marketplace,sku);
}
