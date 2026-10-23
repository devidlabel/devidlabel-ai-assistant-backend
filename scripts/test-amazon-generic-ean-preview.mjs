import assert from "node:assert/strict";
import { build } from "esbuild";
const compiled = await build({
 entryPoints:["src/marketplace-amazon-generic-ean-preview.ts"],
 bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"
});
const module = await import("data:text/javascript;base64,"+
 Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const run = module.previewAmazonGenericEanValidation;
const sku = "RSX_64228G_V4928_-_ESPRESSO";
const request = {marketplace:"IT",sku,product_type:"SOCKS"};
await assert.rejects(run({...request,product_type:"SHOES"},{}),/invalid_request/);
await assert.rejects(run({...request,extra:true},{}),/invalid_request/);
const blocked = await run(request,{AMAZON_OFFER_PREVIEW_ENABLED:"false"});
assert.equal(blocked.status,"BLOCKED_PREVIEW");
assert.equal(blocked.product_created,false);
assert.equal(blocked.can_publish,false);
assert.equal(blocked.provider_mutations,0);
const bad = await run(request,{AMAZON_OFFER_PREVIEW_ENABLED:"true",AMAZON_SP_API_SELLER_ID:"A1234567891234"},{
 research:async()=>({ok:false,status:"BLOCKED_SHOPIFY"})
});
assert.equal(bad.status,"BLOCKED_PREVIEW");
assert.equal(bad.provider_mutations,0);
console.log("amazon generic EAN preview negative safety tests: PASS");
