import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";

/** Merchant-private, read-only evidence for verified existing listing qualification errors.
 * Amazon's restrictions API may disagree with Listings Items issues; an empty
 * restrictions array is NOT approval, buyability or permission to publish.
 * Never sends mutations, starts applications or changes Channable ownership. */
type Row=Record<string,unknown>;
type Market=keyof typeof AMAZON_EU_MARKETPLACES;
type Env=AmazonCredentials & {AMAZON_SP_API_SELLER_ID?:string};
export type QualificationReadDeps={
  readListings?:typeof readAmazonSellerListingsDirect;
  getAccessToken?:typeof getAmazonAccessToken;
  fetch?:typeof fetch;
};
const HOST="https://sellingpartnerapi-eu.amazon.com";
const SKU=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const ASIN=/^[A-Z0-9]{10}$/;
const SELLER=/^[A-Z0-9]{8,30}$/;
const CODE=/^[A-Z0-9_]{1,64}$/;
const QUALIFICATION_CODES=new Set(["100632","18299","18304","18669"]);
const MAX_BYTES=65_536;
const FLAGS={read_only:true,provider_mutations:0,applications_created:0,
  has_created_offer:false,brand_approval_proven:false,can_publish:false,
  channable_handoff_performed:false} as const;
function obj(x:unknown):Row{return x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Row:{};}
function validate(x:unknown):{marketplace:Market;skus:string[]}{
  const o=obj(x),keys=Object.keys(o);
  if(keys.length!==2||!keys.includes("marketplace")||!keys.includes("skus")||
    typeof o.marketplace!=="string"||!Object.hasOwn(AMAZON_EU_MARKETPLACES,o.marketplace)||
    !Array.isArray(o.skus)||o.skus.length<1||o.skus.length>4||
    o.skus.some(s=>typeof s!=="string"||!SKU.test(s)||s!==s.trim())||
    new Set(o.skus).size!==o.skus.length)throw Error("amazon_qualification_invalid_request");
  return {marketplace:o.marketplace as Market,skus:o.skus as string[]};
}
async function boundedJson(response:Response):Promise<Row|null>{
  if(response.status!==200||
    !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type")||""))return null;
  const announced=Number(response.headers.get("content-length")||0);
  if(!Number.isFinite(announced)||announced>MAX_BYTES)return null;
  const reader=response.body?.getReader();if(!reader)return null;
  let bytes=0,body="";
  const dec=new TextDecoder("utf-8",{fatal:true});
  try{
    for(;;){const part=await reader.read();if(part.done)break;
      bytes+=part.value.byteLength;
      if(bytes>MAX_BYTES){void reader.cancel().catch(()=>{});return null;}
      body+=dec.decode(part.value,{stream:true});
    }
    body+=dec.decode();
    const parsed=JSON.parse(body);return Object.keys(obj(parsed)).length?obj(parsed):null;
  }catch{return null;}finally{reader.releaseLock();}
}
function sellerCentralResource(x:unknown):string|null{
  if(typeof x!=="string"||x.length>800)return null;
  try{const u=new URL(x);
    if(u.protocol!=="https:"||u.username||u.password||u.port||
      !/^sellercentral\.amazon\.(?:it|de|fr|es|co\.uk|com)$/.test(u.hostname))return null;
    return u.toString();
  }catch{return null;}
}
export async function readAmazonQualificationRestrictions(
  rawInput:unknown,env:Env,deps:QualificationReadDeps={}
):Promise<Row>{
  const {marketplace,skus}=validate(rawInput);
  const seller=env.AMAZON_SP_API_SELLER_ID;
  if(typeof seller!=="string"||!SELLER.test(seller))
    return {ok:false,status:"SELLER_CONFIG_UNVERIFIED",marketplace,results:[],...FLAGS};
  let listings:Row;
  try{listings=obj(await(deps.readListings??readAmazonSellerListingsDirect)({marketplace,skus},env));}
  catch{return {ok:false,status:"LISTINGS_OBSERVATION_FAILED",marketplace,results:[],...FLAGS};}
  const observed=listings.results;
  if(listings.ok!==true||listings.marketplace!==marketplace||
    !Array.isArray(observed)||observed.length!==skus.length)
    return {ok:false,status:"LISTINGS_OBSERVATION_INCOMPLETE",marketplace,results:[],...FLAGS};
  const observedMap=new Map<string,Row>();
  for(const raw of observed){const item=obj(raw);
    if(typeof item.sku!=="string"||!skus.includes(item.sku)||observedMap.has(item.sku))
      return {ok:false,status:"LISTINGS_IDENTITY_UNVERIFIED",marketplace,results:[],...FLAGS};
    observedMap.set(item.sku,item);
  }
  const targets=skus.map(sku=>{
    const item=observedMap.get(sku)||{};
    const issues=Array.isArray(item.issue_signals)?item.issue_signals:[];
    const hasQualification=issues.some(x=>{const i=obj(x);return typeof i.code==="string"&&
      QUALIFICATION_CODES.has(i.code)&&i.severity==="ERROR"&&
      Array.isArray(i.categories)&&i.categories.includes("QUALIFICATION_REQUIRED");});
    const buyable=Array.isArray(item.statuses)&&item.statuses.includes("BUYABLE");
    const asin=typeof item.asin==="string"&&ASIN.test(item.asin)?item.asin:null;
    return {sku,asin,eligible:item.state==="PRESENT"&&hasQualification&&!buyable};
  });
  if(!targets.some(t=>t.eligible))
    return {ok:true,marketplace,status:"NO_VERIFIED_QUALIFICATION_TARGETS",
      results:targets.map(t=>({sku:t.sku,asin:t.asin,status:"NO_CONFIRMED_NONBUYABLE_QUALIFICATION"})),...FLAGS};
  let token:string;
  try{token=await(deps.getAccessToken??getAmazonAccessToken)(env);}
  catch{return {ok:false,marketplace,status:"AMAZON_AUTH_UNAVAILABLE",results:[],...FLAGS};}
  if(typeof token!=="string"||token.length<1||token.length>16384||
    /[\u0000-\u0020\u007f]/.test(token))
    return {ok:false,marketplace,status:"AMAZON_AUTH_UNAVAILABLE",results:[],...FLAGS};
  const results:Row[]=[];
  for(const t of targets){
    if(!t.eligible||!t.asin){results.push({sku:t.sku,asin:t.asin,
      status:"NO_CONFIRMED_NONBUYABLE_100632"});continue;}
    const q=new URLSearchParams({asin:t.asin,sellerId:seller,
      marketplaceIds:AMAZON_EU_MARKETPLACES[marketplace],conditionType:"new_new"});
    const url=HOST+"/listings/2021-08-01/restrictions?"+q.toString();
    let response:Response;
    try{response=await(deps.fetch??fetch)(url,{method:"GET",redirect:"manual",
      headers:{"x-amz-access-token":token,Accept:"application/json"},
      signal:AbortSignal.timeout(20_000)});
    }catch{results.push({sku:t.sku,asin:t.asin,status:"RESTRICTIONS_TRANSPORT_UNKNOWN"});continue;}
    const parsed=await boundedJson(response);
    if(!parsed||!Array.isArray(parsed.restrictions)||parsed.restrictions.length>30||
       parsed.restrictions.some(x=>obj(x).marketplaceId!==AMAZON_EU_MARKETPLACES[marketplace])){
      results.push({sku:t.sku,asin:t.asin,status:"RESTRICTIONS_RESPONSE_UNVERIFIED"});
      continue;
    }
    const reasons=new Set<string>(),urls=new Set<string>();
    for(const rawRestriction of parsed.restrictions){
      const restriction=obj(rawRestriction);
      const detail=Array.isArray(restriction.reasons)?restriction.reasons:[];
      for(const rawReason of detail.slice(0,20)){
        const reason=obj(rawReason);
        if(typeof reason.reasonCode==="string"&&CODE.test(reason.reasonCode))reasons.add(reason.reasonCode);
        const links=Array.isArray(reason.links)?reason.links:[];
        for(const rawLink of links.slice(0,10)){
          const safe=sellerCentralResource(obj(rawLink).resource);
          if(safe)urls.add(safe);
        }
      }
    }
    results.push({sku:t.sku,asin:t.asin,
      status:parsed.restrictions.length?"RESTRICTIONS_REPORTED":"NO_RESTRICTIONS_RETURNED_NOT_APPROVAL_PROOF",
      restriction_count:parsed.restrictions.length,
      reason_codes:[...reasons].slice(0,20),seller_central_links:[...urls].slice(0,10),
      seller_listing_still_not_buyable:true});
  }
  return {ok:true,marketplace,status:"QUALIFICATION_RESTRICTIONS_OBSERVED",
    requested_skus:skus.length,results,...FLAGS};
}
