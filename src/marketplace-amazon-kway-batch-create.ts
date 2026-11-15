import { createKwayNewAsinPilot } from "./marketplace-amazon-kway-pilot.js";
import type { AmazonCredentials } from "./amazon-auth.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

type Obj = Record<string, unknown>;
type Env = AmazonCredentials & MareBusinessShopifyEnv & {
  AMAZON_SP_API_SELLER_ID?: string; AMAZON_OFFER_PREVIEW_ENABLED?: string;
};
type Deps = { pilot?: typeof createKwayNewAsinPilot };
const MARKET = new Set(["IT","DE","FR","ES"]);
const TYPES = new Set(["COAT","HAT","SHIRT","BACKPACK","SWEATER","SWEATSHIRT","SCARF",
  "HANDBAG","COSMETIC_CASE","STORAGE_BAG","TOTE_BAG","DUFFEL_BAG","WAIST_PACK"]);
const SKU = /^KWAY_[A-Za-z0-9_ .-]{1,114}$/;
type Item = {sku:string;product_type:string;source_marketplace?:"IT"|"DE"|"FR"|"ES";source_asin?:string};
function obj(x: unknown): Obj { return x && typeof x==="object" && !Array.isArray(x)?x as Obj:{}; }
function issueDiagnostics(value:unknown):Obj[]|undefined {
  if(!Array.isArray(value))return undefined;
  return value.slice(0,25).map(raw=>{
    const issue=obj(raw);
    return {code:typeof issue.code==="string"&&/^[A-Za-z0-9._-]{1,64}$/.test(issue.code)?issue.code:"UNKNOWN",
      attribute_names:(Array.isArray(issue.attribute_names)?issue.attribute_names:[])
        .filter(name=>typeof name==="string"&&/^[a-z_]{1,64}$/.test(name)).slice(0,10)};
  });
}
function previewDiagnostics(result:Obj):Obj {
  const out:Obj={};
  for(const key of ["amazon_preview_issues","amazon_issues"]) {
    const issues=issueDiagnostics(result[key]);
    if(issues!==undefined)out[key]=issues;
  }
  for(const key of ["amazon_preview_status","exact_preview_status"])
    if(result[key]==="VALID"||result[key]==="INVALID"||result[key]==="UNKNOWN")out[key]=result[key];
  return out;
}
function req(raw: unknown): {marketplace:"IT"|"DE"|"FR"|"ES";items:Item[]} {
  const x=obj(raw);
  if(Object.keys(x).sort().join("|")!=="items|marketplace"||typeof x.marketplace!=="string"||
    !MARKET.has(x.marketplace)||!Array.isArray(x.items)||x.items.length<1||x.items.length>8)
    throw Error("kway_create_batch_request_invalid");
  const seen=new Set<string>();
  for(const y of x.items) {
    const v=obj(y);
    const keys=Object.keys(v).sort().join("|");
    const expansion=keys==="product_type|sku|source_asin|source_marketplace";
    if((!expansion&&keys!=="product_type|sku")||
      typeof v.sku!=="string"||!SKU.test(v.sku)||v.sku!==v.sku.trim()||
      typeof v.product_type!=="string"||!TYPES.has(v.product_type)||seen.has(v.sku)||
      (expansion&&(typeof v.source_marketplace!=="string"||!MARKET.has(v.source_marketplace)||
        v.source_marketplace===x.marketplace||typeof v.source_asin!=="string"||
        !/^[A-Z0-9]{10}$/.test(v.source_asin))))
      throw Error("kway_create_batch_item_invalid");
    seen.add(v.sku);
  }
  return {marketplace:x.marketplace as "IT"|"DE"|"FR"|"ES",
    items:x.items.map(item=>Object.freeze({...obj(item)}) as Item)};
}
/**
 * Exact guarded 1-8 K-Way live listings. Existing pilot independently verifies
 * fresh EAN / EU identity and VALIDATION_PREVIEW, then
 * distinguishes verified expansion from new-ASIN creation. Both paths
 * submit quantity zero. This wrapper never bypasses a pilot guard.
 * Stop on any uncertain write, and never retry.
 */
export async function createKwayNewAsinBatch(raw: unknown,env: Env,deps: Deps={}):Promise<Obj> {
  const input=req(raw), out:Obj[]=[];
  let attempts=0, verified=0, expanded=0, blocked=0, stop=false;
  for(const item of input.items) {
    let r:Obj;
    try {
      r=obj(await(deps.pilot??createKwayNewAsinPilot)(
        {marketplace:input.marketplace,...item},env));
    } catch {
      out.push({sku:item.sku,status:"PILOT_THROWN_NO_RETRY",provider_write_attempted:"UNKNOWN"});
      stop=true;break;
    }
    const status=typeof r.status==="string" ? r.status : "UNKNOWN";
    const attempted=r.provider_write_attempted===true;
    if(attempted)attempts++;
    const newVerified=!item.source_marketplace&&r.asin_created_verified===true&&
      status==="NEW_ASIN_SELLER_LISTING_VERIFIED";
    const expansionVerified=!!item.source_marketplace&&r.marketplace_expansion_verified===true&&
      r.asin_created_verified===false&&status==="MARKETPLACE_EXPANSION_VERIFIED"&&
      r.asin===item.source_asin;
    if(newVerified)verified++;
    else if(expansionVerified)expanded++;
    else if(!attempted)blocked++;
    const safeAsin=(newVerified||expansionVerified)&&typeof r.asin==="string"&&
      /^[A-Z0-9]{10}$/.test(r.asin)?r.asin:undefined;
    const submissionReference=typeof r.submission_reference==="string"&&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(r.submission_reference)?r.submission_reference:undefined;
    out.push({sku:item.sku,status,asin:safeAsin,provider_write_attempted:attempted,
      ...(submissionReference?{submission_reference:submissionReference}:{}),
      ...previewDiagnostics(r),
      asin_created_verified:newVerified,marketplace_expansion_verified:expansionVerified,
      reason:typeof r.reason==="string"&&/^[a-z0-9_]{1,100}$/.test(r.reason)?r.reason:undefined});
    // Stop immediately on any live acknowledgement not verified by seller readback.
    if(attempted&&!newVerified&&!expansionVerified){stop=true;break;}
  }
  return {ok:true,status:stop?"KWAY_BATCH_STOPPED_REQUIRES_READBACK":"KWAY_BATCH_COMPLETE",
    marketplace:input.marketplace,requested:input.items.length,processed:out.length,
    live_attempts:attempts,asin_verified:verified,marketplace_expansion_verified:expanded,
    listings_verified:verified+expanded,blocked_before_write:blocked,
    stopped_on_uncertain_write:stop,remaining_not_attempted:input.items.length-out.length,
    rows:out,live_writes_require_approval:true,price_changed:false,
    channable_changed:false,quantity_submitted_if_accepted:0};
}
