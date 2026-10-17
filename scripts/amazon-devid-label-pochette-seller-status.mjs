import fs from "node:fs";
import { auditShopifyAgainstAmazon } from "./amazon-shopify-live-audit.mjs";

const MARKETS=["IT","DE","FR","ES"];
const VENDOR="devid label";
const CATEGORY="pochette e borselli";
const VALID_STATES=new Set(["ACTIVE","INACTIVE","INCOMPLETE","SUPPRESSED","UNKNOWN"]);
/**
 * Confidential identity via deterministic ordinal slot only.
 * Never publish sku, EAN, ASIN, or a reversible identifier to GitHub.
 * Human must map slots to current Shopify SKUs sorted by localeCompare
 * from an authenticated Shopify read in the same snapshot.
 */
export async function runDevidLabelPochetteSellerStatus({
  bearer,auditFn=auditShopifyAgainstAmazon
}){
 const receipt={
  schema_version:1,
  generated_at:new Date().toISOString(),
  type:"amazon_eu_devid_label_pochette_merchant_sku_presence_slots",
  scope:"Devid Label | Pochette e Borselli",
  slot_key:"sorted_shopify_sku_localeCompare_order_1_based",
  read_only:true,no_listing_writes:true,
  audit_complete:false,overall_complete:false,
  shopify_expected_slots:3,
  slots:[],market_totals:{},error_code:null
 };
 if(!bearer){receipt.error_code="amazon_pochette_slot_auth_missing";return receipt;}
 let snapshot=null,audit;
 try{
  audit=await auditFn({bearer,onPrivateSnapshot:s=>{snapshot=s;}});
 }catch{
  receipt.error_code="amazon_pochette_slot_audit_failed";return receipt;
 }
 receipt.audit_complete=audit?.complete===true &&
  audit?.shopify?.complete===true &&
  MARKETS.every(m=>audit?.amazon?.[m]?.compare_ready===true);
 receipt.audit_generated_at=audit?.generated_at||null;
 if(!receipt.audit_complete||!Array.isArray(snapshot?.rows)||
  !MARKETS.every(m=>snapshot.amazonIndexes?.[m] instanceof Map)){
  receipt.error_code="amazon_pochette_slot_source_incomplete";return receipt;
 }
 const all=snapshot.rows;
 const counts=new Map();
 for(const row of all)counts.set(row.sku,(counts.get(row.sku)||0)+1);
 const chosen=all.filter(r=>
  r.vendor?.trim().toLowerCase()===VENDOR &&
  r.product_type?.trim().toLowerCase()===CATEGORY &&
  counts.get(r.sku)===1)
  .sort((a,b)=>a.sku.localeCompare(b.sku));
 if(chosen.length!==3){
  receipt.error_code="amazon_pochette_slot_unexpected_product_count";
  receipt.products_found=chosen.length;
  return receipt;
 }
 for(let i=0;i<chosen.length;i++){
  const s=chosen[i],marketStatuses={};
  for(const m of MARKETS){
   const raw=snapshot.amazonIndexes[m].get(s.sku);
   const status=raw===undefined?"MISSING":String(raw||"").trim().toUpperCase();
   marketStatuses[m]=VALID_STATES.has(status)||status==="MISSING"
    ?status:"UNVERIFIED";
  }
  receipt.slots.push({slot:i+1,statuses:marketStatuses});
 }
 for(const m of MARKETS){
  const map={ACTIVE:0,INACTIVE:0,INCOMPLETE:0,SUPPRESSED:0,UNKNOWN:0,MISSING:0,UNVERIFIED:0};
  for(const row of receipt.slots)map[row.statuses[m]]++;
  receipt.market_totals[m]=map;
 }
 receipt.overall_complete=MARKETS.every(m=>receipt.market_totals[m].UNVERIFIED===0);
 if(!receipt.overall_complete)receipt.error_code="amazon_pochette_slot_unknown_seller_status";
 return receipt;
}
if(process.env.AMAZON_DL_POCHETTE_SKU_STATUS_RUN==="true"){
 const result=await runDevidLabelPochetteSellerStatus({
   bearer:process.env.DAILY_PULSE_ACCESS_TOKEN||""
 });
 fs.writeFileSync("/tmp/amazon-dl-pochette-sku-status.json",
   JSON.stringify(result,null,2)+"\n");
 console.log(JSON.stringify(result,null,2));
}
