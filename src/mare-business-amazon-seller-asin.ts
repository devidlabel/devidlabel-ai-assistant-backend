import {getAmazonAccessToken, type AmazonCredentials} from "./amazon-auth.js";
import {AMAZON_EU_MARKETPLACES} from "./amazon-marketplaces.js";

/**
 * R3.4 read-only seller ASIN collision scan using searchListingsItems.
 * Different seller SKUs can point at the same ASIN. A GET by proposed SKU
 * alone must NEVER be treated as proof that the seller has no existing ASIN.
 * No offering/quantity writes. Empty search is NOT sufficient write approval.
 *
 * Official Listings Items 2021-08-01: GET /listings/.../items/{sellerId}
 * with identifiersType=ASIN, identifiers, marketplaceIds, pageToken.
 */
type Row=Record<string,unknown>;
type Env=AmazonCredentials&{AMAZON_SP_API_SELLER_ID?:string};
type Market=keyof typeof AMAZON_EU_MARKETPLACES;
const HOST="https://sellingpartnerapi-eu.amazon.com";
const SELLER_RE=/^[A-Z0-9]{8,30}$/;
const ASIN_RE=/^[A-Z0-9]{10}$/;
const MAX_ASINS=4;
const PAGE_SIZE=20;
const MAX_PAGES=4;
type Outcome={
 asin:string;state:"SELLER_ASIN_LISTING_FOUND"|
   "NO_SELLER_ASIN_IN_BOUNDED_SEARCH"|"UNKNOWN";
 reason:string;pages_read:number;skus:string[];
 query_complete:boolean;
};
function obj(v:unknown):Row{
 return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};
}
function val(v:unknown):string{return typeof v==="string"?v:"";}
async function searchOne(asin:string,marketId:string,token:string,sellerId:string):Promise<Outcome>{
 const skus=new Set<string>();
 const seenTokens=new Set<string>();
 let cursor:string|null=null;
 let pages=0;
 let totalReport:number|null=null;
 let incomplete=false;
 while(true){
  if(pages>=MAX_PAGES) return {
   asin,state:"UNKNOWN",reason:"seller_asin_page_limit_reached",
   pages_read:pages,skus:[...skus],query_complete:false
  };
  const url=new URL(HOST+"/listings/2021-08-01/items/"+encodeURIComponent(sellerId));
  url.searchParams.set("marketplaceIds",marketId);
  url.searchParams.set("identifiersType","ASIN");
  url.searchParams.set("identifiers",asin);
  url.searchParams.set("includedData","summaries");
  url.searchParams.set("pageSize",String(PAGE_SIZE));
  if(cursor)url.searchParams.set("pageToken",cursor);
  let response:Response;
  try{
   response=await fetch(url.toString(),{
    method:"GET",headers:{"x-amz-access-token":token,Accept:"application/json"},
    redirect:"error",signal:AbortSignal.timeout(20000)
   });
  }catch{
   return {asin,state:"UNKNOWN",reason:"seller_asin_network_error",
    pages_read:pages,skus:[...skus],query_complete:false};
  }
  if(!response.ok)return {asin,state:"UNKNOWN",
    reason:"seller_asin_http_"+response.status,
    pages_read:pages,skus:[...skus],query_complete:false};
  let raw:unknown;
  try{raw=await response.json()}catch{
   return {asin,state:"UNKNOWN",reason:"seller_asin_invalid_json",
    pages_read:pages,skus:[...skus],query_complete:false};
  }
  const body=obj(raw),items=body.items,pagination=obj(body.pagination);
  if(!Array.isArray(items)||items.length>PAGE_SIZE||
     !Number.isSafeInteger(body.numberOfResults)||Number(body.numberOfResults)<0||
     (body.pagination!==undefined&&
      (body.pagination===null||typeof body.pagination!=="object"||Array.isArray(body.pagination))))
   return {asin,state:"UNKNOWN",reason:"seller_asin_malformed_page",
    pages_read:pages,skus:[...skus],query_complete:false};
  const claimed=body.numberOfResults as number;
  if(totalReport!==null&&claimed!==totalReport)incomplete=true;
  if(totalReport===null)totalReport=claimed;
  for(const rawItem of items) {
   const item=obj(rawItem);
   const sku=val(item.sku);
   const summaries=item.summaries;
   if(!sku||sku.length>200||!Array.isArray(summaries)){
    incomplete=true;continue;
   }
   const sameMarket=(summaries as unknown[]).map(obj).filter(s=>s.marketplaceId===marketId);
   if(sameMarket.length!==1||sameMarket[0].asin!==asin){
    incomplete=true;continue;
   }
   skus.add(sku); // exact and opaque. Do not uppercase or trim the seller SKU.
  }
  pages++;
  const next=pagination.nextToken;
  if(next===undefined||next===null||next==="")break;
  if(typeof next!=="string"||next.length>8192||
     next===cursor||seenTokens.has(next)){
   return {asin,state:"UNKNOWN",reason:"seller_asin_invalid_cursor",
    pages_read:pages,skus:[...skus],query_complete:false};
  }
  cursor=next;seenTokens.add(next);
 }
 if(incomplete || (totalReport!==null&&totalReport>0&&skus.size===0)){
  return {asin,state:"UNKNOWN",reason:"seller_asin_search_evidence_inconsistent",
   pages_read:pages,skus:[...skus],query_complete:false};
 }
 if(skus.size>0) return {
  asin,state:"SELLER_ASIN_LISTING_FOUND",
  reason:"seller_has_existing_listings_for_asin",
  pages_read:pages,skus:[...skus],query_complete:true
 };
 if(totalReport!==0) return {asin,state:"UNKNOWN",
  reason:"seller_asin_empty_with_nonzero_count",
  pages_read:pages,skus:[],query_complete:false};
 return {asin,state:"NO_SELLER_ASIN_IN_BOUNDED_SEARCH",
  reason:"no_seller_listing_in_complete_search_not_absolute_absence_proof",
  pages_read:pages,skus:[],query_complete:true
 };
}
export async function readAmazonSellerAsinListings(input:Row,env:Env):Promise<Row>{
 const market=val(input.marketplace),asins=input.asins;
 if(!Object.hasOwn(AMAZON_EU_MARKETPLACES,market)||
    !Array.isArray(asins)||asins.length<1||asins.length>MAX_ASINS||
    asins.some(x=>typeof x!=="string"||!ASIN_RE.test(x))||
    new Set(asins).size!==asins.length||
    Object.keys(input).some(k=>!["marketplace","asins"].includes(k)))
  throw new Error("amazon_seller_asin_invalid_request");
 const sellerId=val(env.AMAZON_SP_API_SELLER_ID);
 if(!SELLER_RE.test(sellerId))return {
  ok:false,status:"BLOCKED_SELLER_ID_CONFIG",read_only:true,
  marketplace:market,results:[],seller_id_configured:false
 };
 const token=await getAmazonAccessToken(env);
 const marketId=AMAZON_EU_MARKETPLACES[market as Market];
 const results:Outcome[]=[];
 for(const asin of asins as string[])
  results.push(await searchOne(asin,marketId,token,sellerId));
 return {
  ok:true,source:"amazon_sp_api_search_listings_items_by_asin",
  read_only:true,marketplace:market,marketplace_id:marketId,
  results,
  seller_listings_found_count:results.filter(x=>x.state==="SELLER_ASIN_LISTING_FOUND").length,
  search_empty_count:results.filter(x=>x.state==="NO_SELLER_ASIN_IN_BOUNDED_SEARCH").length,
  unknown_count:results.filter(x=>x.state==="UNKNOWN").length,
  complete_evidence:results.every(x=>x.query_complete),
  exact_seller_sku_must_still_be_checked:true,
  search_absence_is_not_writer_handoff_proof:true,
  order_importer_is_still_channable:true,
  can_create_offer:false,can_change_stock:false,no_provider_writes:true
 };
}
