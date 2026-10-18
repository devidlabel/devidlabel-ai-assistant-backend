import assert from "node:assert/strict";
import {build} from "esbuild";

const result=await build({
  entryPoints:["src/marketplace-amazon-channable-adoption-reconcile.ts"],
  bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"
});
const {reconcileAmazonShopifyOrderAdoption}=await import(
  "data:text/javascript;base64,"+
  Buffer.from(result.outputFiles[0].text).toString("base64")
);
const seller="A123456789";
const a="101-2345678-1234567",b="101-2345678-1234568";
const order=id=>({
  order_id:id,order_key:"amazon:"+seller+":"+id,account_id:seller,
  marketplace_id:"APJ6JRA9NG5V4"
});
const amazon={
  ok:true,read_only:true,source:"amazon_spapi_orders_2026_01_01",
  identity_scope:"SELLER_ACCOUNT_PLUS_ORDER_ID",
  account_id:seller,complete_pagination:true,importer_enabled:false,
  can_advance_checkpoint:false,order_count:2,orders:[order(a),order(b)]
};
const shopify={
  ok:true,read_only:true,source:"shopify_channable_amazon_order_signature",
  pagination_complete:true,absence_proven:false,
  safe_to_create_shopify_order:false,order_importer_owner:"CHANNABLE",
  found_count:1,unverified_count:1,
  found:[{
    amazon_order_id:a,shopify_order_gid:"gid://shopify/Order/2001",
    adoption_status:"FOUND_CHANNABLE",source_name:"amazon",importing_app:"Channable"
  }],
  unverified:[{shopify_order_gid:"gid://shopify/Order/2090",
    reason:"amazon_order_id_missing_or_malformed"}]
};
const report=reconcileAmazonShopifyOrderAdoption(amazon,shopify);
assert.equal(report.ok,true);
assert.equal(report.amazon_orders_checked,2);
assert.equal(report.positive_existing_reference_count,1);
assert.equal(report.unresolved_count,1);
assert.equal(report.matched[0].shopify_order_gid,"gid://shopify/Order/2001");
assert.equal(report.matched[0].requires_line_check,true);
assert.equal(report.unresolved[0].amazon_order_id,b);
assert.equal(report.unresolved[0].status,"UNVERIFIED_WINDOW_OR_IMPORT_IN_FLIGHT");
assert.equal(report.allow_shopify_order_create,false);
assert.equal(report.can_activate_offer_stock,false);
assert.equal(report.can_advance_orders_checkpoint,false);
assert.equal(report.importer_ownership,"NOT_TRANSFERRED_FROM_CHANNABLE");
const noMatch=reconcileAmazonShopifyOrderAdoption(amazon,{
  ...shopify,found:[],found_count:0
});
assert.equal(noMatch.unresolved_count,2);
assert.equal(noMatch.allow_shopify_order_create,false);

const fail=[
  [amazon,{...shopify,absence_proven:true}],
  [amazon,{...shopify,safe_to_create_shopify_order:true}],
  [{...amazon,complete_pagination:false},shopify],
  [{...amazon,importer_enabled:true},shopify],
  [{...amazon,can_advance_checkpoint:true},shopify],
  [{...amazon,order_count:1},shopify],
  [amazon,{...shopify,found_count:3}],
  [amazon,{...shopify,found:[...shopify.found,...shopify.found],found_count:2}],
  [amazon,{...shopify,found:[...shopify.found,
    {...shopify.found[0],amazon_order_id:b}],found_count:2}],
  [{...amazon,orders:[order(a),{...order(b),account_id:"OTHER"}]},shopify],
  [{...amazon,orders:[order(a),order(a)]},shopify]
];
for(const [am,sh] of fail)
  assert.throws(()=>reconcileAmazonShopifyOrderAdoption(am,sh));
console.log("PASS R2.3 Channable Shopify Amazon Order ID adoption: duplicates, partial scans, positive references and fail-closed no-match; Shopify orderCreate never authorized");
