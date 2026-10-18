import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";

/**
 * Read-only SP-API Listings Items status (GET), independent of the reports
 * download endpoint. This can unblock seller-SKU checks when seller report
 * downloads fail. It is NOT a Channable feed exclusion/ownership guarantee.
 * All ambiguous outcomes are UNKNOWN, never "missing".
 */
type Row=Record<string,unknown>;
type Env=AmazonCredentials&{AMAZON_SP_API_SELLER_ID?:string};
type Market=keyof typeof AMAZON_EU_MARKETPLACES;
const HOST="https://sellingpartnerapi-eu.amazon.com";
const SELLER_RE=/^[A-Z0-9]{8,30}$/;
const SKU_RE=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const MAX_SKUS=8;
function dict(v:unknown):Row {
  return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};
}
function val(v:unknown):string {return typeof v==="string"?v:"";}
function requestId(resp:Response):string|null {
  const raw=resp.headers.get("x-amzn-requestid")||
    resp.headers.get("x-amzn-request-id")||"";
  return /^[A-Za-z0-9-]{6,128}$/.test(raw)?raw:null;
}
type Entry={
  sku:string;
  state:"PRESENT"|"PRESENT_ATTRIBUTES_UNKNOWN"|"VERIFIED_ABSENT"|"UNKNOWN";
  reason:string;
  request_id:string|null;
  asin?:string|null;
  product_type?:string|null;
  statuses?:string[];
  reported_offer_count?:number;
  listing_issues_count?:number;
  issue_signals?:Array<{code:string;severity:string;categories:string[];attribute_names:string[]}>;
  issue_signals_truncated?:boolean;
};
/**
 * Merchant-safe diagnostics: Amazon issue messages can contain product or
 * account data. Expose only bounded, grammar-restricted codes/categories,
 * severities and attribute paths. Do not return raw issue messages.
 */
function safeIssues(raw:unknown,marketplaceId:string):{
  issues:Array<{code:string;severity:string;categories:string[];attribute_names:string[]}>;
  count:number;truncated:boolean;
}{
  if(!Array.isArray(raw))return {issues:[],count:0,truncated:false};
  const issues=raw.map(dict).filter(x=>
    !x.marketplaceId||x.marketplaceId===marketplaceId);
  const atom=(v:unknown,len:number):string=>
    typeof v==="string"&&v.length<=len&&
    /^[A-Za-z0-9_./:-]+$/.test(v)?v:"UNVERIFIED";
  const many=(v:unknown,len:number):string[]=>
    Array.isArray(v)?v.slice(0,8).map(x=>atom(x,len)):[];
  return {
    issues:issues.slice(0,32).map(issue=>({
      code:atom(issue.code,72),
      severity:atom(issue.severity,24),
      categories:many(issue.categories,72),
      attribute_names:many(issue.attributeNames,120)
    })),
    count:issues.length,
    truncated:issues.length>32
  };
}
function classify(
  sku:string, marketplaceId:string, status:number,
  body:Row|null,reqId:string|null,jsonValid:boolean
):Entry {
  if(status===404){
    const errors=body?.errors;
    if(jsonValid&&reqId&&Array.isArray(errors)&&errors.length===1&&
       ["NOT_FOUND","NotFound"].includes(val(dict(errors[0]).code)))
      return {sku,state:"VERIFIED_ABSENT",reason:"listings_item_404_with_verified_not_found",request_id:reqId};
    return {sku,state:"UNKNOWN",reason:"ambiguous_404_not_absence_proof",request_id:reqId};
  }
  if(status!==200)
    return {sku,state:"UNKNOWN",reason:"amazon_http_"+status,request_id:reqId};
  if(!jsonValid||body?.sku!==sku)
    return {sku,state:"UNKNOWN",reason:"listing_response_sku_or_json_mismatch",request_id:reqId};

  const summaries=Array.isArray(body.summaries)?body.summaries:[];
  const relevant=summaries.map(dict).filter(s=>s.marketplaceId===marketplaceId);
  if(relevant.length>1)
    return {sku,state:"UNKNOWN",reason:"listing_has_multiple_market_summaries",request_id:reqId};
  const items=relevant[0]??null;
  const statuses=Array.isArray(items?.status)?
    items.status.filter(s=>typeof s==="string"&&s.length<90) as string[]:[];
  const prices=Array.isArray(body.offers)?body.offers.map(dict).filter(x=>x.marketplaceId===marketplaceId):[];
  const issueData=safeIssues(body.issues,marketplaceId);
  return {
    sku,
    state:items?"PRESENT":"PRESENT_ATTRIBUTES_UNKNOWN",
    reason:items?"seller_listing_found":"listing_exists_but_requested_market_summary_not_returned",
    request_id:reqId,
    asin:typeof items?.asin==="string"?items.asin:null,
    product_type:typeof items?.productType==="string"?items.productType:null,
    statuses,
    reported_offer_count:prices.length,
    listing_issues_count:issueData.count,
    issue_signals:issueData.issues,
    issue_signals_truncated:issueData.truncated
  };
}

export async function readAmazonSellerListingsDirect(
  input:Row,env:Env
):Promise<Row> {
  const market=val(input.marketplace);
  const skus=input.skus;
  if(!Object.hasOwn(AMAZON_EU_MARKETPLACES,market)||
     !Array.isArray(skus)||skus.length<1||skus.length>MAX_SKUS||
     new Set(skus).size!==skus.length||
     skus.some(s=>typeof s!=="string"||!SKU_RE.test(s)||s!==s.trim())||
     Object.keys(input).some(k=>!["marketplace","skus"].includes(k)))
    throw new Error("amazon_seller_listings_direct_invalid_request");
  const sellerId=val(env.AMAZON_SP_API_SELLER_ID);
  if(!SELLER_RE.test(sellerId))
    return {ok:false,status:"BLOCKED_SELLER_CONFIG",read_only:true,
      marketplace:market,results:[],seller_id_configured:false,
      blocker:"AMAZON_SP_API_SELLER_ID_missing_or_invalid"};
  const marketplaceId=AMAZON_EU_MARKETPLACES[market as Market];
  const token=await getAmazonAccessToken(env);
  const results:Entry[]=[];
  for(const sku of skus as string[]){
    const url=new URL(HOST+"/listings/2021-08-01/items/"+
      encodeURIComponent(sellerId)+"/"+encodeURIComponent(sku));
    url.searchParams.set("marketplaceIds",marketplaceId);
    url.searchParams.set("includedData","summaries,offers,issues");
    let response:Response;
    try {
      response=await fetch(url.toString(),{
        method:"GET",
        headers:{"x-amz-access-token":token,Accept:"application/json"},
        signal:AbortSignal.timeout(20000),redirect:"manual"
      });
    }catch (error) {
      // Never return exception text: it could contain URLs or account data.
      const kind=error instanceof Error ? error.name : "Unknown";
      const reason=kind==="TimeoutError"||kind==="AbortError" ?
        "amazon_transport_timeout" : kind==="TypeError" ?
        "amazon_transport_type_error" : "amazon_transport_other";
      results.push({sku,state:"UNKNOWN",reason,request_id:null});
      continue;
    }
    const reqId=requestId(response);
    let body:Row|null=null,jsonValid=false;
    try {
      const type=response.headers.get("content-type")||"";
      if(type.includes("json")){
        const parsed=await response.json();
        if(parsed!==null&&typeof parsed==="object"&&!Array.isArray(parsed)){
          body=dict(parsed);jsonValid=true;
        }
      }
    }catch{ /* Ambiguous, never classified absent. */ }
    results.push(classify(sku,marketplaceId,response.status,body,reqId,jsonValid));
  }
  const present=results.filter(x=>x.state==="PRESENT"||x.state==="PRESENT_ATTRIBUTES_UNKNOWN").length;
  const absent=results.filter(x=>x.state==="VERIFIED_ABSENT").length;
  const unknown=results.length-present-absent;
  return {
    ok:true,source:"amazon_sp_api_get_listings_item",
    marketplace:market,marketplace_id:marketplaceId,
    read_only:true,report_download_dependency:false,
    requested_skus:skus.length,present,verified_absent:absent,unknown,
    complete_evidence:unknown===0,
    results,has_created_or_updated_offer:false,
    can_publish:false,
    must_verify_channable_writer_ownership:true
  };
}
