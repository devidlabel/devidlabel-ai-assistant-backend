import assert from "node:assert/strict";
import {buildAmazonItExistingRecoveryWorklist as build,worklistCsv} from "./amazon-it-existing-recovery-worklist.mjs";
const h="Status\tReason\tSKU\tASIN\tProduct name\tCondition\tStatus Change Date\tIssue Description";
const tsv=[
 h,
 "Inactive\tGPSR missing responsible person\tECO_MCWGAJKMORA00048W26_021_XS\tB0HMN12H1L\tGiacca\tNew\t2026-10-24\tProduct safety GPSR contact",
 "INACTIVE\t100632\tPUI_101_101_VINTAGE_ECLIPSE_43_EU\tB0HMPJYY5X\tSneaker\tNew\t2026-10-24\tQualification required",
 "INACTIVE\t8541 matching conflict\tGML_FW2617008_SABLE_2\tB0HLQ4D3VG\tPullover\tNew\t2026-10-24\tConflitto di corrispondenza",
 "INACTIVE\tGPSR\tZERO_STOCK\tB012345678\tNo stock\tNew\t2026-10-24\tGPSR",
 "DELETED\tGPSR\tDELETED_SKU\tB012345679\tDeleted\tNew\t2026-10-24\tGPSR",
 "INACTIVE\tGPSR\tUNKNOWN_SKU\tB012345680\tUnknown\tNew\t2026-10-24\tGPSR",
 "INACTIVE\tGPSR\tMISSING_ASIN\t\tMissing ASIN\tNew\t2026-10-24\tGPSR",
 "INACTIVE\tGPSR\tINACTIVE_SHOPIFY\tB012345681\tInactive Shopify\tNew\t2026-10-24\tGPSR",
 "INACTIVE\tGPSR\tINVALID_QTY\tB012345682\tInvalid stock\tNew\t2026-10-24\tGPSR",
 "INACTIVE\tGPSR\tECO_MCWGAJKMORA00048W26_021_XS\tB0HMN12H1L\tDuplicate SKU\tNew\t2026-10-24\tGPSR",
].join("\r\n");
const shopify={truncated:false,next_cursor:null,products:[
 {status:"ACTIVE",vendor:"Ecoalf",product_type:"Giacche",variants:[
  {sku:"ECO_MCWGAJKMORA00048W26_021_XS",inventory_quantity:1,barcode:"8445336921186"},
  {sku:"ZERO_STOCK",inventory_quantity:0}]},
 {status:"ACTIVE",vendor:"Puraai",product_type:"Sneakers",variants:[
  {sku:"PUI_101_101_VINTAGE_ECLIPSE_43_EU",inventoryQuantity:2,barcode:"8388780085823"}]},
 {status:"ACTIVE",vendor:"Grace & Mila",product_type:"Maglieria",variants:[
  {sku:"GML_FW2617008_SABLE_2",inventory_quantity:1}]},
 {status:"ACTIVE",vendor:"Other",variants:[
  {sku:"MISSING_ASIN",inventory_quantity:1},{sku:"INVALID_QTY",inventory_quantity:null}]},
 {status:"DRAFT",vendor:"Other",variants:[{sku:"INACTIVE_SHOPIFY",inventory_quantity:5}]},
]};
const x=build(tsv,shopify),s=x.summary;
assert.equal(s.marketplace,"IT");
assert.equal(s.read_only,true);
assert.equal(s.listing_updates,0);
assert.equal(s.safe_to_publish,false);
assert.equal(s.manufacturer_verified,false);
assert.equal(s.responsible_person_verified,false);
assert.equal(s.report_marketplace_must_be_verified_externally,true);
assert.equal(s.shopify_catalog_exhaustive,true);
assert.equal(s.rows_scanned,10);
assert.equal(s.positive_stock_existing_asin,3);
assert.equal(s.zero_stock_excluded,1);
assert.equal(s.missing_shopify_excluded,1);
assert.equal(s.missing_asin_excluded,1);
assert.equal(s.not_active_shopify_excluded,1);
assert.equal(s.deleted_or_not_inactive_excluded,1);
assert.equal(s.invalid_or_duplicate_excluded,2);
assert.deepEqual(s.by_blocker,{"GPSR_DATA_REVIEW":1,"QUALIFICATION_100632_REVIEW":1,"CATALOG_IDENTITY_8541":1});
assert.equal(x.worklist[0].brand,"Ecoalf");
assert.equal(x.worklist[0].blocker,"GPSR_DATA_REVIEW");
assert.equal(x.worklist[1].brand,"Puraai");
assert.equal(x.worklist[2].blocker,"CATALOG_IDENTITY_8541");
assert(x.worklist.every(z=>z.direct_seller_sku_asin_verification==="REQUIRED"));
assert(!JSON.stringify(x).includes("manufacturer_email"));
const csv=worklistCsv(x.worklist);
assert.equal(csv.split("\n").filter(Boolean).length,4);
assert(csv.includes("B0HMN12H1L"));
for(const bad of [
 "no\tvalid\theader\nx\ty\tz",
 h,
 h+"\nINACTIVE\tGPSR\tSKIP\tB012345678\tbad\tNew\tToday\t\"unfinished",
])assert.throws(()=>build(bad,shopify),/amazon_report_/);
const partial=build(tsv,{...shopify,truncated:true,next_cursor:"some-cursor"});
assert.equal(partial.summary.shopify_catalog_exhaustive,false);
const duplicateShopify={...shopify,products:[...shopify.products,{
 status:"ACTIVE",vendor:"Duplicate",variants:[
  {sku:"ECO_MCWGAJKMORA00048W26_021_XS",inventory_quantity:1}]}]};
const d=build(tsv,duplicateShopify);
assert.equal(d.summary.positive_stock_existing_asin,2);
assert.equal(d.worklist.some(x=>x.brand==="Ecoalf"),false);
console.log("amazon it existing ASIN stock-positive worklist: PASS");