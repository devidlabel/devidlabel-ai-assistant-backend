import assert from "node:assert/strict";
import { runBackpacksQuickCheck } from "./amazon-backpacks-quickcheck.mjs";

const secret = "private-test-bearer";
const ean = n => { const prefix=String(n).padStart(12,"0");let sum=0;for(let i=0;i<12;i++)sum+=Number(prefix[i])*(i%2?3:1);return prefix+((10-sum%10)%10); };
const rows=Array.from({length:10},(_,i)=>({sku:"PRIVATE-BACKPACK-"+i,barcode:ean(805168921730+i),vendor:i%2?"Sprayground":"Other",product_type:"Zaini"}));
rows.push({sku:"PRIVATE-NOGTIN",barcode:"BAD",vendor:"Sprayground",product_type:"Zaini"});
rows.push({sku:"PRIVATE-COAT",barcode:ean(805168921781),vendor:"K-Way",product_type:"Giacche e cappotti"});
rows.push({sku:"PRIVATE-DUP",barcode:ean(805168921782),vendor:"Other",product_type:"Zaini"});
rows.push({sku:"PRIVATE-DUP",barcode:ean(805168921783),vendor:"Other",product_type:"Zaini"});
const markets=["IT","DE","FR","ES"];let lookups=0,throttle=false;
async function auditFn({bearer,onPrivateSnapshot}) {
  assert.equal(bearer,secret);
  onPrivateSnapshot({rows,amazonIndexes:Object.fromEntries(markets.map(m=>[m,new Map()]))});
  return {complete:true,shopify:{complete:true,eligible_variants:rows.length},amazon:Object.fromEntries(markets.map(m=>[m,{compare_ready:true}]))};
}
async function lookup({market,selected,bearer}) {
  assert.equal(bearer,secret);
  assert(markets.includes(market));lookups++;
  assert.equal(selected.length,8);
  assert(selected.every(r=>r.product_type==="Zaini"));
  if(throttle)return {ok:false,http_status:502,error_code:"amazon_catalog_batch_http_429"};
  return {ok:true,http_status:200,pages_read:1,entries:selected.map((r,i)=>({ean:r.barcode,state:i===0?"EXACT_ONE":"NO_EXACT_MATCH"}))};
}
const r=await runBackpacksQuickCheck({bearer:secret,auditFn,lookup,delayMs:0});
assert.equal(r.overall_complete,true);
assert.equal(r.sample_only,true);
assert.equal(r.results_are_full_snapshot,false);
assert.equal(r.backpack_eligible_nonduplicate_variants,11);
assert.equal(r.backpack_duplicate_sku_variants_quarantined,2);
assert.equal(lookups,4);
for(const m of markets) {
 const x=r.markets[m];
 assert.equal(x.missing_backpack_variants,11);
 assert.equal(x.missing_with_valid_ean,10);
 assert.equal(x.missing_without_valid_ean,1);
 assert.equal(x.all_safe_ean_candidates,10);
 assert.equal(x.sampled_eans,8);
 assert.equal(x.matching.EXACT_ONE,1);
 assert.equal(x.matching.NO_EXACT_MATCH,7);
}
const output=JSON.stringify(r);
for(const value of [secret,...rows.map(x=>x.sku),...rows.map(x=>x.barcode)]){
 if(value==="BAD")continue;
 assert(!output.includes(value));
}
throttle=true;lookups=0;
const blocked=await runBackpacksQuickCheck({bearer:secret,auditFn,lookup,delayMs:0});
assert.equal(blocked.overall_complete,false);
assert.equal(blocked.markets.DE.status,"SKIPPED_AFTER_THROTTLE");
assert.equal(lookups,1);
console.log("Amazon EU backpacks quick-check read-only safeguards passed");