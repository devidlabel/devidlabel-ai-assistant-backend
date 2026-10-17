import assert from "node:assert/strict";
import { classifyShopifyBarcode, auditBackpackBarcodeQuality } from "./amazon-backpack-barcode-quality.mjs";

const addCheck = digits => {
  const sum=[...digits].reverse().reduce((n,d,i)=>n+Number(d)*(i%2===0?3:1),0);
  return digits+String((10-(sum%10))%10);
};
const ean13=addCheck("805168921736");
const upc12=addCheck("03600029145");
const gtin14=addCheck("1001234567890");
const ean8=addCheck("9638507");
assert.equal(classifyShopifyBarcode(ean13),"EAN13_VALID");
assert.equal(classifyShopifyBarcode(upc12),"UPC12_VALID");
assert.equal(classifyShopifyBarcode(gtin14),"GTIN14_VALID");
assert.equal(classifyShopifyBarcode(ean8),"EAN8_VALID");
assert.equal(classifyShopifyBarcode(""),"EMPTY");
assert.equal(classifyShopifyBarcode("  "),"EMPTY");
assert.equal(classifyShopifyBarcode("invalid"),"NON_DIGIT");
assert.equal(classifyShopifyBarcode("12345"),"OTHER_NUMERIC_LENGTH");
assert.equal(classifyShopifyBarcode(ean13.slice(0,12)+"0"===ean13?ean13.slice(0,12)+"1":ean13.slice(0,12)+"0"),"EAN13_INVALID");

const bearer="masked-test-only";
const rows=[
 {sku:"SECRET-EAN13",barcode:ean13,vendor:"K-Way",product_type:"Zaini"},
 {sku:"SECRET-UPC12",barcode:upc12,vendor:"Sprayground",product_type:"Zaini"},
 {sku:"SECRET-GTIN14",barcode:gtin14,vendor:"Rains",product_type:"Zaini"},
 {sku:"SECRET-EMPTY",barcode:null,vendor:"Rains",product_type:"Zaini"},
 {sku:"SECRET-NONDIGIT",barcode:"NO BARCODE",vendor:"Sprayground",product_type:"Zaini"},
 {sku:"SECRET-EAN8",barcode:ean8,vendor:"Rains",product_type:"Zaini"},
 {sku:"SECRET-PRESENT-IT",barcode:ean13,vendor:"Sprayground",product_type:"Zaini"},
 {sku:"SECRET-COAT",barcode:null,vendor:"Rains",product_type:"Giacche e cappotti"},
 {sku:"SECRET-DUP",barcode:ean13,vendor:"Sprayground",product_type:"Zaini"},
 {sku:"SECRET-DUP",barcode:upc12,vendor:"Sprayground",product_type:"Zaini"}
];
const markets=["IT","DE","FR","ES"];
async function auditFn({bearer:provided,onPrivateSnapshot}){
 assert.equal(provided,bearer);
 onPrivateSnapshot({rows,amazonIndexes:{
  IT:new Map([["SECRET-PRESENT-IT","ACTIVE"]]),
  DE:new Map(),FR:new Map(),ES:new Map()
 }});
 return {complete:true,generated_at:"2026-10-17T20:00:00Z",
  shopify:{complete:true},amazon:Object.fromEntries(markets.map(m=>[m,{compare_ready:true}]))};
}
const r=await auditBackpackBarcodeQuality({bearer,auditFn});
assert.equal(r.complete,true);
assert.equal(r.read_only,true);
assert.equal(r.backpack_eligible_nonduplicate_variants,7);
assert.equal(r.backpack_duplicate_sku_variants_quarantined,2);
assert.equal(r.markets.IT.missing_backpacks,6);
assert.equal(r.markets.DE.missing_backpacks,7);
assert.equal(r.markets.IT.gtin_format_counts.UPC12_VALID,1);
assert.equal(r.markets.IT.gtin_format_counts.GTIN14_VALID,1);
assert.equal(r.markets.IT.gtin_format_counts.EAN13_VALID,1);
assert.equal(r.markets.IT.gtin_format_counts.EAN8_VALID,1);
assert.equal(r.markets.IT.gtin_format_counts.EMPTY,1);
assert.equal(r.markets.IT.gtin_format_counts.NON_DIGIT,1);
assert.equal(r.markets.DE.gtin_format_counts.EAN13_VALID,2);
assert.equal(r.markets.IT.vendors.find(v=>v.vendor==="Rains").missing_backpacks,3);
const persisted=JSON.stringify(r);
for (const value of [bearer,...rows.map(r=>r.sku),ean13,upc12,gtin14,ean8]) {
 assert(!persisted.includes(value),"Do not expose raw SKU, GTIN, UPC or auth");
}
const missing=await auditBackpackBarcodeQuality({bearer:"",auditFn});
assert.equal(missing.complete,false);
assert.equal(missing.error_code,"amazon_barcode_audit_auth_missing");
console.log("Backpack non-EAN GTIN format diagnostics and privacy guards passed");
