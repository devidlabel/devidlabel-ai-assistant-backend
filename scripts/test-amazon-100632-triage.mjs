import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const compiled=await build({entryPoints:["src/marketplace-amazon-100632-triage.ts"],bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const temp=await mkdtemp(join(tmpdir(),"amazon-100632-triage-"));
const file=join(temp,"triage.mjs");
await writeFile(file,compiled.outputFiles[0].text);
const {triageExisting100632:triage}=await import(pathToFileURL(file).href);
await rm(temp,{recursive:true,force:true});
const es={market:"ES",sku:"PUI_101_101_VINTAGE_OSSO_40_EU",ean:"8388780086400",asin:"B0HMPBFHN8"};
const listing=(r={},market="ES")=>({
 ok:true,source:"amazon_sp_api_get_listings_item",marketplace:market,
 read_only:true,has_created_or_updated_offer:false,
 results:[{sku:es.sku,asin:es.asin,state:"PRESENT",identity_state:"VERIFIED",
 statuses:market==="IT"?["BUYABLE","DISCOVERABLE"]:["DISCOVERABLE"],
 issue_signals:market==="IT"?[]:[{code:"100632",severity:"ERROR",categories:["QUALIFICATION_REQUIRED"]},{code:"100527",severity:"WARNING"}],
 ...r}]
});
const restriction=(r={},data={})=>({
 ok:true,marketplace:"ES",read_only:true,provider_mutations:0,results:[{
 sku:es.sku,asin:es.asin,status:"NO_RESTRICTIONS_RETURNED_NOT_APPROVAL_PROOF",
 restriction_count:0,reason_codes:[],seller_central_links:[],...data}],...r
});
const catalogAsin=(state="READ_ONLY_DETAILS_COMPLETE")=>({
 ok:true,source:"amazon_spapi_catalog_item_live",read_only:true,marketplace:"ES",
 results:[{asin:es.asin,state}]
});
const catalogEan=(state="EXACT_ONE",asins=[es.asin])=>({
 ok:true,source:"amazon_spapi_catalog_items_live",read_only:true,identifier_type:"EAN",
 result:{marketplace:"ES",complete:true,identifiers:[{ean:es.ean,state,exact_match_count:state==="EXACT_ONE"?1:0,asins}]}
});
const args=(patch={})=>({
 ...es,seller:listing(),restriction:restriction(),catalogAsin:catalogAsin(),catalogEan:catalogEan(),
 counterpart:{market:"IT",seller:listing({},"IT")},...patch
});
const none=triage(args());
assert.equal(none.route,"SELLER_SUPPORT_QUALIFICATION_NO_APPLICATION_LINK");
assert.equal(none.counterpart_buyable,true);
assert.equal(none.brand_approved,false);
assert.equal(none.can_publish,false);
assert.equal(none.seller_central_url,null);
assert(none.alongside_technical_errors.includes("100527"));
const missing=triage(args({
 restriction:restriction({}, {status:"RESTRICTIONS_REPORTED",restriction_count:1,reason_codes:["ASIN_NOT_FOUND"]}),
 catalogAsin:catalogAsin("ASIN_NOT_FOUND"),
 catalogEan:catalogEan("NO_EXACT_MATCH",[])
}));
assert.equal(missing.route,"CATALOG_IDENTITY_ESCALATION");
assert.equal(missing.can_publish,false);
assert.equal(triage(args({catalogEan:catalogEan("EXACT_ONE",["B0DIFFERENT"])})).route,"CATALOG_IDENTITY_ESCALATION");
assert.equal(triage(args({catalogAsin:catalogAsin("ASIN_NOT_FOUND")})).route,"CATALOG_IDENTITY_ESCALATION");
const link="https://sellercentral.amazon.es/hz/approvalrequest/restrictions/approve?asin="+es.asin;
const approval=restriction({},{
 status:"RESTRICTIONS_REPORTED",restriction_count:1,
 reason_codes:["APPROVAL_REQUIRED"],seller_central_links:[link]
});
const ready=triage(args({restriction:approval}));
assert.equal(ready.route,"SELLER_CENTRAL_APPROVAL_REQUEST_AVAILABLE");
assert.equal(ready.seller_central_url,link);
assert.equal(ready.brand_approved,false);
assert.equal(ready.live_mutations,0);
assert.equal(ready.can_publish,false);
const malicious=triage(args({restriction:restriction({},{
 status:"RESTRICTIONS_REPORTED",restriction_count:1,reason_codes:["APPROVAL_REQUIRED"],
 seller_central_links:["https://sellercentral.amazon.es.evil.test/hz/approvalrequest/restrictions/approve?asin="+es.asin]
})}));
assert.equal(malicious.seller_central_url,null);
assert.equal(malicious.route,"RECHECK_REQUIRED");
assert.equal(triage(args({restriction:restriction({read_only:false},{
 status:"RESTRICTIONS_REPORTED",restriction_count:1,reason_codes:["APPROVAL_REQUIRED"],seller_central_links:[link]
})})).route,"RECHECK_REQUIRED");
assert.equal(triage(args({seller:listing({statuses:["BUYABLE","DISCOVERABLE"]})})).route,"ALREADY_BUYABLE");
assert.equal(triage(args({seller:listing({state:"PRESENT_ATTRIBUTES_UNKNOWN",asin:null,identity_state:"UNKNOWN"})})).route,"SELLER_LISTING_TECHNICAL_DIAGNOSTICS");
assert.equal(triage(args({seller:listing({asin:"B0NOTSAME1"})})).route,"SELLER_LISTING_TECHNICAL_DIAGNOSTICS");
assert.equal(triage(args({seller:listing({issue_signals:[]})})).route,"RECHECK_REQUIRED");
assert.equal(triage(args({seller:{...listing(),results:[]}})).route,"RECHECK_REQUIRED");
assert.equal(triage(args({seller:{...listing(),results:[...listing().results,...listing().results]}})).route,"RECHECK_REQUIRED");
assert.equal(triage(args({catalogEan:{...catalogEan(),source:"untrusted"}})).route,"RECHECK_REQUIRED");
assert.equal(triage(args({sku:"BAD\nSKU"})).route,"RECHECK_REQUIRED");
const alternate=triage(args({counterpart:{market:"IT",seller:listing({asin:"B0ANOTHER1"},"IT")}}));
assert.equal(alternate.counterpart_buyable,false);
console.log("PASS Amazon 100632 read-only qualification triage, catalog mismatch, official manual approval, no inferred brand approval");
