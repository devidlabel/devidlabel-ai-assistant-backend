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
function obj(x: unknown): Obj { return x && typeof x==="object" && !Array.isArray(x)?x as Obj:{}; }
function req(raw: unknown): {marketplace:"IT"|"DE"|"FR"|"ES";items:{sku:string;product_type:string}[]} {
  const x=obj(raw);
  if(Object.keys(x).sort().join("|")!=="items|marketplace"||typeof x.marketplace!=="string"||
    !MARKET.has(x.marketplace)||!Array.isArray(x.items)||x.items.length<1||x.items.length>8)
    throw Error("kway_create_batch_request_invalid");
  const seen=new Set<string>();
  for(const y of x.items) {
    const v=obj(y);
    if(Object.keys(v).sort().join("|")!=="product_type|sku"||
      typeof v.sku!=="string"||!SKU.test(v.sku)||v.sku!==v.sku.trim()||
      typeof v.product_type!=="string"||!TYPES.has(v.product_type)||seen.has(v.sku))
      throw Error("kway_create_batch_item_invalid");
    seen.add(v.sku);
  }
  return raw as {marketplace:"IT"|"DE"|"FR"|"ES";items:{sku:string;product_type:string}[]};
}
/**
 * Exact guarded 1-8 K-Way live listings. Existing pilot independently verifies
 * fresh EAN / seller absence on all EU markets and VALIDATION_PREVIEW, then
 * submits quantity zero. This wrapper never bypasses a pilot guard.
 * Stop on any uncertain write, and never retry.
 */
export async function createKwayNewAsinBatch(raw: unknown,env: Env,deps: Deps={}):Promise<Obj> {
  const input=req(raw), out:Obj[]=[];
  let attempts=0, verified=0, blocked=0, stop=false;
  for(const item of input.items) {
    let r:Obj;
    try {
      r=obj(await(deps.pilot??createKwayNewAsinPilot)(
        {marketplace:input.marketplace,sku:item.sku,product_type:item.product_type},env));
    } catch {
      out.push({sku:item.sku,status:"PILOT_THROWN_NO_RETRY",provider_write_attempted:"UNKNOWN"});
      stop=true;break;
    }
    const status=typeof r.status==="string" ? r.status : "UNKNOWN";
    const attempted=r.provider_write_attempted===true;
    if(attempted)attempts++;
    if(r.asin_created_verified===true&&status==="NEW_ASIN_SELLER_LISTING_VERIFIED")verified++;
    else if(!attempted)blocked++;
    const safeAsin=r.asin_created_verified===true&&typeof r.asin==="string"&&
      /^[A-Z0-9]{10}$/.test(r.asin)?r.asin:undefined;
    out.push({sku:item.sku,status,asin:safeAsin,provider_write_attempted:attempted,
      asin_created_verified:r.asin_created_verified===true,
      reason:typeof r.reason==="string"&&/^[a-z0-9_]{1,100}$/.test(r.reason)?r.reason:undefined});
    // Stop immediately on any live acknowledgement not verified by seller readback.
    if(attempted&&r.asin_created_verified!==true){stop=true;break;}
  }
  return {ok:true,status:stop?"KWAY_BATCH_STOPPED_REQUIRES_READBACK":"KWAY_BATCH_COMPLETE",
    marketplace:input.marketplace,requested:input.items.length,processed:out.length,
    live_attempts:attempts,asin_verified:verified,blocked_before_write:blocked,
    stopped_on_uncertain_write:stop,remaining_not_attempted:input.items.length-out.length,
    rows:out,live_writes_require_approval:true,price_changed:false,
    channable_changed:false,quantity_submitted_if_accepted:0};
}
