import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { readAmazonExistingOfferQualificationTriage } from "./mare-business-amazon-existing-offer-triage.js";
import type { AmazonCredentials } from "./amazon-auth.js";

/**
 * Account-private, read-only and bounded mass worklist for EXISTING seller
 * offers. Invokes the independently tested live 100632 triage in sequential
 * chunks of <=3, so Catalog Items calls do not fan out without a limit.
 *
 * A classification is not a case ID, approval, offer, or permission to write.
 */
type Row=Record<string,unknown>;
type Market=keyof typeof AMAZON_EU_MARKETPLACES;
type Env=AmazonCredentials & {AMAZON_SP_API_SELLER_ID?:string};
type Input={marketplace:Market;items:Array<{sku:string;ean:string}>;compare_marketplace?:Market};
export type BulkTriageDeps={triage?:typeof readAmazonExistingOfferQualificationTriage};
const EAN=/^\d{13}$/,SKU=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/,ASIN=/^[A-Z0-9]{10}$/;
const ISSUE=/^\d{4,10}$/;
const ALLOWED=[
 "EXISTING_OFFER_BUYABLE","SELLER_IDENTITY_DIAGNOSTICS",
 "CATALOG_IDENTITY_ESCALATION","SELLER_CENTRAL_APPROVAL_LINK",
 "SELLER_SUPPORT_100632_NO_APPLICATION_LINK","RECHECK_REQUIRED",
 "NOT_100632_COHORT",
] as const;
const ROUTES=[
 "SELLER_SUPPORT_100632_NO_APPLICATION_LINK","CATALOG_IDENTITY_ESCALATION",
 "SELLER_CENTRAL_APPROVAL_LINK","SELLER_IDENTITY_DIAGNOSTICS",
 "RECHECK_REQUIRED","NOT_100632_COHORT","EXISTING_OFFER_BUYABLE"
] as const;
const FLAGS={
 read_only:true,provider_mutations:0,brand_approval_proven:false,
 can_publish:false,can_create_offers:false,
 offers_created:0,applications_created:0,seller_support_cases_created:0,
 seller_central_submission_performed:false,
 channable_handoff_performed:false,stock_changed:false,price_changed:false,
};
const obj=(v:unknown):Row=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};
function validEAN(ean:string):boolean{
 if(!EAN.test(ean))return false;
 let sum=0;for(let k=0;k<12;k++)sum+=Number(ean[k])*(k%2===0?1:3);
 return (10-(sum%10))%10===Number(ean[12]);
}
function parse(raw:unknown):Input{
 const x=obj(raw),keys=Object.keys(x);
 if(keys.some(k=>!["marketplace","items","compare_marketplace"].includes(k))||
    !Object.hasOwn(AMAZON_EU_MARKETPLACES,x.marketplace as string)||
    !Array.isArray(x.items)||x.items.length<1||x.items.length>9||
    (x.compare_marketplace!==undefined&&
     (!Object.hasOwn(AMAZON_EU_MARKETPLACES,x.compare_marketplace as string)||
      x.compare_marketplace===x.marketplace)))
   throw Error("amazon_bulk_offer_worklist_invalid_request");
 const items=x.items.map(obj);
 if(items.some(y=>Object.keys(y).sort().join(",")!=="ean,sku"||
   typeof y.sku!=="string"||!SKU.test(y.sku)||y.sku!==y.sku.trim()||
   typeof y.ean!=="string"||!validEAN(y.ean))||
   new Set(items.map(y=>y.sku)).size!==items.length||
   new Set(items.map(y=>y.ean)).size!==items.length)
   throw Error("amazon_bulk_offer_worklist_invalid_request");
 return {marketplace:x.marketplace as Market,
   items:items.map(y=>({sku:y.sku as string,ean:y.ean as string})),
   ...(x.compare_marketplace?{compare_marketplace:x.compare_marketplace as Market}:{})};
}
function validLink(link:unknown,marketplace:Market,asin:string|null):string|null{
 const expected=asin?
   "https://sellercentral.amazon."+marketplace.toLowerCase()+
   "/hz/approvalrequest/restrictions/approve?asin="+asin:"";
 return link===expected&&expected?expected:null;
}
function issues(raw:unknown):string[]|null {
 if(!Array.isArray(raw)||raw.length>25||raw.some(x=>typeof x!=="string"||!ISSUE.test(x)))
  return null;
 return [...new Set(raw as string[])];
}
function validatedRow(raw:unknown,requested:{sku:string;ean:string},market:Market):Row|null{
 const x=obj(raw),state=x.state,asin=x.asin;
 if(x.sku!==requested.sku||x.ean!==requested.ean||
    !ALLOWED.includes(state as typeof ALLOWED[number])||
    (asin!==null&&(typeof asin!=="string"||!ASIN.test(asin)))||
    x.brand_approval_proven!==false||x.can_publish!==false||
    typeof x.catalog_ean_state!=="string"||
    !["MATCH","MISSING","DIFFERENT","UNKNOWN"].includes(x.catalog_ean_state)||
    typeof x.catalog_asin_state!=="string"||
    !["FOUND","MISSING","UNKNOWN"].includes(x.catalog_asin_state))
   return null;
 const codes=issues(x.listing_issues);
 const other=issues(x.additional_issue_codes);
 if(codes===null||other===null||other.some(c=>!codes.includes(c)))return null;
 const isApproval=state==="SELLER_CENTRAL_APPROVAL_LINK";
 const link=validLink(x.seller_central_approval_url,market,asin as string|null);
 if(isApproval&&!link)return null;
 if(!isApproval&&x.seller_central_approval_url!==null)return null;
 if(state==="SELLER_SUPPORT_100632_NO_APPLICATION_LINK"&&(
    x.catalog_ean_state!=="MATCH"||x.catalog_asin_state!=="FOUND"||
    !codes.includes("100632")||
    x.restrictions_state!=="NO_RESTRICTIONS_RETURNED_NOT_APPROVAL_PROOF"))
    return null;
 return {
  sku:requested.sku,ean:requested.ean,asin:asin as string|null,
  state,listing_issues:codes,other_issue_codes:other,
  catalog_ean_state:x.catalog_ean_state,catalog_asin_state:x.catalog_asin_state,
  restrictions_state:typeof x.restrictions_state==="string"?
    x.restrictions_state.slice(0,100):"UNKNOWN",
  approval_url:link,existing_offer_buyable:state==="EXISTING_OFFER_BUYABLE",
  case_or_approval_submitted:false,brand_approval_proven:false,can_publish:false,
 };
}
export async function readAmazonExistingOffersBulkCaseWorklist(
 raw:unknown,env:Env,deps:BulkTriageDeps={},
):Promise<Row>{
 const input=parse(raw),reader=deps.triage??readAmazonExistingOfferQualificationTriage;
 const fail=(reason:string):Row=>({
   ok:false,status:"INCOMPLETE_WORKLIST_FAIL_CLOSED",reason,
   marketplace:input.marketplace,requested:input.items.length,results:[],
   counts_are_safe_to_act_on:false,...FLAGS,
 });
 const list:Row[]=[];
 // Serial batches limit provider load. Never send all records concurrently.
 for(let start=0;start<input.items.length;start+=3){
   const group=input.items.slice(start,start+3);
   let rawResult:unknown;
   try{rawResult=await reader({marketplace:input.marketplace,items:group,
     ...(input.compare_marketplace?{compare_marketplace:input.compare_marketplace}:{})},env)}
   catch{return fail("PROVIDER_READ_FAILED");}
   const r=obj(rawResult);
   if(r.ok!==true||r.marketplace!==input.marketplace||
      r.read_only!==true||r.provider_mutations!==0||
      r.brand_approval_proven!==false||r.can_publish!==false||
      r.offers_created!==0||r.applications_created!==0||
      r.support_case_created!==false||r.seller_central_submission_performed!==false||
      r.requested!==group.length||
      !Array.isArray(r.results)||r.results.length!==group.length)
     return fail("BATCH_TRIAGE_PROOF_INCOMPLETE");
   const by=new Map<string,Row>();
   for(const value of r.results){
     const x=obj(value);
     if(typeof x.sku!=="string"||by.has(x.sku)||!group.some(y=>y.sku===x.sku))
       return fail("BATCH_TRIAGE_IDENTITY_MISMATCH");
     by.set(x.sku,x);
   }
   for(const item of group){
     const row=validatedRow(by.get(item.sku),item,input.marketplace);
     if(!row)return fail("BATCH_TRIAGE_CLASSIFICATION_UNVERIFIED");
     list.push(row);
   }
 }
 const counts=Object.fromEntries(ROUTES.map(route=>
   [route,list.filter(x=>x.state===route).length]));
 const worklist=ROUTES.map(route=>({
   route,count:counts[route],
   sku_asin: list.filter(x=>x.state===route)
      .map(x=>({sku:x.sku,ean:x.ean,asin:x.asin,
       listing_issues:x.listing_issues,other_issue_codes:x.other_issue_codes,
       ...(x.approval_url?{seller_central_approval_url:x.approval_url}:{})}))
 }));
 return {ok:true,status:"READ_ONLY_BULK_CASE_WORKLIST",
   marketplace:input.marketplace,
   compare_marketplace:input.compare_marketplace??null,
   requested:input.items.length,batches_read:Math.ceil(input.items.length/3),
   counts,worklist,results:list,
   official_approval_link_does_not_prove_application_submitted:true,
   empty_listings_restrictions_do_not_prove_brand_approval:true,
   support_cases_must_be_opened_in_seller_central:true,
   ...FLAGS};
}
