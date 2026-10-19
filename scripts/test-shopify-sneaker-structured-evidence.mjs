import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const built=await build({entryPoints:["src/marketplace-shopify-sneaker-structured-evidence.ts"],
  bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {readShopifySneakerStructuredEvidence:run}=await import(
  "data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));
const sku="TEST_SHOES_42_EU",productId="gid://shopify/Product/111111",
  variantId="gid://shopify/ProductVariant/222222";
function catalog(){
  return {ok:true,truncated:false,complete_variant_pagination:true,
    product_count:1,inline_product_count:1,
    products:[{id:productId,status:"ACTIVE",product_type:"Sneakers",vendor:"Test Brand",
      variants:[{id:variantId,sku,inventory_quantity:2,inventory_tracked:true,inventory_levels_complete:true}]}]};
}
function graph(){
  return {product:{id:productId,vendor:"Test Brand",status:"ACTIVE",productType:"Sneakers",
      model:{type:"single_line_text_field",value:"Brand Model"},
      gender:{type:"list.single_line_text_field",value:'["men"]'},
      agenticColor:{type:"single_line_text_field",value:"navy"},
      featureColor:{type:"metaobject_reference",value:"gid://shopify/Metaobject/123"},
      featureMaterial:{type:"metaobject_reference",value:"gid://shopify/Metaobject/456"}},
    productVariant:{id:variantId,sku,product:{id:productId},
      mpn:{type:"single_line_text_field",value:"sample-secret-model-id"},
      ageGroup:{type:"single_line_text_field",value:"adult"},
      gender:{type:"single_line_text_field",value:"male"},
      sizeSystem:{type:"single_line_text_field",value:"EU"},
      sizeType:{type:"single_line_text_field",value:"regular"}}};
}
const env={};
let reads=0, queries=0;
const deps={readCatalog:async args=>{
  reads++;
  assert.equal(args.persist_artifacts,false);
  assert.equal(args.max_products,50);
  assert.ok(args.query.includes('sku:"'+sku+'"'));
  return catalog();
},queryShopify:async (_env,query,vars)=>{
  queries++;
  assert.ok(query.includes("productVariant"));
  assert.deepEqual(vars,{productId,variantId});
  return graph();
}};
const result=await run({sku},env,deps);
assert.equal(result.ok,true);
assert.equal(result.field_count,10);
assert.equal(result.mapped_attribute_candidate_count,9);
assert.equal(result.unmapped_reference_count,1);
assert.equal(result.reference_values_resolved,false);
assert.equal(result.manufacturer_verified,false);
assert.equal(result.gpsr_compliance_proven,false);
assert.equal(result.brand_authorization_proven,false);
assert.equal(result.ready_for_validation_preview,false);
assert.equal(result.ready_for_publication,false);
assert.equal(result.provider_mutations,0);
assert.equal(result.values_exported,false);
assert.equal(result.read_only,true);
assert.equal(reads,1);
assert.equal(queries,1);
assert.equal(result.fields.find(x=>x.shopify_path==="product.features.material").amazon_attribute_candidate,null);
assert.equal(result.fields.find(x=>x.shopify_path==="product.features.material").evidence_state,"REFERENCE_REVIEW");
assert.equal(result.fields.find(x=>x.shopify_path==="variant.mm-google-shopping.age_group").amazon_attribute_candidate,"age_range_description");
for(const sensitive of ["sample-secret-model-id","Brand Model","navy","gid://shopify/Metaobject/123"]){
  assert.ok(!JSON.stringify(result).includes(sensitive),"leaked actual metadata value");
}
const unavailable=await run({sku},env,{readCatalog:async()=>catalog(),queryShopify:async()=>{throw Error("private backend");}});
assert.equal(unavailable.ok,false);
assert.equal(unavailable.blocker,"shopify_metafields_unavailable");
assert.equal(unavailable.provider_mutations,0);
const duplicate=await run({sku},env,{readCatalog:async()=>{
  const c=catalog(),p=structuredClone(c.products[0]);
  p.variants[0].id="gid://shopify/ProductVariant/999";
  return {...c,product_count:2,inline_product_count:2,products:[...c.products,p]};
}});
assert.equal(duplicate.blocker,"shopify_sku_missing_or_duplicated");
const missing=await run({sku},env,{readCatalog:async()=>{
  const c=catalog();c.products[0].variants[0].inventory_quantity=0;return c;
}});
assert.equal(missing.blocker,"shopify_active_sneaker_stock_or_identity_unverified");
const mismatched=await run({sku},env,{readCatalog:async()=>catalog(),queryShopify:async()=>{
  const x=graph();x.productVariant.product.id="gid://shopify/Product/999";return x;
}});
assert.equal(mismatched.blocker,"shopify_metafield_identity_mismatch");
const untrusted=await run({sku},env,{readCatalog:async()=>catalog(),queryShopify:async()=>{
  const x=graph();x.product.model.value="n/a";x.product.featureColor.type="string";return x;
}});
assert.equal(untrusted.field_count,8);
for(const bad of [{}, {sku,extra:true},{sku:"../../escape"},{sku:" TEST "}])
  await assert.rejects(()=>run(bad,env,deps),/shopify_sneaker_evidence_invalid_request/);
const source=readFileSync("src/marketplace-shopify-sneaker-structured-evidence.ts","utf8");
assert.equal(/(?:method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)|createListing|confirmShipment|updateInventory)/.test(source),false);
console.log("Shopify sneaker structured evidence safety tests passed.");
