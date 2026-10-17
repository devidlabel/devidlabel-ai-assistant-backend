import assert from "node:assert/strict";
import { runKWayCoatsPilot } from "./amazon-kway-coats-pilot.mjs";

const bearer = "private-authorization-test";
const makeEAN = n => {
  const prefix = String(n).padStart(12, "0");
  const sum = [...prefix].reduce((s,d,i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return prefix + ((10 - sum % 10) % 10);
};
const rows = Array.from({ length: 22 }, (_,i)=>({
  sku: "KWAY-COAT-PRIVATE-" + String(i).padStart(3,"0"),
  barcode: makeEAN(805168921730 + i),
  product_type: "Giacche e cappotti", vendor: "K-Way", inventory_quantity: 3
}));
rows.push({ sku: "KWAY-NO-GTIN", barcode: "BAD",
  product_type: "Giacche e cappotti", vendor: "K-Way" });
rows.push({ sku: "ECOALF-COAT", barcode: makeEAN(805168921770),
  product_type: "Giacche e cappotti", vendor: "Ecoalf" });
rows.push({ sku: "KWAY-SNEAKER", barcode: makeEAN(805168921771),
  product_type: "Sneakers", vendor: "K-Way" });
rows.push({ sku: "KWAY-DUPLICATE", barcode: makeEAN(805168921772),
  product_type: "Giacche e cappotti", vendor: "K-Way" });
rows.push({ sku: "KWAY-DUPLICATE", barcode: makeEAN(805168921773),
  product_type: "Giacche e cappotti", vendor: "K-Way" });
let calls = 0, throttle = false;
async function auditFn({ bearer: provided, onPrivateSnapshot }) {
  assert.equal(provided,bearer);
  onPrivateSnapshot({ rows,
    amazonIndexes: { IT: new Map(), DE: new Map(), FR: new Map(), ES: new Map() }
  });
  return { complete: true, generated_at: "2026-10-17T17:00:00Z",
    shopify: { complete: true, eligible_variants: 27 },
    amazon: Object.fromEntries(["IT","DE","FR","ES"].map(m=>[m,{compare_ready:true}])) };
}
async function lookup({ market, selected, bearer: provided }) {
  calls++;
  assert.equal(provided,bearer);
  assert(["IT","DE","FR","ES"].includes(market));
  assert.equal(selected.length,8);
  assert(selected.every(row=>row.vendor==="K-Way" && row.product_type==="Giacche e cappotti"));
  if (throttle) return { ok:false, http_status:502,error_code:"amazon_catalog_batch_http_429" };
  return { ok:true, http_status:200,pages_read:1,entries:selected.map((r,i)=>({
    ean:r.barcode,state:i<2?"EXACT_ONE":"NO_EXACT_MATCH"
  })) };
}
const result = await runKWayCoatsPilot({ bearer,auditFn,lookup,delayMs:0 });
assert.equal(result.overall_complete,true);
assert.equal(result.results_are_full_snapshot,false);
assert.equal(result.sample_only,true);
assert.equal(result.category,"Giacche e cappotti");
assert.equal(result.vendor_filter,"K-Way");
assert.equal(result.kway_coat_eligible_nonduplicate_variants,23);
assert.equal(result.kway_coat_duplicate_sku_variants_quarantined,2);
assert.equal(calls,8);
for (const market of ["IT","DE","FR","ES"]) {
  const row=result.markets[market];
  assert.equal(row.missing_kway_coat_variants,23);
  assert.equal(row.missing_with_valid_ean,22);
  assert.equal(row.missing_without_valid_ean,1);
  assert.equal(row.all_safe_ean_candidates,22);
  assert.equal(row.sampled_eans,16);
  assert.equal(row.groups_completed,2);
  assert.equal(row.matching.EXACT_ONE,4);
  assert.equal(row.matching.NO_EXACT_MATCH,12);
}
const output=JSON.stringify(result);
for(const secret of [bearer,...rows.map(x=>x.sku),...rows.map(x=>x.barcode)]) {
  if(secret==="BAD")continue;
  assert(!output.includes(secret));
}
calls=0;throttle=true;
const blocked=await runKWayCoatsPilot({bearer,auditFn,lookup,delayMs:0});
assert.equal(blocked.overall_complete,false);
assert.equal(blocked.markets.IT.status,"PARTIAL");
assert.equal(blocked.markets.DE.status,"SKIPPED_AFTER_THROTTLE");
assert.equal(calls,1);
console.log("K-Way coats read-only EAN pilot and safeguards passed");
