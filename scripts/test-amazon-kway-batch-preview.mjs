import assert from "node:assert/strict";
import { build } from "esbuild";
const compiled = await build({
  entryPoints: ["src/marketplace-amazon-kway-batch-preview.ts"],
  bundle: true, platform: "neutral", format: "esm", write: false, logLevel: "silent"
});
const mod = await import("data:text/javascript;base64," +
  Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const { previewKwayAsinBatch } = mod;
const calls = [];
const env = {};
const sample = {marketplace:"IT", items:[
  {sku:"KWAY_K6133HW_USY_S",product_type:"SWEATSHIRT"},
  {sku:"KWAY_K2133FW_490_S",product_type:"COAT"}
]};
const preview = async (request) => {
  calls.push(request);
  if (request.product_type === "SWEATSHIRT") return {
    ok:true,status:"VALIDATION_ONLY_REVIEW_REQUIRED",
    provider_validation_performed:true,preview_only:true,
    provider_mutations:0,product_created:false,
    provider_validation_status:"INVALID",
    issues:[{code:"90220",severity:"ERROR",attribute_names:["manufacturer"],
      message:"Sensitive account email: example@example.com"}],
    attributes_submitted:["brand","item_name","apparel_size"]
  };
  return {ok:true,status:"VALIDATION_ONLY_REVIEW_REQUIRED",
    provider_validation_performed:true,preview_only:true,
    provider_mutations:0,product_created:false,
    provider_validation_status:"VALID",issues:[]};
};
const result=await previewKwayAsinBatch(sample,env,{preview});
assert.equal(result.status,"KWAY_BATCH_VALIDATION_ONLY");
assert.equal(result.processed,2);
assert.equal(result.validation_valid,1);
assert.equal(result.provider_mutations,0);
assert.equal(result.rows[0].issue_count,1);
assert.equal(result.rows[0].issues[0].attribute_names[0],"manufacturer");
assert.equal(result.rows[1].ready_for_next_guarded_step,true);
assert.equal(result.rows[1].can_publish,false);
assert.equal(calls.length,2);
assert.equal(JSON.stringify(result).includes("example@example.com"),false);
await assert.rejects(previewKwayAsinBatch({...sample,items:[
  sample.items[0],sample.items[0]]},env,{preview}),/invalid/);
await assert.rejects(previewKwayAsinBatch({...sample,items:[
  {sku:"NOT_KWAY_SKU",product_type:"COAT"}]},env,{preview}),/invalid/);
await assert.rejects(previewKwayAsinBatch({...sample,items:
  Array(9).fill(0).map((_,i)=>({sku:"KWAY_TEST_"+i,product_type:"COAT"}))
},env,{preview}),/invalid/);
const failure=await previewKwayAsinBatch({marketplace:"FR",items:[
  {sku:"KWAY_SAFE_1",product_type:"HAT"}]},env,{
    preview:async()=>{throw Error("private provider credential");}
  });
assert.equal(failure.rows[0].status,"PREVIEW_UNAVAILABLE");
assert.equal(JSON.stringify(failure).includes("credential"),false);
console.log("K-Way batch preview tests passed");
