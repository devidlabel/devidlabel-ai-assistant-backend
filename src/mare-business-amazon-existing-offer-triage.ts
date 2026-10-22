import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";
import { readAmazonQualificationRestrictions } from "./mare-business-amazon-qualification-restrictions.js";
import { readAmazonExactMatchCandidates } from "./mare-business-amazon-matching.js";
import { readAmazonCatalogASINDetails } from "./mare-business-amazon-details.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import type { AmazonCredentials } from "./amazon-auth.js";

/**
 * Live, merchant-private and STRICTLY READ-ONLY diagnostics for EXISTING offers
 * with Amazon issue 100632. Joins independent seller GET / restrictions / EAN
 * Catalog Items / ASIN Catalog Items and optional other-market seller GET.
 * An empty restrictions array is NEVER brand approval.
 *
 * NOT a fix, listing write, approval request or entitlement to publish.
 */
type Market = keyof typeof AMAZON_EU_MARKETPLACES;
type Row = Record<string, unknown>;
type Env = AmazonCredentials & { AMAZON_SP_API_SELLER_ID?: string };
type Input = { marketplace: Market; items: Array<{sku:string;ean:string}>; compare_marketplace?: Market };
export type ExistingOfferQualificationDeps = {
  listings?: typeof readAmazonSellerListingsDirect;
  restrictions?: typeof readAmazonQualificationRestrictions;
  matching?: typeof readAmazonExactMatchCandidates;
  details?: typeof readAmazonCatalogASINDetails;
};
const SKU=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const ASIN=/^[A-Z0-9]{10}$/;
const EAN=/^\d{13}$/;
const STATES=[
  "EXISTING_OFFER_BUYABLE","SELLER_IDENTITY_DIAGNOSTICS",
  "CATALOG_IDENTITY_ESCALATION","SELLER_CENTRAL_APPROVAL_LINK",
  "SELLER_SUPPORT_100632_NO_APPLICATION_LINK","RECHECK_REQUIRED",
  "NOT_100632_COHORT",
] as const;
type State=(typeof STATES)[number];
const FLAGS={
  read_only:true,provider_mutations:0,brand_approval_proven:false,
  applications_created:0,offers_created:0,can_publish:false,
  channable_handoff_performed:false,
} as const;
const obj=(v:unknown):Row=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};
const rows=(v:unknown):Row[]=>Array.isArray(v)?v.map(obj):[];
function validEAN(code:string):boolean{
  if(!EAN.test(code))return false;
  let sum=0;for(let i=0;i<12;i++)sum+=Number(code[i])*(i%2===0?1:3);
  return (10-sum%10)%10===Number(code[12]);
}
function validate(x:unknown):Input{
  const v=obj(x),keys=Object.keys(v);
  if(keys.some(k=>!["marketplace","items","compare_marketplace"].includes(k))||
     !Object.hasOwn(AMAZON_EU_MARKETPLACES,v.marketplace as string)||
     !Array.isArray(v.items)||v.items.length<1||v.items.length>3||
     (v.compare_marketplace!==undefined&&
      (!Object.hasOwn(AMAZON_EU_MARKETPLACES,v.compare_marketplace as string)||
       v.compare_marketplace===v.marketplace)))
    throw Error("amazon_existing_offer_triage_invalid_request");
  const entries=v.items.map(obj);
  if(entries.some(z=>Object.keys(z).sort().join(",")!=="ean,sku"||
    typeof z.sku!=="string"||!SKU.test(z.sku)||z.sku!==z.sku.trim()||
    typeof z.ean!=="string"||!validEAN(z.ean))||
    new Set(entries.map(z=>z.sku)).size!==entries.length ||
    new Set(entries.map(z=>z.ean)).size!==entries.length)
    throw Error("amazon_existing_offer_triage_invalid_request");
  return {
    marketplace:v.marketplace as Market,
    items:entries.map(z=>({sku:z.sku as string,ean:z.ean as string})),
    ...(v.compare_marketplace?{compare_marketplace:v.compare_marketplace as Market}:{})
  };
}
function exactCatalog(q:Row,m:Market,ean:string,asin:string):"MATCH"|"MISSING"|"DIFFERENT"|"UNKNOWN"{
  const x=obj(q.result);
  if(q.ok!==true||q.source!=="amazon_spapi_catalog_items_live"||
    q.read_only!==true||q.identifier_type!=="EAN"||
    x.marketplace!==m||x.complete!==true)return "UNKNOWN";
  const rec=rows(x.identifiers).filter(y=>y.ean===ean);
  if(rec.length!==1)return "UNKNOWN";
  const t=rec[0], asins=t.asins;
  if(t.state==="NO_EXACT_MATCH"&&t.exact_match_count===0&&Array.isArray(asins)&&asins.length===0)return "MISSING";
  if(t.state!=="EXACT_ONE"||t.exact_match_count!==1||!Array.isArray(asins)||asins.length!==1||typeof asins[0]!=="string"||!ASIN.test(asins[0]))return "UNKNOWN";
  return asins[0]===asin?"MATCH":"DIFFERENT";
}
function detailCatalog(q:Row,m:Market,asin:string):"FOUND"|"MISSING"|"UNKNOWN"{
  if(q.ok!==true||q.marketplace!==m||q.read_only!==true||q.source!=="amazon_spapi_catalog_item_live")return "UNKNOWN";
  const found=rows(q.results).filter(z=>z.asin===asin);
  if(found.length!==1)return "UNKNOWN";
  return found[0].state==="READ_ONLY_DETAILS_COMPLETE"?"FOUND":found[0].state==="ASIN_NOT_FOUND"?"MISSING":"UNKNOWN";
}
function safeLink(v:unknown,m:Market,asin:string):string|null {
  const exact="https://sellercentral.amazon."+m.toLowerCase()+"/hz/approvalrequest/restrictions/approve?asin="+asin;
  return v===exact?exact:null;
}
function issueCodes(row:Row):string[]{
  return [...new Set(rows(row.issue_signals)
    .filter(z=>typeof z.code==="string"&&/^\d{4,10}$/.test(z.code))
    .map(z=>z.code as string))];
}
function sellerMap(raw:Row,m:Market,skus:string[]):Map<string,Row>|null{
  if(raw.ok!==true||raw.marketplace!==m||
    raw.source!=="amazon_sp_api_get_listings_item"||
    raw.read_only!==true||raw.has_created_or_updated_offer!==false)return null;
  const map=new Map<string,Row>();
  for(const r of rows(raw.results)){
    if(typeof r.sku!=="string"||!skus.includes(r.sku)||map.has(r.sku))return null;
    map.set(r.sku,r);
  }
  return map.size===skus.length?map:null;
}
function restrictionMap(raw:Row,m:Market):Map<string,Row>|null{
  if(raw.ok!==true||raw.marketplace!==m||raw.read_only!==true||
    raw.provider_mutations!==0)return null;
  const map=new Map<string,Row>();
  for(const r of rows(raw.results)){
    if(typeof r.sku!=="string"||map.has(r.sku))return null;
    map.set(r.sku,r);
  }
  return map;
}
export async function readAmazonExistingOfferQualificationTriage(
  raw:unknown, env:Env, deps:ExistingOfferQualificationDeps={},
):Promise<Row>{
  const input=validate(raw), m=input.marketplace, skus=input.items.map(x=>x.sku);
  const listingFn=deps.listings??readAmazonSellerListingsDirect;
  const restrictionsFn=deps.restrictions??readAmazonQualificationRestrictions;
  const matchingFn=deps.matching??readAmazonExactMatchCandidates;
  const detailsFn=deps.details??readAmazonCatalogASINDetails;
  const safe=async(fn:()=>Promise<unknown>):Promise<Row>=>{
    try{return obj(await fn())}catch{return {}}
  };
  // All reads are independent and fail closed; no evidence field is made up.
  const [sellerRaw, restrictionRaw, eanRaw, compareRaw]=await Promise.all([
    safe(()=>listingFn({marketplace:m,skus},env)),
    safe(()=>restrictionsFn({marketplace:m,skus},env)),
    safe(()=>matchingFn({marketplace:m,identifier_type:"EAN",identifiers:input.items.map(x=>x.ean)},env)),
    input.compare_marketplace?safe(()=>listingFn({marketplace:input.compare_marketplace!,skus},env)):Promise.resolve({})
  ]);
  const seller=sellerMap(sellerRaw,m,skus);
  const compare=input.compare_marketplace?sellerMap(compareRaw,input.compare_marketplace,skus):null;
  const restriction=restrictionMap(restrictionRaw,m);
  const uniqueAsins=[...new Set([...seller?.values()??[]]
    .map(r=>r.asin).filter((x):x is string=>typeof x==="string"&&ASIN.test(x)))];
  const detailRaw=uniqueAsins.length
    ?await safe(()=>detailsFn({marketplace:m,asins:uniqueAsins},env)):{};
  const entries=input.items.map(item=>{
    const own=seller?.get(item.sku)??{},asin=typeof own.asin==="string"&&ASIN.test(own.asin)?own.asin:null;
    const codes=issueCodes(own), otherErrors=codes.filter(x=>x!=="100632");
    const other=compare?.get(item.sku);
    const counterpart_buyable=Boolean(other&&other.state==="PRESENT"&&other.identity_state==="VERIFIED"&&
      other.asin===asin&&Array.isArray(other.statuses)&&other.statuses.includes("BUYABLE"));
    const base={sku:item.sku,ean:item.ean,asin,
      listing_state:own.state??"UNVERIFIED",
      listing_issues:codes,additional_issue_codes:otherErrors,
      counterpart_buyable,catalog_ean_state:"UNKNOWN",catalog_asin_state:"UNKNOWN",
      restrictions_state:"UNKNOWN",reason_codes:[] as string[],
      seller_central_approval_url:null as string|null,
      state:"RECHECK_REQUIRED" as State,action:"RECHECK_PROVIDER_EVIDENCE",
      brand_approval_proven:false,can_publish:false};
    if(!seller)return base;
    if(own.state==="PRESENT"&&Array.isArray(own.statuses)&&own.statuses.includes("BUYABLE"))
      return {...base,state:"EXISTING_OFFER_BUYABLE" as State,action:"NO_ACTION_DO_NOT_DUPLICATE"};
    if(own.state!=="PRESENT"||own.identity_state!=="VERIFIED"||!asin)
      return {...base,state:"SELLER_IDENTITY_DIAGNOSTICS" as State,action:"RECONCILE_EXISTING_SKU_ASIN"};
    if(!codes.includes("100632"))return {...base,state:"NOT_100632_COHORT" as State,action:"CHECK_OTHER_LISTING_ISSUES"};
    const ean=exactCatalog(eanRaw,m,item.ean,asin), detail=detailCatalog(detailRaw,m,asin);
    const restrictionRow=restriction?.get(item.sku)??{};
    const codesR=Array.isArray(restrictionRow.reason_codes)?restrictionRow.reason_codes.filter(z=>typeof z==="string"):[] as string[];
    const links=Array.isArray(restrictionRow.seller_central_links)?restrictionRow.seller_central_links:[];
    const restOK=restrictionRow.asin===asin;
    const rest=restOK?restrictionRow.status:"UNKNOWN";
    const full={...base,catalog_ean_state:ean,catalog_asin_state:detail,
      restrictions_state:rest,reason_codes:codesR as string[]};
    if((rest==="RESTRICTIONS_REPORTED"&&codesR.includes("ASIN_NOT_FOUND"))||
       ean==="MISSING"||ean==="DIFFERENT"||detail==="MISSING")
      return {...full,state:"CATALOG_IDENTITY_ESCALATION" as State,action:"SELLER_SUPPORT_CATALOG_ES_VS_OTHER_MARKET"};
    if(ean!=="MATCH"||detail!=="FOUND")return {...full,state:"RECHECK_REQUIRED" as State,action:"VERIFY_EAN_AND_ASIN_CATALOG"};
    if(rest==="RESTRICTIONS_REPORTED"&&codesR.includes("APPROVAL_REQUIRED")){
      const valid=links.map(z=>safeLink(z,m,asin)).filter((z):z is string=>Boolean(z));
      if(valid.length===1)return {...full,state:"SELLER_CENTRAL_APPROVAL_LINK" as State,
        seller_central_approval_url:valid[0],action:"MANUAL_SELLER_CENTRAL_APPROVAL"};
    }
    if(rest==="NO_RESTRICTIONS_RETURNED_NOT_APPROVAL_PROOF"&&
       restrictionRow.restriction_count===0&&codesR.length===0&&links.length===0)
      return {...full,state:"SELLER_SUPPORT_100632_NO_APPLICATION_LINK" as State,
        action:"SELLER_SUPPORT_ACCOUNT_MARKET_BRAND_100632"};
    return {...full,action:"RECHECK_RESTRICTIONS_OR_SELLER_CENTRAL"};
  });
  const counts=Object.fromEntries(STATES.map(state=>[state,entries.filter(e=>e.state===state).length]));
  return {ok:true,status:"READ_ONLY_EXISTING_OFFER_TRIAGE",
    marketplace:m,compare_marketplace:input.compare_marketplace??null,
    requested:input.items.length,counts,results:entries,
    ...FLAGS,
    // A positive classification is never permission to list, change GTIN or switch writer.
    seller_central_submission_performed:false,
    support_case_created:false,
  };
}
