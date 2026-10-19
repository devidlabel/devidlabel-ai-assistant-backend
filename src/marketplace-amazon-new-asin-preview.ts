import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { researchAmazonNewAsinProductType } from "./marketplace-amazon-new-asin-research.js";
import { readAmazonShoesPrivateShopifyValues } from "./marketplace-amazon-shoes-private-shopify-values.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/**
 * Zero-persistence Amazon LISTING / SHOES validation probe.
 * Never sends a live listing: mode is fixed VALIDATION_PREVIEW, with no
 * inventory, price, fulfillment or merchant-supplied attributes in the body.
 * The intentionally sparse draft is for missing-field diagnostics only.
 * A VALID result is NOT evidence of publish-readiness, GPSR or authorization.
 */
type Row = Record<string,unknown>;
type Env = AmazonCredentials & MareBusinessShopifyEnv & {
  AMAZON_SP_API_SELLER_ID?: string; AMAZON_OFFER_PREVIEW_ENABLED?:string;
};
export type NewAsinPreviewDeps = {
  research?: typeof researchAmazonNewAsinProductType;
  readPrivateFields?: typeof readAmazonShoesPrivateShopifyValues;
  getAccessToken?: typeof getAmazonAccessToken;
  fetch?: typeof fetch;
};
const HOST="https://sellingpartnerapi-eu.amazon.com";
const SKU=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const SELLER=/^[A-Z0-9]{8,30}$/;
const EAN=/^\d{13}$/;
const LOCALES={IT:"it_IT",DE:"de_DE",FR:"fr_FR",ES:"es_ES"} as const;
const REF=/^[A-Za-z0-9._:-]{1,128}$/;
const ATTR=/^[a-z][a-z0-9_]{0,119}$/;
const CODE=/^[A-Za-z0-9_.-]{1,64}$/;
const MAX_BODY=128_000;
function obj(x:unknown):Row{return x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Row:{};}
function eanOk(x:string):boolean{
  if(!EAN.test(x))return false;
  let sum=0;for(let i=0;i<12;i++)sum+=Number(x[i])*(i%2?3:1);
  return (10-sum%10)%10===Number(x[12]);
}
function blocked(marketplace:string,sku:string,reason:string):Row{return {
  ok:false,status:"BLOCKED_PREVIEW",marketplace,sku,reason,
  preview_only:true,product_created:false,can_publish:false,
  provider_mutations:0,listing_write_enabled:false,
  channable_handoff_performed:false,
  brand_authorization_proven:false,gpsr_compliance_proven:false,
  full_schema_validated:false,
};}
export async function previewAmazonNewAsinShoesValidation(
  rawInput:unknown,env:Env,deps:NewAsinPreviewDeps={},
):Promise<Row>{
  const input=obj(rawInput);
  if(Object.keys(input).length!==2||
    typeof input.marketplace!=="string"||!Object.hasOwn(AMAZON_EU_MARKETPLACES,input.marketplace)||
    typeof input.sku!=="string"||!SKU.test(input.sku)||input.sku!==input.sku.trim())
    throw new Error("amazon_new_asin_preview_invalid_request");
  const marketplace=input.marketplace as keyof typeof AMAZON_EU_MARKETPLACES,sku=input.sku;
  if(env.AMAZON_OFFER_PREVIEW_ENABLED!=="true")
    return blocked(marketplace,sku,"amazon_validation_preview_disabled");
  if(typeof env.AMAZON_SP_API_SELLER_ID!=="string"||
     !SELLER.test(env.AMAZON_SP_API_SELLER_ID))
    return blocked(marketplace,sku,"seller_identity_not_verified");
  let research:Row;
  try{research=obj(await(deps.research??researchAmazonNewAsinProductType)(
    {marketplace,sku,product_type:"SHOES"},env));}
  catch{return blocked(marketplace,sku,"read_only_research_failed");}
  const shop=obj(research.shopify);
  const brand=shop.amazon_listing_brand,title=shop.product_title,ean=shop.ean;
  if(research.ok!==true||research.status!=="REQUIREMENTS_REVIEW_REQUIRED"||
     research.marketplace!==marketplace||research.sku!==sku||
     research.product_type!=="SHOES"||
     research.seller_listing_state!=="VERIFIED_ABSENT"||
     research.ean_match_state!=="NO_EXACT_MATCH"||
     research.ean_absence_not_catalog_absence_proof!==true||
     research.provider_mutations!==0||research.read_only!==true||
     research.product_payload_constructed!==false||
     research.validation_preview_sent!==false||research.can_publish!==false||
     typeof brand!=="string"||!brand.trim()||brand.length>100||
     typeof title!=="string"||!title.trim()||title.length>200||
     typeof ean!=="string"||!eanOk(ean)||
     research.schema_enforced!==true||research.schema_requirements!=="LISTING"||
     obj(research.attribute_gap_report).report_status!=="GAPS_REQUIRE_REVIEW"||
     !Array.isArray(research.required_attribute_names)||
     !research.required_attribute_names.includes("model_name")||
     !research.required_attribute_names.includes("color"))
    return blocked(marketplace,sku,"read_only_research_or_listing_identity_unverified");
  const evidence:Row=await (deps.readPrivateFields??readAmazonShoesPrivateShopifyValues)({
    sku,variantId:shop.variant_id as string,productTitle:title,
    shopifyVendor:shop.brand as string,amazonBrand:brand,
  },env).catch(():Row=>({ok:false,reason:"private_shopify_read_failed"}));
  if(evidence.ok!==true||evidence.draft_values_review_only!==true||
     evidence.public_storefront_access_used!==false||
     evidence.ready_for_publication!==false||
     typeof evidence.model_name!=="string"||typeof evidence.color!=="string")
    return blocked(marketplace,sku,"shopify_private_fields_not_verified");
  // Important: this intentionally does NOT infer materials, manufacturer,
  // origin, brand permissions, GPSR or full PTD conditional requirements.
  const marketId=AMAZON_EU_MARKETPLACES[marketplace],locale=LOCALES[marketplace];
  const payload={productType:"SHOES",requirements:"LISTING",attributes:{
    brand:[{value:brand,marketplace_id:marketId}],
    item_name:[{value:title,language_tag:locale,marketplace_id:marketId}],
    externally_assigned_product_identifier:[{value:ean,type:"ean",marketplace_id:marketId}],
    model_name:[{value:evidence.model_name,marketplace_id:marketId}],
    color:[{value:evidence.color,marketplace_id:marketId}],
  }};
  let token:string;
  try{token=await(deps.getAccessToken??getAmazonAccessToken)(env);}
  catch{return blocked(marketplace,sku,"amazon_auth_failed");}
  if(typeof token!=="string"||!token.trim()||token.length>16384||/[\u0000-\u0020\u007f]/.test(token))
    return blocked(marketplace,sku,"amazon_auth_invalid");
  const url=new URL(HOST+"/listings/2021-08-01/items/"+
    encodeURIComponent(env.AMAZON_SP_API_SELLER_ID)+"/"+encodeURIComponent(sku));
  url.searchParams.set("marketplaceIds",marketId);
  url.searchParams.set("mode","VALIDATION_PREVIEW");
  const signal=AbortSignal.timeout(20000);
  let res:Response;
  try{res=await(deps.fetch??fetch)(url.toString(),{
    method:"PUT",redirect:"manual",signal,
    headers:{"x-amz-access-token":token,"Content-Type":"application/json",Accept:"application/json"},
    body:JSON.stringify(payload),
  });}
  catch{return blocked(marketplace,sku,"amazon_preview_transport_failed");}
  if(res.status!==200||!/^application\/json(?:\s*;|$)/i.test(res.headers.get("content-type")||""))
    return blocked(marketplace,sku,"amazon_preview_response_unverified");
  const headerLength=Number(res.headers.get("content-length")||0);
  if(!Number.isFinite(headerLength)||headerLength>MAX_BODY)
    return blocked(marketplace,sku,"amazon_preview_body_too_large");
  let raw="";
  const reader=res.body?.getReader();
  if(!reader)return blocked(marketplace,sku,"amazon_preview_body_unreadable");
  let bytes=0;
  try{
    const decoder=new TextDecoder("utf-8",{fatal:true});
    for(;;){
      if(signal.aborted)return blocked(marketplace,sku,"amazon_preview_transport_failed");
      const part=await reader.read();
      if(part.done)break;
      bytes+=part.value.byteLength;
      if(bytes>MAX_BODY){
        void reader.cancel().catch(()=>{});
        return blocked(marketplace,sku,"amazon_preview_body_too_large");
      }
      raw+=decoder.decode(part.value,{stream:true});
    }
    raw+=decoder.decode();
  }catch{return blocked(marketplace,sku,"amazon_preview_body_unreadable");}
  finally{reader.releaseLock();}
  let response:Row;
  try{response=obj(JSON.parse(raw));}
  catch{return blocked(marketplace,sku,"amazon_preview_json_invalid");}
  if(response.sku!==sku||(response.status!=="VALID"&&response.status!=="INVALID")||
     typeof response.submissionId!=="string"||!REF.test(response.submissionId))
    return blocked(marketplace,sku,"amazon_preview_response_identity_invalid");
  if(response.issues!==undefined&&!Array.isArray(response.issues))
    return blocked(marketplace,sku,"amazon_preview_issues_invalid");
  const issues=Array.isArray(response.issues)?response.issues:[];
  if(issues.length>80)return blocked(marketplace,sku,"amazon_preview_issues_invalid");
  const sanitized=[];
  for(const rawIssue of issues){
    const issue=obj(rawIssue);
    if(typeof issue.code!=="string"||!CODE.test(issue.code)||
       !["ERROR","WARNING","INFO"].includes(String(issue.severity))||
       (issue.attributeNames!==undefined&&
         (!Array.isArray(issue.attributeNames)||issue.attributeNames.length>20||
          issue.attributeNames.some(a=>typeof a!=="string"||!ATTR.test(a)))))
      return blocked(marketplace,sku,"amazon_preview_issues_invalid");
    sanitized.push({code:issue.code,severity:issue.severity,
      attribute_names:issue.attributeNames||[]});
  }
  return {ok:true,status:"VALIDATION_ONLY_REVIEW_REQUIRED",
    marketplace,sku,product_type:"SHOES",
    provider_validation_status:response.status,
    issue_count:sanitized.length,issues:sanitized,
    preview_submission_reference:response.submissionId,
    attributes_submitted:["brand","item_name","externally_assigned_product_identifier","model_name","color"],
    private_shopify_metafields_used:true,private_shopify_values_exported_in_response:false,
    storefront_unchanged:true,
    listing_brand_from_merchant_mapping:obj(research.shopify).amazon_brand_mapping_source,
    // This PUT uses Amazon mode VALIDATION_PREVIEW, never a live listing PUT.
    validation_mode:"VALIDATION_PREVIEW",
    preview_only:true,provider_validation_performed:true,
    product_created:false,can_publish:false,listing_write_enabled:false,
    provider_mutations:0,channable_handoff_performed:false,
    brand_authorization_proven:false,gpsr_compliance_proven:false,
    full_schema_validated:false,
    next_step:"REVIEW_MISSING_ATTRIBUTE_CODES_AND_SUPPLIER_DOCUMENTS_BEFORE_ANY_LIVE_CREATION"};
}
