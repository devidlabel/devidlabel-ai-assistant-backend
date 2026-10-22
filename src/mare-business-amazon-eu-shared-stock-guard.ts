import { readAmazonEuInventoryShadow } from "./marketplace-amazon-eu-inventory-shadow.js";
import type { AmazonCredentials } from "./amazon-auth.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/** Read-only shared-pool risk inspection. Amazon FBM numbers in four markets
 * are VIEWS of a shared Shopify pool, not four independent physical stocks.
 * Matching stock does not prove atomic reservations or writer ownership.
 * Quantity differences can be intentional seasonal/channel restrictions.
 */
type Row=Record<string,unknown>;
type Env=AmazonCredentials & MareBusinessShopifyEnv & {AMAZON_SP_API_SELLER_ID?:string};
export type SharedStockDeps={readShadow?:typeof readAmazonEuInventoryShadow};
const MARKETS=["IT","DE","FR","ES"] as const;
const SKU=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const FLAGS={
 read_only:true,provider_mutations:0,
 can_publish:false,can_change_inventory:false,can_change_price:false,
 channable_handoff_performed:false,
 writer_ownership_proven:false,
 safe_for_direct_writer:false,
 atomic_stock_reservation_proven:false,
 oversell_prevention_proven:false,
 seasonal_channel_rules_verified:false,
} as const;
const obj=(x:unknown):Row=>x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Row:{};
function inputSkus(raw:unknown):string[]{
 const x=obj(raw);
 if(Object.keys(x).length!==1||!Array.isArray(x.skus)||x.skus.length<1||x.skus.length>8||
   x.skus.some((v:unknown)=>typeof v!=="string"||!SKU.test(v)||v!==v.trim())||
   new Set(x.skus).size!==x.skus.length)
   throw Error("amazon_shared_stock_guard_invalid_input");
 return x.skus as string[];
}
function validQuantity(x:unknown):x is number{
 return typeof x==="number"&&Number.isSafeInteger(x)&&x>=0;
}
function summaryRow(raw:Row,sku:string):Row{
 const sh=obj(raw.shopify),am=obj(raw.amazon);
 const available=sh.state==="VERIFIED"&&sh.source_unique_active_sku===true&&
   validQuantity(sh.available)?sh.available:null;
 let present=0,buyable=0,quantityVerified=0,quantityAligned=0,
     quantityDifferent=0,quantityUnknown=0,absent=0;
 let positiveMarketListings=0;
 const markets:Row[]=[];
 for(const market of MARKETS){
   const row=obj(am[market]);
   const state=row.state;
   const existing=state==="PRESENT";
   const absentVerified=state==="VERIFIED_ABSENT";
   const observedQuantity=existing&&row.identity_state==="VERIFIED"&&
     row.quantity_state==="VERIFIED"&&validQuantity(row.quantity)?row.quantity:null;
   if(existing)present++;
   if(absentVerified)absent++;
   const isBuyable=existing&&Array.isArray(row.statuses)&&row.statuses.includes("BUYABLE");
   if(isBuyable)buyable++;
   if(existing&&observedQuantity!==null&&observedQuantity>0)positiveMarketListings++;
   if(existing&&observedQuantity===null)quantityUnknown++;
   if(observedQuantity!==null){
     quantityVerified++;
     if(available!==null){
       if(observedQuantity===available)quantityAligned++;
       else quantityDifferent++;
     }
   }
   markets.push({marketplace:market,
     seller_state:typeof state==="string"?state:"UNKNOWN",
     buyable:isBuyable,
     quantity_observed:observedQuantity,
     quantity_verified:observedQuantity!==null,
     matches_shopify_available:observedQuantity!==null&&available!==null?
       observedQuantity===available:null,
     // Never expose a fake zero for absent or unknown.
     absent_is_not_zero_quantity:absentVerified,
   });
 }
 const known=available!==null&&sh.inactive_duplicate_count===0;
 const classification=!known?"SHOPIFY_IDENTITY_OR_STOCK_UNKNOWN":
   quantityDifferent>0?"MARKET_QUANTITY_DIFFERENCE_REQUIRES_RULE_REVIEW":
   quantityUnknown>0||MARKETS.some(m=>{
     const state=obj(am[m]).state;
     return state!=="PRESENT"&&state!=="VERIFIED_ABSENT";
   })?"MARKETPLACE_EVIDENCE_INCOMPLETE":
   buyable>=2&&available>0?"MULTI_MARKET_BUYABLE_SHARED_POOL_UNPROVEN":
   "QUANTITIES_ALIGNED_NO_WRITER_AUTHORITY";
 return {
   sku,shopify_available:available,
   marketplace_offer_count:present,marketplaces_buyable:buyable,
   marketplace_seller_absent_count:absent,
   verified_market_quantity_count:quantityVerified,
   aligned_market_quantity_count:quantityAligned,
   different_market_quantity_count:quantityDifferent,
   unknown_existing_market_quantity_count:quantityUnknown,
   positive_market_listing_count:positiveMarketListings,
   // DO NOT sum listing availability as units available to allocate.
   summed_marketplace_stock_is_not_physical_stock:true,
   // Zero for a seasonal IT suppression may be EXPECTED. Only human/policy
   // verification and separate rule evidence can decide what to change.
   channel_specific_seasonal_exception_not_checked:true,
   classification,markets,
   safe_to_sync_inventory:false,
   ...FLAGS,
 };
}
export async function readAmazonEuSharedStockGuard(
 raw:unknown,env:Env,deps:SharedStockDeps={},
):Promise<Row>{
 const skus=inputSkus(raw);
 let shadow:Row;
 try{shadow=obj(await(deps.readShadow??readAmazonEuInventoryShadow)({skus},env))}
 catch{return {ok:false,status:"INCOMPLETE_SHADOW_OBSERVATION",reason:"SHADOW_READ_FAILED",
   requested_skus:skus.length,results:[],...FLAGS};}
 if(shadow.ok!==true||shadow.source!=="mare_amazon_eu_inventory_shadow"||
    shadow.read_only!==true||shadow.provider_mutations!==0||
    shadow.writer_ownership_proven!==false||
    shadow.requested_skus!==skus.length||!Array.isArray(shadow.results)||
    shadow.results.length!==skus.length)
   return {ok:false,status:"INCOMPLETE_SHADOW_OBSERVATION",reason:"SHADOW_PROOF_INCOMPLETE",
     requested_skus:skus.length,results:[],...FLAGS};
 const by=new Map<string,Row>();
 for(const rawRow of shadow.results){
   const row=obj(rawRow);
   if(typeof row.sku!=="string"||!skus.includes(row.sku)||by.has(row.sku))
      return {ok:false,status:"INCOMPLETE_SHADOW_OBSERVATION",reason:"DUPLICATE_OR_UNKNOWN_SKU",
        requested_skus:skus.length,results:[],...FLAGS};
   by.set(row.sku,row);
 }
 const results=skus.map(sku=>summaryRow(by.get(sku)??{},sku));
 const classifications=Object.fromEntries([...new Set(results.map(r=>r.classification as string))]
   .map(k=>[k,results.filter(r=>r.classification===k).length]));
 return {ok:true,status:"SHARED_STOCK_OBSERVATION_NO_WRITER_AUTHORITY",
   source:"amazon_eu_shared_stock_guard",requested_skus:skus.length,
   observed_at:typeof shadow.observed_at==="string"?shadow.observed_at:null,
   results,classification_counts:classifications,
   ...FLAGS,
   next_step:"CHECK_CHANNABLE_SINGLE_WRITER_SEASON_RULES_AND_ATOMIC_SHARED_POOL_RESERVATIONS",
 };
}
