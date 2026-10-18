import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { readAmazonOfferOnlyPreflight } from "./mare-business-amazon-offer-preflight.js";

/**
 * Internal R3 Amazon validation-only prototype.
 * Calls putListingsItem exclusively with mode=VALIDATION_PREVIEW and
 * quantity=0. There is NO LIVE mode, no patch/delete/fulfillment mutation,
 * no exposed Business OS capability and no production enabled flag.
 * Provider schema issues are returned for human review; a VALID preview
 * is NOT a publish permit, listing receipt or ownership handoff.
 */
type Row=Record<string,unknown>;
type Market=keyof typeof AMAZON_EU_MARKETPLACES;
type Env=AmazonCredentials & {
  AMAZON_SP_API_SELLER_ID?:string;
  AMAZON_OFFER_PREVIEW_ENABLED?:string;
  [key:string]:unknown;
};
const HOST="https://sellingpartnerapi-eu.amazon.com";
const SELLER_RE=/^[A-Z0-9]{8,30}$/;
const SKU_RE=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const EAN_RE=/^\d{13}$/;
const ASIN_RE=/^[A-Z0-9]{10}$/;
const CHECKSUM_RE=/^[A-Za-z0-9+/]{20,28}={0,2}$/;
function dict(x:unknown):Row{return x&&typeof x==="object"&&!Array.isArray(x)?x as Row:{};}
function clean(x:unknown):string{return typeof x==="string"?x.trim():"";}
function block(reason:string):Row{
  return {ok:false,status:"BLOCKED_PREVIEW",reason,
    preview_only:true,offer_created:false,listing_write_enabled:false};
}
export async function previewAmazonOfferOnlyZeroQuantity(
  input:Row,env:Env,
  preflightReader:typeof readAmazonOfferOnlyPreflight=readAmazonOfferOnlyPreflight
):Promise<Row>{
  // The installed runtime does not opt in by default. This prevents even
  // validation requests from running unless an operator tests the flag.
  if(env.AMAZON_OFFER_PREVIEW_ENABLED!=="true")
    return block("amazon_validation_preview_disabled");
  if(Object.keys(input).some(k=>!["marketplace","sku","ean","asin"].includes(k)) ||
      typeof input.marketplace!=="string"||
      !Object.hasOwn(AMAZON_EU_MARKETPLACES,input.marketplace)||
      !SKU_RE.test(String(input.sku))||input.sku!==clean(input.sku)||
      !EAN_RE.test(String(input.ean))||
      !ASIN_RE.test(String(input.asin)))
    throw new Error("amazon_offer_preview_invalid_input");
  const marketplace=input.marketplace as Market;
  const sku=String(input.sku),asin=String(input.asin);
  const sellerId=clean(env.AMAZON_SP_API_SELLER_ID);
  if(!SELLER_RE.test(sellerId))return block("amazon_seller_id_missing");
  const pre=dict(await preflightReader(input,env));
  if(pre.ok!==true||pre.status!=="REVIEW_REQUIRED"||
      pre.marketplace!==marketplace||pre.sku!==sku||pre.asin!==asin||
      pre.ean!==input.ean||pre.exact_ean_asin!==true||
      pre.seller_listing_absence_result!=="NOT_FOUND_VERIFIED_BY_LISTINGS_API"||
      pre.seller_asin_search_result!=="NO_SELLER_ASIN_IN_BOUNDED_SEARCH"||
      pre.seller_asin_search_is_not_final_absence_proof!==true||
      pre.schema_product_type!=="PRODUCT"||
      pre.schema_requirements!=="LISTING_OFFER_ONLY"||
      typeof pre.schema_version!=="string"||!pre.schema_version||
      typeof pre.schema_checksum!=="string"||!CHECKSUM_RE.test(pre.schema_checksum)||
      pre.shopify_currency!=="EUR"||
      typeof pre.shopify_price_minor!=="number"||
      !Number.isSafeInteger(pre.shopify_price_minor)||pre.shopify_price_minor<1||
      pre.shopify_price_minor>100_000_000)
    return block("preflight_or_schema_evidence_unverified");

  const marketId=AMAZON_EU_MARKETPLACES[marketplace];
  const attributes={
    merchant_suggested_asin:[{value:asin,marketplace_id:marketId}],
    condition_type:[{value:"new_new",marketplace_id:marketId}],
    fulfillment_availability:[{fulfillment_channel_code:"DEFAULT",
      quantity:0,marketplace_id:marketId}],
    purchasable_offer:[{currency:"EUR",
      our_price:[{schedule:[{value_with_tax:pre.shopify_price_minor/100}]}],
      marketplace_id:marketId}]
  };
  const body={productType:"PRODUCT",requirements:"LISTING_OFFER_ONLY",attributes};
  const url=new URL(HOST+"/listings/2021-08-01/items/"+
    encodeURIComponent(sellerId)+"/"+encodeURIComponent(sku));
  url.searchParams.set("marketplaceIds",marketId);
  // Fixed in source; no caller-supplied mode, quantity or arbitrary payload.
  url.searchParams.set("mode","VALIDATION_PREVIEW");
  const token=await getAmazonAccessToken(env);
  let response:Response;
  try{
    response=await fetch(url.toString(),{
      method:"PUT",headers:{"x-amz-access-token":token,
        "Content-Type":"application/json",Accept:"application/json"},
      body:JSON.stringify(body),signal:AbortSignal.timeout(20000),
      redirect:"error"
    });
  }catch{throw new Error("amazon_offer_preview_network_error")}
  if(!response.ok)throw new Error("amazon_offer_preview_http_"+response.status);
  let data:Row;
  try{data=dict(await response.json())}
  catch{throw new Error("amazon_offer_preview_invalid_json")}
  if(data.sku!==sku||!["VALID","INVALID"].includes(String(data.status))||
      typeof data.submissionId!=="string"||!data.submissionId||
      data.issues!==undefined&&!Array.isArray(data.issues))
    throw new Error("amazon_offer_preview_unexpected_response");
  const issues=Array.isArray(data.issues)?data.issues.map(i=>{
    const row=dict(i);
    return {code:clean(row.code).slice(0,90)||"UNKNOWN",
      severity:clean(row.severity).slice(0,40)||"UNVERIFIED"};
  }):[];
  return {
    ok:true,marketplace,sku,asin,status:"PREVIEW_REVIEW_REQUIRED",
    amazon_preview_status:data.status,
    preview_issues:issues,issue_count:issues.length,
    validation_mode:"VALIDATION_PREVIEW",
    offer_quantity_submitted:0,
    schema_product_type:"PRODUCT",
    schema_version:pre.schema_version,
    submission_reference:String(data.submissionId).slice(0,160),
    preview_only:true,offer_created:false,listing_write_enabled:false,
    can_publish:false,
    next_step:"REVIEW_SCHEMA_ISSUES_ATTRIBUTES_GPSR_AND_PROVE_CHANNABLE_ORDER_AND_STOCK_CUTOVER"
  };
}
