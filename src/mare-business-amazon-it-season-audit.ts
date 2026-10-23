import { shopifyGraphQL } from "./index.js";
import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";
import type { AmazonCredentials } from "./amazon-auth.js";

/** Observes IT listings for the exact A/I 2026-2027 Shopify metaobject.
 * Cannot verify Channable rule scheduling or change inventory. */
type Row=Record<string,unknown>;
type Env=MareBusinessShopifyEnv & AmazonCredentials & {AMAZON_SP_API_SELLER_ID?:string};
type Dependencies={
 readShopify?:typeof shopifyGraphQL;
 readListings?:typeof readAmazonSellerListingsDirect;
};
const SHOPIFY_SEASON_ID="gid://shopify/Metaobject/421462409557";
const TARGET_BRANDS=new Set(["Sprayground","MC2 Saint Barth"]);
const SKU=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const QUERY='query AmazonItSeasonAudit($skuQuery:String!){productVariants(first:3,query:$skuQuery){nodes{sku inventoryQuantity product{id vendor status season:metafield(namespace:"features",key:"season"){type value}}}pageInfo{hasNextPage}}}';
const obj=(x:unknown):Row=>x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Row:{};
const flags={
 read_only:true,provider_mutations:0,can_change_inventory:false,
 can_publish:false,shopify_storefront_unchanged:true,
 channable_configuration_verified:false,seasonal_schedule_verified:false,
 writer_ownership_proven:false,safe_for_direct_writer:false,
} as const;
function validateInput(raw:unknown):string[]{
 const row=obj(raw);
 if(Object.keys(row).length!==1||!Array.isArray(row.skus)||
    row.skus.length<1||row.skus.length>8||
    row.skus.some((v:unknown)=>typeof v!=="string"||!SKU.test(v)||v!==v.trim())||
    new Set(row.skus).size!==row.skus.length)
    throw Error("amazon_it_season_audit_invalid_request");
 return row.skus as string[];
}
function verifiedQuantity(x:unknown):number|null{
 return typeof x==="number"&&Number.isSafeInteger(x)&&x>=0?x:null;
}
function unknown(sku:string,reason:string):Row{
 return {sku,finding:"INSUFFICIENT_EVIDENCE",reason,
  season_cohort:"UNKNOWN",amazon_quantity:null,amazon_buyable:null};
}
function parseShopify(sku:string,raw:unknown):Row{
 const response=obj(raw);
 const connection=obj(response.productVariants);
 if(!Array.isArray(connection.nodes)||
    obj(connection.pageInfo).hasNextPage!==false)
    return unknown(sku,"SHOPIFY_LOOKUP_PAGINATION_INCOMPLETE");
 const matches=connection.nodes.map(obj).filter(v=>v.sku===sku);
 if(matches.length!==1)return unknown(sku,"SHOPIFY_SKU_MISSING_OR_AMBIGUOUS");
 const variant=matches[0],product=obj(variant.product),season=obj(product.season);
 if(typeof product.vendor!=="string"||typeof product.status!=="string"||
    !/^gid:\/\/shopify\/Product\/[1-9]\d{0,24}$/.test(String(product.id)))
    return unknown(sku,"SHOPIFY_PRODUCT_IDENTITY_UNVERIFIED");
 if(product.status!=="ACTIVE")
    return {sku,brand:product.vendor,season_cohort:"OUT_OF_SCOPE_INACTIVE",
      finding:"OUT_OF_SCOPE",shopify_available:verifiedQuantity(variant.inventoryQuantity)};
 const stock=verifiedQuantity(variant.inventoryQuantity);
 if(stock===null)return unknown(sku,"SHOPIFY_INVENTORY_UNVERIFIED");
 if(!TARGET_BRANDS.has(product.vendor))
    return {sku,brand:product.vendor,shopify_available:stock,
      season_cohort:"OUT_OF_SCOPE_BRAND",finding:"OUT_OF_SCOPE"};
 if(season.type!=="metaobject_reference"||typeof season.value!=="string"||
    !/^gid:\/\/shopify\/Metaobject\/[1-9]\d{0,24}$/.test(season.value))
    return unknown(sku,"SHOPIFY_SEASON_METAOBJECT_UNVERIFIED");
 return {sku,brand:product.vendor,shopify_available:stock,
    season_cohort:season.value===SHOPIFY_SEASON_ID?"TARGET_AW_2026_2027":"OTHER_SEASON",
    finding:season.value===SHOPIFY_SEASON_ID?"WAITING_AMAZON_EVIDENCE":"OUT_OF_SCOPE"};
}
function classify(shop:Row,seller:Row):Row{
 const sku=String(shop.sku),cohort=shop.season_cohort;
 if(cohort!=="TARGET_AW_2026_2027")
    return {...shop,amazon_seller_state:"NOT_EVALUATED",amazon_quantity:null,amazon_buyable:null};
 const state=seller.state;
 if(seller.sku!==sku||!["PRESENT","PRESENT_ATTRIBUTES_UNKNOWN","VERIFIED_ABSENT","UNKNOWN"].includes(String(state)))
    return {...shop,finding:"INSUFFICIENT_EVIDENCE",reason:"AMAZON_LISTING_IDENTITY_UNVERIFIED",
      amazon_quantity:null,amazon_buyable:null};
 if(state==="VERIFIED_ABSENT")return {...shop,finding:"SELLER_SKU_VERIFIED_ABSENT_NOT_ZERO",
      amazon_seller_state:state,amazon_quantity:null,amazon_buyable:false};
 if(state!=="PRESENT"||seller.identity_state!=="VERIFIED"||
    seller.fulfillment_state!=="VERIFIED"||seller.observation_complete!==true)
    return {...shop,finding:"INSUFFICIENT_EVIDENCE",reason:"AMAZON_LISTING_UNVERIFIED",
      amazon_seller_state:String(state),amazon_quantity:null,amazon_buyable:null};
 const quantity=verifiedQuantity(seller.current_fbm_quantity);
 if(quantity===null||!Array.isArray(seller.statuses))
    return {...shop,finding:"INSUFFICIENT_EVIDENCE",reason:"AMAZON_QUANTITY_OR_BUYABLE_UNVERIFIED",
      amazon_quantity:null,amazon_buyable:null};
 const buyable=seller.statuses.includes("BUYABLE");
 return {...shop,amazon_seller_state:state,amazon_quantity:quantity,amazon_buyable:buyable,
  finding:quantity>0&&buyable?"TARGET_POSITIVE_BUYABLE_REQUIRES_CHANNABLE_RULE_REVIEW":
    "TARGET_NOT_CURRENTLY_POSITIVE_BUYABLE"};
}
export async function readAmazonItSeasonalStockAudit(raw:unknown,env:Env,deps:Dependencies={}):Promise<Row>{
 const skus=validateInput(raw);
 const shopifyRows=await Promise.all(skus.map(async sku=>{
   try{
    const data=await(deps.readShopify??shopifyGraphQL)(env,QUERY,{skuQuery:'sku:"'+sku+'"'});
    return parseShopify(sku,data);
   }catch{return unknown(sku,"SHOPIFY_SEASON_READ_FAILED");}
 }));
 let listings:Row;
 try{listings=obj(await(deps.readListings??readAmazonSellerListingsDirect)(
   {marketplace:"IT",skus},env));}
 catch{return {ok:false,status:"INCOMPLETE_AUDIT",reason:"AMAZON_LISTING_READ_FAILED",
    results:shopifyRows.map(s=>s.season_cohort==="TARGET_AW_2026_2027"?
      {...s,finding:"INSUFFICIENT_EVIDENCE",reason:"AMAZON_LISTING_READ_FAILED"}:s),
    ...flags};}
 if(listings.ok!==true||listings.marketplace!=="IT"||
    listings.complete_evidence!==true||listings.provider_mutations!==0||
    !Array.isArray(listings.results)||listings.results.length!==skus.length)
    return {ok:false,status:"INCOMPLETE_AUDIT",reason:"AMAZON_LISTING_EVIDENCE_INCOMPLETE",
      results:[],...flags};
 const by=new Map<string,Row>();
 for(const item of listings.results){
   const x=obj(item);
   if(typeof x.sku!=="string"||!skus.includes(x.sku)||by.has(x.sku))
     return {ok:false,status:"INCOMPLETE_AUDIT",reason:"AMAZON_DUPLICATE_OR_UNKNOWN_SKU",
       results:[],...flags};
   by.set(x.sku,x);
 }
 const results=shopifyRows.map(sh=>classify(sh,by.get(String(sh.sku))??{}));
 const findings={
  target_positive_buyable:results.filter(r=>r.finding==="TARGET_POSITIVE_BUYABLE_REQUIRES_CHANNABLE_RULE_REVIEW").length,
  target_other:results.filter(r=>r.finding==="TARGET_NOT_CURRENTLY_POSITIVE_BUYABLE").length,
  target_absent:results.filter(r=>r.finding==="SELLER_SKU_VERIFIED_ABSENT_NOT_ZERO").length,
  insufficient:results.filter(r=>r.finding==="INSUFFICIENT_EVIDENCE").length,
  out_of_scope:results.filter(r=>r.finding==="OUT_OF_SCOPE").length,
 };
 return {ok:true,status:"SEASON_AUDIT_NO_CHANNABLE_RULE_PROOF",
   marketplace:"IT",source:"shopify_exact_metaobject_amazon_listings_readonly",
   observed_at:typeof listings.observed_at==="string"?listings.observed_at:null,
   requested_skus:skus.length,results,findings,
   target_shopify_season_metaobject:SHOPIFY_SEASON_ID,
   schedule_window_not_proven:true,
   warning:"POSITIVE_BUYABLE_REQUIRES_CONFIRMATION_OF_CHANNABLE_TIME_WINDOW_AND_RULE_OUTPUT",
   ...flags};
}
