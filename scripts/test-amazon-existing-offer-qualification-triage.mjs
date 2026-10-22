import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const buildResult=await build({entryPoints:["src/mare-business-amazon-existing-offer-triage.ts"],
 bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const temp=await mkdtemp(join(tmpdir(),"offer-100632-live-reader-"));
const filepath=join(temp,"reader.mjs");await writeFile(filepath,buildResult.outputFiles[0].text);
const {readAmazonExistingOfferQualificationTriage:read}=await import(pathToFileURL(filepath).href);
await rm(temp,{recursive:true,force:true});
const sample={sku:"PUI_101_101_VINTAGE_OSSO_40_EU",ean:"8388780086400"};
const asin="B0HMPBFHN8";
const market="ES";
const origin=(m,row={})=>({
 ok:true,marketplace:m,source:"amazon_sp_api_get_listings_item",
 read_only:true,has_created_or_updated_offer:false,
 results:[{sku:sample.sku,state:"PRESENT",asin,identity_state:"VERIFIED",
  statuses:m==="IT"?["DISCOVERABLE","BUYABLE"]:["DISCOVERABLE"],
  issue_signals:m==="IT"?[]:[{code:"100632",severity:"ERROR"},{code:"100527",severity:"WARNING"}],
  ...row}]
});
const restriction=(row={},out={})=>({
 ok:true,read_only:true,provider_mutations:0,marketplace:market,
 results:[{sku:sample.sku,asin,restriction_count:0,reason_codes:[],
  seller_central_links:[],status:"NO_RESTRICTIONS_RETURNED_NOT_APPROVAL_PROOF",...row}],
 ...out
});
const matches=(record={})=>({
 ok:true,source:"amazon_spapi_catalog_items_live",read_only:true,identifier_type:"EAN",
 result:{marketplace:market,complete:true,identifiers:[{
 ean:sample.ean,state:"EXACT_ONE",exact_match_count:1,asins:[asin],...record
 }]}
});
const details=(state="READ_ONLY_DETAILS_COMPLETE")=>({
 ok:true,source:"amazon_spapi_catalog_item_live",read_only:true,marketplace:market,
 results:[{asin,state,brand:"PURAAI",product_types:["SHOES"]}]
});
const deps=(patch={})=>({
 listings:async({marketplace,skus})=>{assert.deepEqual(skus,[sample.sku]);return origin(marketplace)},
 restrictions:async({marketplace,skus})=>{assert.equal(marketplace,market);assert.deepEqual(skus,[sample.sku]);return restriction()},
 matching:async({marketplace,identifiers,identifier_type})=>{assert.equal(marketplace,market);
  assert.deepEqual(identifiers,[sample.ean]);assert.equal(identifier_type,"EAN");return matches()},
 details:async({marketplace,asins})=>{assert.equal(marketplace,market);assert.deepEqual(asins,[asin]);return details()},
 ...patch,
});
const input={marketplace:market,items:[sample],compare_marketplace:"IT"};
const env={};
const run=async(p={},mock={})=>read({...input,...p},env,deps(mock));
const support=await run();
assert.equal(support.ok,true);assert.equal(support.results[0].state,"SELLER_SUPPORT_100632_NO_APPLICATION_LINK");
assert.equal(support.results[0].counterpart_buyable,true);
assert.equal(support.results[0].seller_central_approval_url,null);
assert.equal(support.brand_approval_proven,false);
assert.equal(support.can_publish,false);
assert.equal(support.applications_created,0);
assert.equal(support.provider_mutations,0);
assert.deepEqual(support.results[0].additional_issue_codes,["100527"]);
const approvalUrl="https://sellercentral.amazon.es/hz/approvalrequest/restrictions/approve?asin="+asin;
const approvedLink=await run({}, {restrictions:async()=>restriction({
 status:"RESTRICTIONS_REPORTED",restriction_count:1,reason_codes:["APPROVAL_REQUIRED"],
 seller_central_links:[approvalUrl]})});
assert.equal(approvedLink.results[0].state,"SELLER_CENTRAL_APPROVAL_LINK");
assert.equal(approvedLink.results[0].seller_central_approval_url,approvalUrl);
assert.equal(approvedLink.results[0].brand_approval_proven,false);
const missing=await run({},{
 restrictions:async()=>restriction({status:"RESTRICTIONS_REPORTED",
  restriction_count:1,reason_codes:["ASIN_NOT_FOUND"]}),
 details:async()=>details("ASIN_NOT_FOUND"),
 matching:async()=>matches({state:"NO_EXACT_MATCH",exact_match_count:0,asins:[]}),
});
assert.equal(missing.results[0].state,"CATALOG_IDENTITY_ESCALATION");
const wrongEAN=await run({}, {matching:async()=>matches({asins:["B0HMPBFHN9"]})});
assert.equal(wrongEAN.results[0].state,"CATALOG_IDENTITY_ESCALATION");
const noIdentity=await run({}, {listings:async({marketplace})=>origin(marketplace,{state:"PRESENT_ATTRIBUTES_UNKNOWN",asin:null,identity_state:"UNKNOWN"})});
assert.equal(noIdentity.results[0].state,"SELLER_IDENTITY_DIAGNOSTICS");
const already=await run({}, {listings:async({marketplace})=>origin(marketplace,{statuses:["BUYABLE"]})});
assert.equal(already.results[0].state,"EXISTING_OFFER_BUYABLE");
const malicious=await run({}, {restrictions:async()=>restriction({status:"RESTRICTIONS_REPORTED",
 restriction_count:1,reason_codes:["APPROVAL_REQUIRED"],
 seller_central_links:["https://sellercentral.amazon.es.attacker.example/approve?asin="+asin]})});
assert.equal(malicious.results[0].state,"RECHECK_REQUIRED");
assert.equal(malicious.results[0].seller_central_approval_url,null);
const unavailable=await run({}, {restrictions:async()=>{throw Error("synthetic timeout")}});
assert.equal(unavailable.results[0].state,"RECHECK_REQUIRED");
for(const invalid of [
 {items:[{...sample,ean:"8388780086401"}]},
 {items:[sample,sample]},
 {items:[{...sample,ean:"missing"}]},
 {compare_marketplace:"ES"},
 {extra:"user_override"}
]) await assert.rejects(()=>run(invalid),/amazon_existing_offer_triage_invalid_request/);
console.log("PASS MARE Amazon existing offer 100632 live read-only routing, official approval URL and catalog escalation");
