import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { auditShopifyAgainstAmazon } from "./amazon-shopify-live-audit.mjs";
import { buildPrivateShopifyAmazonManifest, validatePrivateManifestOutput,
  writePrivateShopifyAmazonManifest } from "./amazon-shopify-private-manifest.mjs";

const markets = ["IT","DE","FR","ES"];
const bearer = "synthetic-auth-token-not-for-output";
const variants = [
  {sku:"TEST-A",product_id:"p1",variant_id:"v1",vendor:"Example",product_type:"Coats",
    inventory_quantity:2,barcode:"0012345678905",price:"19.99",compare_at_price:"29.99"},
  {sku:"test-a",product_id:"p2",variant_id:"v2",vendor:"Example",product_type:"Bags",
    inventory_quantity:3,barcode:"012345678905"},
  {sku:"DUP",product_id:"p3",variant_id:"v3",vendor:"Example",product_type:"Coats",
    inventory_quantity:1,barcode:null},
  {sku:"DUP",product_id:"p4",variant_id:"v4",vendor:"Example",product_type:"Coats",
    inventory_quantity:4,barcode:null}
];
let privateSnapshot, pageReads = 0, reportReads = 0;
const amazonReader = async (market, index) => {
  reportReads++;
  if(market==="IT") index.set("TEST-A","ACTIVE");
  if(market==="DE") index.set("TEST-A","INACTIVE");
  if(market==="FR") index.set("TEST-A","OTHER_STATUS");
  return {ok:true,safe_for_missing_sku_classification:true,unique_skus:index.size,
    duplicate_sku_rows:0,active:market==="IT"?1:0,inactive:market==="DE"?1:0,
    report_created_at:"2026-01-01T12:00:00Z"};
};
const shopifyFetch = async (_url, options) => {
  pageReads++;
  assert.equal(options.method,"GET");
  return new Response(JSON.stringify({
    ok:true,read_only:true,source:"shopify_live",sort_key:"ID",
    products_scanned:4,variants_scanned:4,eligible_count:4,
    excluded:{p448:0,not_active:0,no_stock:0,blank_sku:0},
    has_more:false,next_cursor:null,eligible_variants:variants
  }),{status:200});
};
const report = await auditShopifyAgainstAmazon({
  bearer,amazonReader,shopifyFetch,onPrivateSnapshot: value => { privateSnapshot=value; }
});
assert.equal(pageReads,1);
assert.equal(reportReads,4);
assert.equal(report.complete,true);
const manifest = buildPrivateShopifyAmazonManifest(privateSnapshot,report);
assert.equal(manifest.row_count,4);
assert.equal(manifest.unique_sku_count,3);
assert.equal(manifest.buyability_verified,false);
assert.deepEqual(manifest.rows[0].market_states,{
  IT:"PRESENT_ACTIVE",DE:"PRESENT_INACTIVE",FR:"PRESENT_UNKNOWN",ES:"NOT_FOUND_IN_AMAZON_REPORT"
});
assert.equal(manifest.rows[0].inventory_quantity,2);
assert.equal(manifest.rows[0].barcode,"0012345678905");
assert.equal(manifest.rows[1].barcode,"012345678905","UPC stays unchanged");
assert.equal(manifest.rows[1].price,null);
assert.equal(manifest.rows[1].compare_at_price,null);
assert.equal(manifest.rows[0].price,"19.99");
assert.equal(manifest.rows[0].compare_at_price,"29.99");
assert.equal(manifest.rows[2].variant_id,"v3");
assert.equal(manifest.rows[3].variant_id,"v4");
for(const market of markets){
  assert.equal(manifest.rows[2].market_states[market],"DUPLICATE_SHOPIFY_SKU");
  const counts={};
  for(const row of manifest.rows)counts[row.market_states[market]]=(counts[row.market_states[market]]||0)+1;
  for(const [state,count] of Object.entries(report.results.markets[market]))
    assert.equal(counts[state]||0,count,"manifest and unchanged aggregate must reconcile");
}
const aggregate=JSON.stringify(report);
for(const sensitive of [bearer,"TEST-A","test-a",'"DUP"',"0012345678905",'"v1"'])
  assert(!aggregate.includes(sensitive),"public receipt stays aggregate-only");
assert(!JSON.stringify(manifest).includes(bearer));
assert.throws(()=>buildPrivateShopifyAmazonManifest(privateSnapshot,{...report,complete:false}),
 /complete_reconciled_snapshot/);
assert.throws(()=>buildPrivateShopifyAmazonManifest({...privateSnapshot,classifications:[]},report),
 /complete_reconciled_snapshot/);
const invalid={...privateSnapshot, classifications:privateSnapshot.classifications.map(x=>({...x}))};
invalid.classifications[0].IT="BUYABLE";
assert.throws(()=>buildPrivateShopifyAmazonManifest(invalid,report),/row_invalid/);

// No arbitrary display/page limit may truncate a complete catalogue.
const bigRows=Array.from({length:4549},(_,i)=>({
  ...privateSnapshot.rows[0],sku:"SYNTHETIC-"+i,variant_id:"variant-"+i
}));
const big=buildPrivateShopifyAmazonManifest({
  rows:bigRows,classifications:bigRows.map(()=>privateSnapshot.classifications[0])
},{...report,shopify:{...report.shopify,eligible_variants:4549}});
assert.equal(big.rows.length,4549);
assert.equal(big.rows[4548].sku,"SYNTHETIC-4548");

// File output is opt-in, private, atomic, and cannot resolve into this checkout.
const checkout=path.resolve(".");
const temporary=fs.mkdtempSync(path.join(path.resolve(".."),"manifest-fixture-"));
try {
  const destination=path.join(temporary,"private.json");
  writePrivateShopifyAmazonManifest(destination,manifest);
  assert.equal(JSON.parse(fs.readFileSync(destination,"utf8")).rows.length,4);
  assert.equal(fs.statSync(destination).mode & 0o777,0o600);
  assert.throws(()=>validatePrivateManifestOutput(path.join(checkout,"ops","manifest.json")),
    /outside_checkout/);
  assert.throws(()=>validatePrivateManifestOutput("relative.json"),/outside_checkout/);
  fs.symlinkSync(checkout,path.join(temporary,"checkout-link"),"dir");
  assert.throws(()=>writePrivateShopifyAmazonManifest(path.join(temporary,"checkout-link","should-not-exist.json"),manifest),
    /resolves_inside_checkout/);
  assert(!fs.existsSync(path.join(checkout,"should-not-exist.json")));
} finally { fs.rmSync(temporary,{recursive:true,force:true}); }
console.log("Private Shopify/Amazon manifest: complete rows, aggregate parity, no extra reads, privacy and path guards PASS");

