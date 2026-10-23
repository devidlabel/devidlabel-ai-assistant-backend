import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { researchAmazonNewAsinProductType } from "./marketplace-amazon-new-asin-research.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/** Strict bounded accessory catalog diagnostic. This service has no publishing mode. */
type Row=Record<string,unknown>;
type Market=keyof typeof AMAZON_EU_MARKETPLACES;
type Env=AmazonCredentials & MareBusinessShopifyEnv & {
  AMAZON_SP_API_SELLER_ID?:string;AMAZON_OFFER_PREVIEW_ENABLED?:string;
};
type Deps={research?:typeof researchAmazonNewAsinProductType;
  getAccessToken?:typeof getAmazonAccessToken;fetch?:typeof fetch};
const PRODUCT_TYPES=new Set(["KEYCHAIN","SUITCASE","BACKPACK"]);
const MARKET_LOCALE:Record<Market,string>={IT:"it_IT",DE:"de_DE",FR:"fr_FR",ES:"es_ES"};
const SKU=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const UPC=/^\d{12}$/;
const SELLER=/^[A-Z0-9]{8,30}$/;
const REF=/^[A-Za-z0-9._:-]{1,128}$/;
const ISSUE_CODE=/^[A-Za-z0-9_.-]{1,64}$/;
const FIELD=/^[a-z][a-z0-9_]{0,119}$/;
const MAX_BYTES=128000;
function obj(v:unknown):Row{return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};}
function upcValid(s:string):boolean{
  if(!UPC.test(s))return false;
  let total=0;for(let i=0;i<11;i++)total+=Number(s[i])*(i%2===0?3:1);
  return (10-total%10)%10===Number(s[11]);
}
function blocked(marketplace:string,sku:string,productType:string,reason:string):Row{
  return {ok:false,status:"BLOCKED_PREVIEW",marketplace,sku,product_type:productType,reason,
    preview_only:true,provider_mutations:0,product_created:false,can_publish:false,
    listing_write_enabled:false,channable_handoff_performed:false,
    brand_authorization_proven:false,gpsr_compliance_proven:false,
    full_schema_validated:false};
}
export async function previewAmazonAccessoryUpcValidation(
  raw:unknown,env:Env,deps:Deps={},
):Promise<Row>{
  const arg=obj(raw);
  if(Object.keys(arg).length!==3||
     typeof arg.marketplace!=="string"||
     !Object.hasOwn(AMAZON_EU_MARKETPLACES,arg.marketplace)||
     typeof arg.sku!=="string"||!SKU.test(arg.sku)||arg.sku!==arg.sku.trim()||
     typeof arg.product_type!=="string"||!PRODUCT_TYPES.has(arg.product_type))
    throw new Error("amazon_accessory_preview_invalid_request");
  const marketplace=arg.marketplace as Market,sku=arg.sku,pt=arg.product_type;
  if(env.AMAZON_OFFER_PREVIEW_ENABLED!=="true")
    return blocked(marketplace,sku,pt,"amazon_validation_preview_disabled");
  if(typeof env.AMAZON_SP_API_SELLER_ID!=="string"||!SELLER.test(env.AMAZON_SP_API_SELLER_ID))
    return blocked(marketplace,sku,pt,"seller_identity_not_verified");
  let research:Row;
  try{research=obj(await(deps.research??researchAmazonNewAsinProductType)(
    {marketplace,sku,product_type:pt},env));}
  catch{return blocked(marketplace,sku,pt,"read_only_research_failed");}
  const shop=obj(research.shopify),upc=shop.upc,title=shop.product_title,brand=shop.amazon_listing_brand;
  if(research.ok!==true||research.status!=="REQUIREMENTS_REVIEW_REQUIRED"||
     research.marketplace!==marketplace||research.sku!==sku||research.product_type!==pt||
     research.seller_listing_state!=="VERIFIED_ABSENT"||
     research.upc_match_state!=="NO_EXACT_MATCH"||
     research.upc_absence_not_catalog_absence_proof!==true||
     research.read_only!==true||research.provider_mutations!==0||
     research.can_publish!==false||research.product_payload_constructed!==false||
     research.validation_preview_sent!==false||
     research.schema_enforced!==true||research.schema_requirements!=="LISTING"||
     research.full_schema_validated!==false||research.brand_authorization_proven!==false||
     research.gpsr_compliance_proven!==false||
     !Array.isArray(research.required_attribute_names)||
     !Array.isArray(research.available_schema_attribute_names)||
     !research.available_schema_attribute_names.includes("externally_assigned_product_identifier")||
     !research.required_attribute_names.includes("item_name")||
     !research.required_attribute_names.includes("brand")||
     research.title_category_conflict_detected===true||
     !upcValid(upc as string)||
     shop.identifier_type!=="UPC"||shop.ean!==null||
     typeof title!=="string"||!title.trim()||title.length>200||
     typeof brand!=="string"||!brand.trim()||brand.length>100||
     !Number.isSafeInteger(shop.shopify_available)||(shop.shopify_available as number)<=0||
     typeof shop.variant_id!=="string"||
     !/^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,24}$/.test(shop.variant_id))
    return blocked(marketplace,sku,pt,"accessory_research_or_identity_unverified");
  const marketId=AMAZON_EU_MARKETPLACES[marketplace];
  const attributes={
    brand:[{value:brand,marketplace_id:marketId}],
    item_name:[{value:title,marketplace_id:marketId,language_tag:MARKET_LOCALE[marketplace]}],
    externally_assigned_product_identifier:[{value:upc,type:"upc",marketplace_id:marketId}],
  };
  let token:string;
  try{token=await(deps.getAccessToken??getAmazonAccessToken)(env);}
  catch{return blocked(marketplace,sku,pt,"amazon_auth_failed");}
  if(typeof token!=="string"||!token||token.length>16384||/[\u0000-\u0020\u007f]/.test(token))
    return blocked(marketplace,sku,pt,"amazon_auth_invalid");
  const url=new URL("https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/"+
    encodeURIComponent(env.AMAZON_SP_API_SELLER_ID)+"/"+encodeURIComponent(sku));
  url.searchParams.set("marketplaceIds",marketId);
  url.searchParams.set("mode","VALIDATION_PREVIEW");
  const signal=AbortSignal.timeout(20000);
  let response:Response;
  try{response=await(deps.fetch??fetch)(url.toString(),{
    method:"PUT",redirect:"manual",signal,
    headers:{"x-amz-access-token":token,"Content-Type":"application/json",Accept:"application/json"},
    body:JSON.stringify({productType:pt,requirements:"LISTING",attributes}),
  });}catch{return blocked(marketplace,sku,pt,"amazon_preview_transport_failed");}
  if(response.status!==200||!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type")??""))
    return blocked(marketplace,sku,pt,"amazon_preview_response_unverified");
  const contentLength=Number(response.headers.get("content-length")||"0");
  if(!Number.isFinite(contentLength)||contentLength>MAX_BYTES)
    return blocked(marketplace,sku,pt,"amazon_preview_body_too_large");
  if(!response.body)return blocked(marketplace,sku,pt,"amazon_preview_body_unreadable");
  const reader=response.body.getReader();
  const decoder=new TextDecoder("utf-8",{fatal:true});let data="",size=0;
  try{for(;;){
    if(signal.aborted)return blocked(marketplace,sku,pt,"amazon_preview_transport_failed");
    const p=await reader.read();if(p.done)break;
    size+=p.value.byteLength;if(size>MAX_BYTES){void reader.cancel().catch(()=>{});return blocked(marketplace,sku,pt,"amazon_preview_body_too_large");}
    data+=decoder.decode(p.value,{stream:true});
  }data+=decoder.decode();}
  catch{return blocked(marketplace,sku,pt,"amazon_preview_body_unreadable");}
  finally{reader.releaseLock();}
  let body:Row;
  try{body=obj(JSON.parse(data));}
  catch{return blocked(marketplace,sku,pt,"amazon_preview_json_invalid");}
  if(body.sku!==sku||(body.status!=="VALID"&&body.status!=="INVALID")||
     typeof body.submissionId!=="string"||!REF.test(body.submissionId))
    return blocked(marketplace,sku,pt,"amazon_preview_response_identity_invalid");
  if(body.issues!==undefined&&!Array.isArray(body.issues))
    return blocked(marketplace,sku,pt,"amazon_preview_issues_invalid");
  const issues=Array.isArray(body.issues)?body.issues:[];
  if(issues.length>80)return blocked(marketplace,sku,pt,"amazon_preview_issues_invalid");
  const sanitized:Array<{code:string;severity:string;attribute_names:string[]}>=[];
  for(const rawIssue of issues){
    const issue=obj(rawIssue);
    if(typeof issue.code!=="string"||!ISSUE_CODE.test(issue.code)||
       !["ERROR","WARNING","INFO"].includes(String(issue.severity))||
       (issue.attributeNames!==undefined&&
        (!Array.isArray(issue.attributeNames)||issue.attributeNames.length>20||
         issue.attributeNames.some(x=>typeof x!=="string"||!FIELD.test(x)))))
      return blocked(marketplace,sku,pt,"amazon_preview_issues_invalid");
    sanitized.push({code:issue.code,severity:issue.severity as string,
      attribute_names:(issue.attributeNames as string[]|undefined)??[]});
  }
  return {ok:true,status:"VALIDATION_ONLY_REVIEW_REQUIRED",marketplace,sku,
    product_type:pt,identifier_type:"UPC",provider_validation_status:body.status,
    preview_submission_reference:body.submissionId,issue_count:sanitized.length,issues:sanitized,
    attributes_submitted:Object.keys(attributes),validation_mode:"VALIDATION_PREVIEW",
    preview_only:true,provider_validation_performed:true,
    product_created:false,can_publish:false,listing_write_enabled:false,provider_mutations:0,
    channable_handoff_performed:false,brand_authorization_proven:false,
    gpsr_compliance_proven:false,full_schema_validated:false,
    storefront_unchanged:true,
    next_step:"REVIEW_AMAZON_ISSUES_AND_AUTHORITATIVE_SUPPLIER_EVIDENCE_BEFORE_ANY_LIVE_CREATION"};
}
