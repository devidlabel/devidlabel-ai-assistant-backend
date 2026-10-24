import assert from "node:assert/strict";
import {build} from "esbuild";
const bundle=await build({entryPoints:["src/mare-business-shopify-gpsr-fields.ts"],bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {readShopifyGpsrFieldLocations:read}=await import("data:text/javascript;base64,"+Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const sku="MC2_TEST_42";const secret="Private Employer Contact private@example.org";
const connection=(nodes)=>({pageInfo:{hasNextPage:false},nodes});
const base=(field)=>({productVariants:connection([{
 id:"gid://shopify/ProductVariant/456",sku,inventoryQuantity:3,
 metafields:connection([field]),
 product:{id:"gid://shopify/Product/123",vendor:"MC2 Saint Barth",status:"ACTIVE",
  metafields:connection([
   {namespace:"custom",key:"manufacturer_email",type:"single_line_text_field",value:secret},
   {namespace:"custom",key:"size",type:"single_line_text_field",value:"42"},
   {namespace:"gpsr",key:"eu_responsible_person",type:"single_line_text_field",value:""}
  ])}
 }])});
const mock=async(env,query,variables)=>{
 assert.match(query,/productVariants/);
 assert.equal(variables.search,'sku:"'+sku+'"');
 return base({namespace:"custom",key:"product_safety",type:"single_line_text_field",value:"Test"});
};
const out=await read({sku},{},{queryShopify:mock});
assert.equal(out.ok,true);assert.equal(out.provider_mutations,0);
assert.equal(out.fields.length,3);
assert(out.fields.some(z=>z.key==="manufacturer_email"&&z.non_empty));
assert(out.fields.some(z=>z.key==="eu_responsible_person"&&!z.non_empty));
assert(!out.fields.some(z=>z.key==="size"));
assert(!JSON.stringify(out).includes(secret));
assert(!JSON.stringify(out).includes("example.org"));
assert.equal(out.manufacturer_verified,false);
assert.equal(out.eu_responsible_person_verified,false);
assert.equal(out.ready_for_amazon_patch,false);
for(const [data,status] of [
 [base({namespace:"custom",key:"non_gpsr",type:"single_line_text_field",value:secret}).productVariants.nodes[0].product.status="DRAFT","SHOPIFY_SKU_NOT_ACTIVE_OR_IN_STOCK"]
]){/* no-op: negative fixtures below are isolated */}
const duplicate=await read({sku},{},{queryShopify:async()=>({productVariants:connection([
 base({namespace:"custom",key:"manufacturer",type:"single_line_text_field",value:"test"}).productVariants.nodes[0],
 base({namespace:"custom",key:"manufacturer",type:"single_line_text_field",value:"test"}).productVariants.nodes[0]
])})});
assert.equal(duplicate.status,"SHOPIFY_SKU_NOT_UNIQUE");
const partial=base({namespace:"custom",key:"manufacturer",type:"single_line_text_field",value:secret});
partial.productVariants.nodes[0].product.metafields.pageInfo.hasNextPage=true;
const a=await read({sku},{},{queryShopify:async()=>partial});
assert.equal(a.status,"SHOPIFY_METAFIELDS_NOT_COMPLETE");
const inactive=base({namespace:"custom",key:"manufacturer",type:"single_line_text_field",value:secret});
inactive.productVariants.nodes[0].product.status="DRAFT";
const b=await read({sku},{},{queryShopify:async()=>inactive});
assert.equal(b.status,"SHOPIFY_SKU_NOT_ACTIVE_OR_IN_STOCK");
const missing=await read({sku},{},{queryShopify:async()=>({productVariants:connection([])})});
assert.equal(missing.status,"SHOPIFY_SKU_NOT_UNIQUE");
for(const invalid of [{},{sku:"../bad"},{sku:" X "},{sku,extra:"invalid"}])
 await assert.rejects(()=>read(invalid,{},{queryShopify:mock}),/shopify_gpsr_fields_invalid_request/);
console.log("Shopify GPSR metafield location, no raw values and fail-closed tests passed.");
