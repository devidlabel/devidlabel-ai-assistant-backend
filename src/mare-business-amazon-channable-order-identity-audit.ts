import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { readAmazonOrdersPilot } from "./marketplace-amazon-orders-readonly.js";
import { readShopifyChannableAmazonAdoptionIndex } from "./marketplace-shopify-channable-amazon-adoption.js";
import type { AmazonCredentials } from "./amazon-auth.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/** Joint merchant-private READ ONLY Amazon/Channable order-identity audit.
 * Deliberately reports no raw order IDs, SKUs, tracking or customer details.
 * Amazon filter uses LAST UPDATED, Shopify filter uses CREATED timestamp.
 * These counts are NOT directly comparable without ID matching. A missing
 * observation is NEVER proof of a missing order or permission to import.
 */
type Row = Record<string, unknown>;
type Market = keyof typeof AMAZON_EU_MARKETPLACES;
type Env = AmazonCredentials & MareBusinessShopifyEnv & { AMAZON_SP_API_SELLER_ID?: string };
export type AuditDeps={
  amazon?:typeof readAmazonOrdersPilot;
  shopify?:typeof readShopifyChannableAmazonAdoptionIndex;
};
type Input={
  marketplaces:Market[];
  amazon_updated_after:string;
  amazon_updated_before:string;
  shopify_created_after:string;
  shopify_created_before:string;
  amazon_max_pages:number;
  shopify_max_pages:number;
};
const TIME=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/;
const ID=/^\d{3}-\d{7}-\d{7}$/;
const GID=/^gid:\/\/shopify\/Order\/[1-9]\d*$/;
const DAY=86400_000;
const FLAGS={
  read_only:true,provider_mutations:0,
  orders_imported:0,orders_created:0,inventory_mutations:0,
  tracking_updates:0,shopify_order_creation_authorized:false,
  missing_imports_proven:false,can_advance_order_import_cursor:false,
  current_importer_owner:"CHANNABLE",customer_personal_data_returned:false,
} as const;
function object(x:unknown):Row {return x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Row:{};}
function timestamp(x:unknown):string {
  if(typeof x!=="string"||!TIME.test(x)||!Number.isFinite(Date.parse(x)))
    throw Error("amazon_channable_audit_invalid_timestamp");
  return new Date(x).toISOString();
}
function integer(x:unknown,min:number,max:number):x is number{
  return typeof x==="number"&&Number.isSafeInteger(x)&&x>=min&&x<=max;
}
function validate(raw:unknown):Input{
  const x=object(raw);
  if(Object.keys(x).some(k=>![
     "marketplaces","amazon_updated_after","amazon_updated_before",
     "shopify_created_after","shopify_created_before","amazon_max_pages","shopify_max_pages",
    ].includes(k)))throw Error("amazon_channable_audit_invalid_request");
  if(!Array.isArray(x.marketplaces)||x.marketplaces.length<1||x.marketplaces.length>4||
    x.marketplaces.some(m=>typeof m!=="string"||!Object.hasOwn(AMAZON_EU_MARKETPLACES,m))||
    new Set(x.marketplaces).size!==x.marketplaces.length)
    throw Error("amazon_channable_audit_invalid_markets");
  const aua=timestamp(x.amazon_updated_after),aub=timestamp(x.amazon_updated_before);
  const sca=timestamp(x.shopify_created_after),scb=timestamp(x.shopify_created_before);
  const a=Date.parse(aua),b=Date.parse(aub),c=Date.parse(sca),d=Date.parse(scb);
  if(a>=b||b-a>7*DAY||c>=d||d-c>14*DAY)
    throw Error("amazon_channable_audit_invalid_window");
  const amazonPages=x.amazon_max_pages===undefined?3:x.amazon_max_pages;
  const shopifyPages=x.shopify_max_pages===undefined?5:x.shopify_max_pages;
  if(!integer(amazonPages,1,5)||!integer(shopifyPages,1,10))
    throw Error("amazon_channable_audit_invalid_pages");
  return {
    marketplaces:x.marketplaces as Market[],
    amazon_updated_after:aua,amazon_updated_before:aub,
    shopify_created_after:sca,shopify_created_before:scb,
    amazon_max_pages:amazonPages,shopify_max_pages:shopifyPages,
  };
}
function guardedAmazon(raw:Row,input:Input):Row[]|null{
  if(raw.ok!==true||raw.read_only!==true||
     raw.source!=="amazon_spapi_orders_2026_01_01"||
     raw.identity_scope!=="SELLER_ACCOUNT_PLUS_ORDER_ID"||
     raw.fulfilled_by!=="MERCHANT"||raw.complete_pagination!==true||
     raw.last_updated_after!==input.amazon_updated_after||
     raw.last_updated_before!==input.amazon_updated_before||
     !Array.isArray(raw.orders)||raw.order_count!==raw.orders.length||
     !Array.isArray(raw.selected_marketplaces)||
     raw.selected_marketplaces.length!==input.marketplaces.length||
     raw.selected_marketplaces.some((m:unknown)=>!input.marketplaces.includes(m as Market)))
    return null;
  const account=raw.account_id;
  if(typeof account!=="string"||!/^[A-Z0-9]{8,30}$/.test(account))return null;
  const permitted=new Set<string>(input.marketplaces.map(m=>AMAZON_EU_MARKETPLACES[m]));
  const seen=new Set<string>();
  const orders:Row[]=[];
  for(const record of raw.orders){
    const x=object(record);
    if(x.account_id!==account||typeof x.order_id!=="string"||!ID.test(x.order_id)||
      x.order_key!== "amazon:"+account+":"+x.order_id||
      typeof x.created_at!=="string"||!TIME.test(x.created_at)||
      typeof x.last_updated_at!=="string"||!TIME.test(x.last_updated_at)||
      !Number.isFinite(Date.parse(x.created_at))||
      !Number.isFinite(Date.parse(x.last_updated_at))||
      Date.parse(x.last_updated_at)<Date.parse(input.amazon_updated_after)||
      Date.parse(x.last_updated_at)>Date.parse(input.amazon_updated_before)||
      typeof x.marketplace_id!=="string"||!permitted.has(x.marketplace_id)||
      seen.has(x.order_key)||x.fulfillment_owner!=="MERCHANT"||
      x.contains_customer_data!==false)
      return null;
    seen.add(x.order_key);
    orders.push(x);
  }
  return orders;
}
function guardedShopify(raw:Row,input:Input):Row[]|null{
  if(raw.ok!==true||raw.source!=="shopify_channable_amazon_order_signature"||
     raw.read_only!==true||raw.pagination_complete!==true||
     raw.order_importer_owner!=="CHANNABLE"||
     raw.absence_proven!==false||raw.safe_to_create_shopify_order!==false||
     raw.created_after!==input.shopify_created_after||
     raw.created_before!==input.shopify_created_before||
     !Array.isArray(raw.found)||raw.found_count!==raw.found.length||
     !Array.isArray(raw.unverified)||raw.unverified_count!==raw.unverified.length)
    return null;
  const ids=new Set<string>(),gids=new Set<string>(),found:Row[]=[];
  for(const record of raw.found){
    const x=object(record);
    if(typeof x.amazon_order_id!=="string"||!ID.test(x.amazon_order_id)||
       typeof x.shopify_order_gid!=="string"||!GID.test(x.shopify_order_gid)||
       x.source_name!=="amazon"||x.importing_app!=="Channable"||
       x.adoption_status!=="FOUND_CHANNABLE"||
       typeof x.shopify_created_at!=="string"||!TIME.test(x.shopify_created_at)||
       !Number.isFinite(Date.parse(x.shopify_created_at))||
       Date.parse(x.shopify_created_at)<Date.parse(input.shopify_created_after)||
       Date.parse(x.shopify_created_at)>Date.parse(input.shopify_created_before)||
       ids.has(x.amazon_order_id)||gids.has(x.shopify_order_gid))
      return null;
    ids.add(x.amazon_order_id);gids.add(x.shopify_order_gid);found.push(x);
  }
  return found;
}
export async function readAmazonChannableOrderIdentityAudit(
  request:unknown,env:Env,deps:AuditDeps={},
):Promise<Row>{
  const input=validate(request);
  const fail=(reason:string):Row=>({
    ok:false,status:"INCOMPLETE_READ_ONLY_AUDIT",reason,requested_markets:input.marketplaces,
    ...FLAGS,
    counts_usable_for_missing_order_decisions:false,
  });
  const amazonFn=deps.amazon??readAmazonOrdersPilot;
  const shopifyFn=deps.shopify??readShopifyChannableAmazonAdoptionIndex;
  let amazon:Row={},shopify:Row={};
  const results=await Promise.allSettled([
    amazonFn({marketplaces:input.marketplaces,last_updated_after:input.amazon_updated_after,
      last_updated_before:input.amazon_updated_before,max_pages:input.amazon_max_pages},env),
    shopifyFn({created_after:input.shopify_created_after,created_before:input.shopify_created_before,
      max_pages:input.shopify_max_pages},env),
  ]);
  if(results.some(r=>r.status!=="fulfilled"))return fail("PROVIDER_READ_FAILED");
  amazon=object(results[0].status==="fulfilled"?results[0].value:null);
  shopify=object(results[1].status==="fulfilled"?results[1].value:null);
  const orders=guardedAmazon(amazon,input),found=guardedShopify(shopify,input);
  if(!orders||!found)return fail("PROVIDER_RESULT_NOT_VERIFIED");
  const shopifyIds=new Set(found.map(x=>x.amazon_order_id));
  const amazonIds=new Set(orders.map(x=>x.order_id));
  const matched=orders.filter(x=>shopifyIds.has(x.order_id));
  const unmatched=orders.filter(x=>!shopifyIds.has(x.order_id));
  const shopifyStart=Date.parse(input.shopify_created_after);
  const shopifyEnd=Date.parse(input.shopify_created_before);
  const outside=unmatched.filter(x=>Date.parse(String(x.created_at))<shopifyStart||
    Date.parse(String(x.created_at))>shopifyEnd);
  const inScope=unmatched.length-outside.length;
  const onlyShopify=found.filter(x=>!amazonIds.has(x.amazon_order_id));
  const zeroQuantityLines=integer(amazon.zero_quantity_line_count,0,1_000_000)?
    amazon.zero_quantity_line_count: null;
  const result={
    ok:true,status:"COMPLETE_OBSERVATION_NO_IMPORT_AUTHORITY",
    source:"amazon_channable_order_identity_audit",
    amazon_updated_window:{after:input.amazon_updated_after,before:input.amazon_updated_before},
    shopify_created_window:{after:input.shopify_created_after,before:input.shopify_created_before},
    selected_marketplaces:input.marketplaces,
    amazon_pages_read:amazon.pages_read,shopify_pages_read:shopify.pages_read,
    amazon_orders_observed:orders.length,
    shopify_channable_orders_observed:found.length,
    matched_amazon_order_ids:matched.length,
    amazon_unmatched_created_outside_shopify_window:outside.length,
    amazon_unmatched_created_inside_shopify_window:inScope,
    shopify_orders_not_in_amazon_updated_window:onlyShopify.length,
    shopify_unverified_orders:shopify.unverified_count,
    amazon_zero_quantity_line_count:zeroQuantityLines,
    counts_are_different_time_dimensions:true,
    all_amazon_orders_confirmed_imported_in_selected_observation:
      unmatched.length===0&&shopify.unverified_count===0,
    unverified_or_outside_window_requires_reconciliation:
      unmatched.length>0||onlyShopify.length>0||shopify.unverified_count!==0||
      (zeroQuantityLines??0)>0,
    ...FLAGS,
    next_step:"RECONCILE_EXACT_ORDER_ID_AND_WIDEN_CREATION_WINDOW_FOR_OBSERVATION_ONLY",
  };
  return result;
}
