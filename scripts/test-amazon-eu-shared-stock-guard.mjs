import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const compiled=await build({entryPoints:["src/mare-business-amazon-eu-shared-stock-guard.ts"],
 bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
const dir=await mkdtemp(join(tmpdir(),"amazon-shared-stock-")),file=join(dir,"index.mjs");
await writeFile(file,compiled.outputFiles[0].text);
const {readAmazonEuSharedStockGuard:read}=await import(pathToFileURL(file).href);
await rm(dir,{recursive:true,force:true});
const sku="MOU_MUFW531009A_ELGRY_41_EU",asin="B0FZKLG86S";
const row=(qty=1,flags=["DISCOVERABLE","BUYABLE"])=>({
 state:"PRESENT",identity_state:"VERIFIED",asin,quantity_state:"VERIFIED",quantity:qty,
 statuses:flags,price_state:"VERIFIED",price:{amount:"184.00",currency_code:"EUR"},
 observation_complete:true
});
const record=(market={},other={})=>({
 sku,shopify:{state:"VERIFIED",available:1,on_hand:1,committed:0,
 source_unique_active_sku:true,inactive_duplicate_count:0},
 amazon:{IT:row(),DE:row(),FR:row(),ES:row(),...market},...other
});
const shadow=(records=[record()],extra={})=>({
 ok:true,source:"mare_amazon_eu_inventory_shadow",read_only:true,provider_mutations:0,
 writer_ownership_proven:false,requested_skus:records.length,
 observed_at:"2026-10-22T18:29:46.065Z",results:records,...extra
});
const run=async(payload=shadow(),input={skus:[sku]})=>
 read(input,{}, {readShadow:async()=>payload});
const a=await run();
assert.equal(a.ok,true);
assert.equal(a.results[0].classification,"MULTI_MARKET_BUYABLE_SHARED_POOL_UNPROVEN");
assert.equal(a.results[0].verified_market_quantity_count,4);
assert.equal(a.results[0].aligned_market_quantity_count,4);
assert.equal(a.results[0].marketplaces_buyable,4);
assert.equal(a.results[0].summed_marketplace_stock_is_not_physical_stock,true);
assert.equal(a.results[0].shopify_available,1);
assert.equal(a.safe_for_direct_writer,false);
assert.equal(a.atomic_stock_reservation_proven,false);
assert.equal(a.provider_mutations,0);
const mismatch=await run(shadow([record({DE:row(0,["DISCOVERABLE"])})]));
assert.equal(mismatch.results[0].classification,"MARKET_QUANTITY_DIFFERENCE_REQUIRES_RULE_REVIEW");
assert.equal(mismatch.results[0].different_market_quantity_count,1);
assert.equal(mismatch.results[0].channel_specific_seasonal_exception_not_checked,true);
const absent=await run(shadow([record({
 DE:{state:"VERIFIED_ABSENT",identity_state:"UNKNOWN",quantity_state:"UNKNOWN",quantity:null},
 FR:{state:"VERIFIED_ABSENT",identity_state:"UNKNOWN",quantity_state:"UNKNOWN",quantity:null},
 ES:{state:"VERIFIED_ABSENT",identity_state:"UNKNOWN",quantity_state:"UNKNOWN",quantity:null},
})]));
assert.equal(absent.results[0].classification,"QUANTITIES_ALIGNED_NO_WRITER_AUTHORITY");
assert.equal(absent.results[0].verified_market_quantity_count,1);
assert.equal(absent.results[0].marketplace_seller_absent_count,3);
assert.equal(absent.results[0].markets[1].quantity_observed,null);
assert.equal(absent.results[0].markets[1].absent_is_not_zero_quantity,true);
const unknown=await run(shadow([record({DE:{
 state:"PRESENT",identity_state:"UNKNOWN",quantity_state:"UNKNOWN",quantity:null,
 statuses:["DISCOVERABLE"]
}})]));
assert.equal(unknown.results[0].classification,"MARKETPLACE_EVIDENCE_INCOMPLETE");
assert.equal(unknown.results[0].unknown_existing_market_quantity_count,1);
const invalidShopify=await run(shadow([record({},{
 shopify:{state:"UNKNOWN",available:null,source_unique_active_sku:false}})]));
assert.equal(invalidShopify.results[0].classification,"SHOPIFY_IDENTITY_OR_STOCK_UNKNOWN");
for(const failcase of [
 shadow([],{requested_skus:1}),
 shadow([record()],{writer_ownership_proven:true}),
 shadow([record()],{read_only:false}),
 shadow([record(),record()],{requested_skus:1}),
 shadow([record()],{provider_mutations:1}),
]){
 const r=await run(failcase);
 assert.equal(r.ok,false);
 assert.equal(r.safe_for_direct_writer,false);
 assert.equal(r.can_change_inventory,false);
}
const unavailable=await read({skus:[sku]},{},{readShadow:async()=>{throw Error("private network timeout")}});
assert.equal(unavailable.ok,false);
assert.equal(unavailable.reason,"SHADOW_READ_FAILED");
for(const bad of [
 {skus:[]},{skus:[sku,sku]},{skus:[" BAD "]},
 {skus:[sku],enable_writer:true},{skus:["X".repeat(150)]}
]) await assert.rejects(()=>read(bad,{},{
 readShadow:async()=>{throw Error("should not query shadow")}
}),/amazon_shared_stock_guard_invalid_input/);
console.log("PASS Amazon EU shared stock guard: matching pool is not additive, drift may be seasonal, unknown is not zero, no writer permit");
