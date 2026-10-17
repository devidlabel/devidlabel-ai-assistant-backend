import assert from "node:assert/strict";
import { runBorseCatalogAudit } from "./amazon-borse-matching.mjs";

const token = "private-test-token";
const ean = n => {
  const digits=String(n).padStart(12,"0");
  const sum=[...digits].reduce((s,c,i)=>s+Number(c)*(i%2?3:1),0);
  return digits+((10-sum%10)%10);
};
const upc = n => {
  const digits=String(n).padStart(11,"0");
  const sum=[...digits].reduce((s,c,i)=>s+Number(c)*(i%2?1:3),0);
  return digits+((10-sum%10)%10);
};
const rows=[
  ...Array.from({length:8},(_,i)=>({sku:"PRIVATE-EAN-"+i,
    barcode:ean(805168921730+i),vendor:i%2?"MC2 Saint Barth":"Manila Grace",
    product_type:"Borse"})),
  ...Array.from({length:4},(_,i)=>({sku:"PRIVATE-UPC-"+i,
    barcode:upc(36000291450+i),vendor:"Sprayground",
    product_type:"Borse"})),
  {sku:"PRIVATE-EMPTY",barcode:"",vendor:"Rains",product_type:"Borse"},
  {sku:"PRIVATE-GTIN14",barcode:"10012345678902",vendor:"K-Way",product_type:"Borse"},
  {sku:"PRIVATE-DUP",barcode:ean(805168921781),vendor:"MC2 Saint Barth",
    product_type:"Borse"},
  {sku:"PRIVATE-DUP",barcode:ean(805168921782),vendor:"MC2 Saint Barth",
    product_type:"Borse"},
  {sku:"PRIVATE-OTHER-CATEGORY",barcode:ean(805168921730),vendor:"K-Way",
    product_type:"Zaini"}
];
const markets=["IT","DE","FR","ES"];
async function auditFn({bearer,onPrivateSnapshot}){
  assert.equal(bearer,token);
  onPrivateSnapshot({rows,amazonIndexes:Object.fromEntries(markets.map(m=>[m,new Map()]))});
  return {complete:true,generated_at:"2026-10-17T20:00:00Z",
    shopify:{complete:true},amazon:Object.fromEntries(markets.map(m=>[m,{compare_ready:true}]))};
}
let eanCalls=0,upcCalls=0,throttle=false;
async function lookupEAN({market,selected,bearer}){
  assert.equal(bearer,token);
  assert(markets.includes(market));
  assert(selected.length===7);
  assert(selected.every(r=>r.barcode.length===13 && r.product_type==="Borse"));
  eanCalls++;
  if(throttle)return {ok:false,http_status:429,error_code:"amazon_catalog_batch_http_429"};
  return {ok:true,http_status:200,pages_read:2,entries:selected.map((r,i)=>({
    ean:r.barcode,state:i===0?"EXACT_ONE":"NO_EXACT_MATCH"}))};
}
async function lookupUPC({market,selected,bearer}){
  assert.equal(bearer,token);
  assert(markets.includes(market));
  assert(selected.length===4);
  assert(selected.every(r=>r.barcode.length===12 && r.product_type==="Borse"));
  upcCalls++;
  return {ok:true,http_status:200,pages_read:1,entries:selected.map((r,i)=>({
    upc:r.barcode,state:i===0?"EXACT_ONE":"NO_EXACT_MATCH"}))};
}
const report=await runBorseCatalogAudit({bearer:token,auditFn,
  eanLookup:lookupEAN,upcLookup:lookupUPC,delayMs:0});
assert.equal(report.overall_complete,true);
assert.equal(report.results_are_full_snapshot,true);
assert.equal(report.read_only,true);
assert.equal(report.no_listing_writes,true);
assert.equal(report.eligible_unique_sku_variants,14);
assert.equal(report.duplicate_sku_variants_quarantined,2);
assert.equal(eanCalls,4);
assert.equal(upcCalls,4);
for(const m of markets){
  const s=report.markets[m];
  assert.equal(s.status,"COMPLETE");
  assert.equal(s.missing_from_seller_report,14);
  assert.equal(s.identifier_groups.EAN.candidates,7);
  assert.equal(s.identifier_groups.EAN.searched,7);
  assert.equal(s.identifier_groups.UPC.candidates,4);
  assert.equal(s.identifier_groups.UPC.searched,4);
  assert.equal(s.blank_or_invalid_gtin,1);
  assert.equal(s.other_valid_gtin_format_not_queried,1);
  assert.equal(s.duplicate_gtin_rows_quarantined,1);
  assert.equal(s.match_counts.EXACT_ONE,2);
  assert.equal(s.match_counts.NO_EXACT_MATCH,9);
  assert.equal(s.vendor_breakdown.reduce((a,v)=>a+v.searched,0),11);
}
const publicString=JSON.stringify(report);
for(const sensitive of [token,...rows.map(r=>r.sku),
  ...rows.map(r=>r.barcode).filter(Boolean)]){
  assert(!publicString.includes(sensitive),"No raw SKU, UPC, EAN or token in public report");
}
throttle=true;eanCalls=0;upcCalls=0;
const incomplete=await runBorseCatalogAudit({bearer:token,auditFn,
  eanLookup:lookupEAN,upcLookup:lookupUPC,delayMs:0});
assert.equal(incomplete.overall_complete,false);
assert.equal(incomplete.error_code,"amazon_borse_throttled");
assert.equal(incomplete.markets.IT.status,"PARTIAL");
assert.equal(incomplete.markets.DE.status,"SKIPPED_AFTER_THROTTLE");
assert.equal(incomplete.markets.IT.match_counts.NO_EXACT_MATCH,0);
assert.equal(eanCalls,1);
assert.equal(upcCalls,0);
const unauthed=await runBorseCatalogAudit({bearer:"",auditFn,
  eanLookup:lookupEAN,upcLookup:lookupUPC});
assert.equal(unauthed.error_code,"amazon_borse_auth_missing");
console.log("Borse EAN UPC 4-country read-only audit and throttle safeguards passed");
