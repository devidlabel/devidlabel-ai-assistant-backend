import assert from "node:assert/strict";
import {runDevidLabelPochetteSellerStatus} from "./amazon-devid-label-pochette-seller-status.mjs";
const token="test-private-token";
const rows=[
 {sku:"PRIVATE-PC5",vendor:"Devid Label",product_type:"Pochette e Borselli",barcode:"7426885112394",inventory_quantity:1},
 {sku:"PRIVATE-PC1",vendor:"Devid Label",product_type:"Pochette e Borselli",barcode:"7426885112370",inventory_quantity:2},
 {sku:"PRIVATE-PC2",vendor:"Devid Label",product_type:"Pochette e Borselli",barcode:"7426885112332",inventory_quantity:6},
 {sku:"PRIVATE-COAT",vendor:"Devid Label",product_type:"Giacche e cappotti"},
 {sku:"PRIVATE-OTHER",vendor:"K-Way",product_type:"Pochette e Borselli"}
];
async function auditFn({bearer,onPrivateSnapshot}){
 assert.equal(bearer,token);
 onPrivateSnapshot({
  rows,amazonIndexes:{
   IT:new Map([["PRIVATE-PC1","ACTIVE"]]),
   DE:new Map([["PRIVATE-PC1","ACTIVE"],["PRIVATE-PC2","ACTIVE"],["PRIVATE-PC5","ACTIVE"]]),
   FR:new Map([["PRIVATE-PC1","INACTIVE"],["PRIVATE-PC2","ACTIVE"],["PRIVATE-PC5","ACTIVE"]]),
   ES:new Map([["PRIVATE-PC1","ACTIVE"],["PRIVATE-PC2","ACTIVE"],["PRIVATE-PC5","ACTIVE"]])
  }
 });
 return {complete:true,generated_at:"2026-10-17T21:00:00Z",
  shopify:{complete:true},
  amazon:Object.fromEntries(["IT","DE","FR","ES"].map(m=>[m,{compare_ready:true}]))};
}
const r=await runDevidLabelPochetteSellerStatus({bearer:token,auditFn});
assert.equal(r.overall_complete,true);
assert.equal(r.read_only,true);
assert.equal(r.slots.length,3);
assert.deepEqual(r.slots.map(s=>s.statuses.IT),["ACTIVE","MISSING","MISSING"]);
assert.equal(r.market_totals.IT.MISSING,2);
assert.equal(r.market_totals.DE.ACTIVE,3);
assert.equal(r.market_totals.FR.INACTIVE,1);
const serialized=JSON.stringify(r);
for(const secret of [token,...rows.map(r=>r.sku),...rows.map(r=>r.barcode).filter(Boolean)]){
 assert(!serialized.includes(secret),"No SKU EAN bearer or ASIN may appear in public receipt");
}
const fail=await runDevidLabelPochetteSellerStatus({
 bearer:"",auditFn
});
assert.equal(fail.overall_complete,false);
assert.equal(fail.error_code,"amazon_pochette_slot_auth_missing");
console.log("Devid Label Pochette private per-slot seller-SKU status safeguards passed");
