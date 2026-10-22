import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const b=await build({entryPoints:["src/marketplace-amazon-offer-candidate-scout.ts"],bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
const dir=await mkdtemp(join(tmpdir(),"amazon-offer-scout-"));
const file=join(dir,"scout.mjs");
await writeFile(file,b.outputFiles[0].text);
const {classifyOfferOnlyCandidate: classify}=await import(pathToFileURL(file).href);
await rm(dir,{recursive:true,force:true});
const t=Date.parse("2026-10-22T17:20:50.000Z");
const time=new Date(t-6000).toISOString();
const p={sku:"RNS_14040_MARSH",ean:"5715793003477",active:true,inventory_quantity:2};
const cat=(patch={},matchPatch={})=>({
 ok:true,read_only:true,source:"amazon_spapi_catalog_items_live",
 association_status:"CANDIDATES_ONLY",identifier_type:"EAN",has_created_offer:false,
 result:{marketplace:"IT",complete:true,identifiers:[
  {ean:p.ean,state:"EXACT_ONE",exact_match_count:1,asins:["B0FNKR45TQ"],...matchPatch}
 ]},...patch
});
const seller=(patch={},rowPatch={})=>({
 ok:true,source:"amazon_sp_api_get_listings_item",read_only:true,
 has_created_or_updated_offer:false,marketplace:"IT",observed_at:time,
 results:[{sku:p.sku,state:"VERIFIED_ABSENT",reason:"listings_item_404_with_verified_not_found",
  identity_reason:"listing_verified_absent",observed_at:time,...rowPatch}],...patch
});
const f=(stock=p,c=cat(),r=seller(),market="IT")=>classify(stock,market,c,r,()=>t);
const clean=f();
assert.equal(clean.state,"CANDIDATE_NEEDS_FULL_PREFLIGHT");
assert.equal(clean.can_publish,false);
assert.equal(clean.safe_for_live_offer,false);
assert(clean.reasons.includes("CHECK_CHANNABLE_ISOLATION_AND_ATOMIC_CLAIM"));
assert.equal(f(p,cat(),seller({}, {state:"PRESENT",asin:"B0FNKR45TQ",identity_state:"VERIFIED",statuses:["BUYABLE"]})).state,"EXISTING_SELLER_OFFER");
const present=f(p,cat(),seller({}, {state:"PRESENT",asin:"B0FNKR45TQ",identity_state:"VERIFIED",statuses:["DISCOVERABLE"]}));
assert.equal(present.state,"EXISTING_SELLER_OFFER");
assert(present.reasons.includes("EXISTING_OFFER_NOT_BUYABLE_REQUIRES_DIAGNOSTICS"));
assert.equal(f(p,cat(),seller({}, {state:"PRESENT_ATTRIBUTES_UNKNOWN"})).state,"SELLER_LISTING_DIAGNOSTICS");
assert.equal(f(p,cat(),seller({}, {state:"PRESENT",asin:"B0SOMETHIN",identity_state:"VERIFIED"})).state,"SELLER_LISTING_DIAGNOSTICS");
assert.equal(f(p,cat({}, {state:"NO_EXACT_MATCH",asins:[],exact_match_count:0})).state,"NEW_ASIN_RESEARCH");
assert.equal(f(p,cat({}, {state:"EXACT_MULTIPLE",asins:["B0FNKR45TQ","B0FNKR45TZ"],exact_match_count:2})).state,"UNKNOWN_RECHECK");
assert.equal(f(p,cat({source:"UNTRUSTED_FILE"})).state,"UNKNOWN_RECHECK");
assert.equal(f(p,cat({result:{marketplace:"DE",complete:true,identifiers:[{ean:p.ean,state:"EXACT_ONE",exact_match_count:1,asins:["B0FNKR45TQ"]}]}})).state,"UNKNOWN_RECHECK");
assert.equal(f(p,cat({result:{marketplace:"IT",complete:false,identifiers:[{ean:p.ean,state:"EXACT_ONE",exact_match_count:1,asins:["B0FNKR45TQ"]}]}})).state,"UNKNOWN_RECHECK");
assert.equal(f(p,cat(),seller({observed_at:"2026-10-22T16:00:00.000Z"})).state,"UNKNOWN_RECHECK");
assert.equal(f(p,cat(),seller({}, {observed_at:"2026-10-22T16:00:00.000Z"})).state,"UNKNOWN_RECHECK");
assert.equal(f(p,cat(),seller({marketplace:"ES"})).state,"UNKNOWN_RECHECK");
assert.equal(f(p,cat(),seller({read_only:false})).state,"UNKNOWN_RECHECK");
assert.equal(f(p,cat(),seller({results:[]})).state,"UNKNOWN_RECHECK");
assert.equal(f(p,cat(),seller({results:[seller().results[0],seller().results[0]]})).state,"UNKNOWN_RECHECK");
assert.equal(f(p,cat(),seller({}, {reason:"unverified_absence"})).state,"UNKNOWN_RECHECK");
assert.equal(f({...p,active:false}).state,"INVALID_SHOPIFY_IDENTITY");
assert.equal(f({...p,inventory_quantity:0}).state,"INVALID_SHOPIFY_IDENTITY");
assert.equal(f({...p,ean:"5715793003478"}).state,"INVALID_SHOPIFY_IDENTITY");
assert.equal(f({...p,sku:"RNS_ANY\\n"}).state,"INVALID_SHOPIFY_IDENTITY");
for(const record of [clean,present,f(p,cat(),seller({}, {state:"PRESENT_ATTRIBUTES_UNKNOWN"}))])assert.equal(record.safe_for_live_offer,false);
console.log("PASS Amazon Offer Only candidate scout: real-shaped catalog/seller states, exact EAN, no false publish");
