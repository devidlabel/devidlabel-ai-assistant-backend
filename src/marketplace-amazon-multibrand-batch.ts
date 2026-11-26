import { createRefrigiwearNewAsinPilot } from "./marketplace-amazon-refrigiwear-pilot.js";
import type { AmazonCredentials } from "./amazon-auth.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/**
 * Bounded multi-brand SP-API LISTING batches.
 * Every item reruns private Shopify, EAN, catalog, other-market seller-absence
 * and EXACT zero-stock Amazon VALIDATION_PREVIEW guards before a live PUT.
 * Stop immediately when a write may have occurred without a trusted readback.
 * No price, positive FBM quantity, Channable mutation, or arbitrary brand aliases.
 */
type Row = Record<string, unknown>;
type Market = "IT"|"DE"|"FR"|"ES";
type Item = {sku:string;product_type:string};
type Request = {marketplace:Market;items:Item[]};
type Env = AmazonCredentials & MareBusinessShopifyEnv & {
  AMAZON_SP_API_SELLER_ID?:string; AMAZON_OFFER_PREVIEW_ENABLED?:string;
};
type Deps = {pilot?:typeof createRefrigiwearNewAsinPilot};
const MARKETS = new Set(["IT","DE","FR","ES"]);
const PREFIXES = ["COL_","ECO_","RFR_","MC2_","RNS_","RSX_"];
const TYPES = new Set(["COAT","HAT","SHIRT","BACKPACK","SWEATER","SWEATSHIRT",
  "SCARF","SOCKS","HANDBAG","BOOT","COSMETIC_CASE","STORAGE_BAG",
  "TOTE_BAG","DUFFEL_BAG","WAIST_PACK","WALLET"]);
const SKU = /^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const ASIN = /^[A-Z0-9]{10}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
function obj(x:unknown):Row {
  return x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Row:{};
}
export function validateAmazonNewAsinMultibrandBatch(raw:unknown):Request {
  const r=obj(raw);
  if(Object.keys(r).sort().join("|")!=="items|marketplace"||
     typeof r.marketplace!=="string"||!MARKETS.has(r.marketplace)||
     !Array.isArray(r.items)||r.items.length<1||r.items.length>12)
    throw Error("amazon_multibrand_batch_invalid_request");
  const seen=new Set<string>();
  const items:Item[]=[];
  for(const rawItem of r.items){
    const item=obj(rawItem),sku=item.sku,pt=item.product_type;
    if(Object.keys(item).sort().join("|")!=="product_type|sku"||
       typeof sku!=="string"||!SKU.test(sku)||sku!==sku.trim()||
       !PREFIXES.some(prefix=>sku.startsWith(prefix))||
       typeof pt!=="string"||!TYPES.has(pt)||
       seen.has(sku.toUpperCase()))
      throw Error("amazon_multibrand_batch_invalid_item");
    seen.add(sku.toUpperCase());
    items.push({sku,product_type:pt});
  }
  return {marketplace:r.marketplace as Market,items};
}
function safeStatus(x:unknown):string {
  return typeof x==="string"&&/^[A-Z0-9_]{3,80}$/.test(x)?x:"UNKNOWN";
}
function resultRow(item:Item,raw:Row):Row {
  const originalStatus=safeStatus(raw.status);
  const status=originalStatus==="BLOCKED_REFRIGIWEAR_PILOT"?
    "BLOCKED_NEW_ASIN_PREFLIGHT":originalStatus;
  const verified=status==="NEW_ASIN_SELLER_LISTING_VERIFIED"&&
    raw.asin_created_verified===true&&
    typeof raw.asin==="string"&&ASIN.test(raw.asin)&&
    raw.provider_write_attempted===true;
  const pending=status==="NEW_ASIN_SUBMITTED_AWAITING_READBACK"&&
    raw.provider_write_attempted===true&&raw.asin_created_verified===false;
  const attempted=raw.provider_write_attempted===true||
    raw.provider_write_attempted==="UNKNOWN";
  const submission=typeof raw.submission_reference==="string"&&
    REF.test(raw.submission_reference)?raw.submission_reference:null;
  const issues=Array.isArray(raw.amazon_issues)?raw.amazon_issues.slice(0,15).map(x=>{
    const a=obj(x);
    return {code:typeof a.code==="string"&&/^[0-9A-Za-z._-]{1,64}$/.test(a.code)?
      a.code:"UNKNOWN",attribute_names:Array.isArray(a.attribute_names)?
        a.attribute_names.filter(x=>typeof x==="string"&&/^[a-z_]{1,64}$/.test(x)).slice(0,8):[]};
  }):[];
  return {sku:item.sku,product_type:item.product_type,status,
    provider_write_attempted:raw.provider_write_attempted===true?true:
      raw.provider_write_attempted==="UNKNOWN"?"UNKNOWN":false,
    asin_created_verified:verified,buyable_verified:false,
    ...(verified?{asin:raw.asin}:{}),
    ...(submission?{submission_reference:submission}:{}),
    ...(typeof raw.reason==="string"&&/^[a-z_]{3,100}$/.test(raw.reason)?
      {reason:raw.reason}:{}),
    ...(issues.length?{amazon_issues:issues}:{}),
    ...(["INVALID","VALID","UNKNOWN"].includes(String(raw.preview_status))?
      {preview_status:raw.preview_status}:{}),
    ...(typeof raw.preview_reason==="string"&&/^[a-z_]{3,100}$/.test(raw.preview_reason)?
      {preview_reason:raw.preview_reason}:{}),
    uncertain_write:attempted&&!verified&&!pending,
    awaiting_readback:pending};
}
export async function createAmazonNewAsinMultibrandBatch(
  raw:unknown,env:Env,deps:Deps={}
):Promise<Row>{
  const input=validateAmazonNewAsinMultibrandBatch(raw);
  const rows:Row[]=[];
  let attempts=0,verified=0,pending=0,blocked=0,uncertain=false;
  for(const item of input.items){
    let rawResult:Row;
    try {
      rawResult=obj(await(deps.pilot??createRefrigiwearNewAsinPilot)(
        {marketplace:input.marketplace,sku:item.sku,product_type:item.product_type,
          allow_known_missing_attributes:false},env));
    } catch {
      rows.push({sku:item.sku,product_type:item.product_type,
        status:"SUBMISSION_OUTCOME_UNKNOWN",provider_write_attempted:"UNKNOWN",
        asin_created_verified:false,buyable_verified:false,
        uncertain_write:true,awaiting_readback:false});
      uncertain=true;
      break;
    }
    const row=resultRow(item,rawResult);
    rows.push(row);
    if(row.provider_write_attempted===true)attempts++;
    if(row.asin_created_verified===true)verified++;
    if(row.awaiting_readback===true)pending++;
    if(row.provider_write_attempted===false)blocked++;
    if(row.uncertain_write===true||row.awaiting_readback===true){
      uncertain=true;
      break;
    }
  }
  return {ok:true,status:uncertain?"MULTIBRAND_BATCH_STOPPED_REQUIRES_READBACK":
    "MULTIBRAND_BATCH_COMPLETE",marketplace:input.marketplace,
    requested:input.items.length,processed:rows.length,
    remaining_not_attempted:input.items.length-rows.length,
    live_attempts:attempts,asin_verified:verified,
    submitted_awaiting_readback:pending,blocked_before_write:blocked,
    stopped_on_uncertain_write:uncertain,rows,
    quantity_submitted_if_accepted:0,price_changed:false,
    channable_changed:false,no_automatic_retry:true,
    buyable_verified:0};
}
