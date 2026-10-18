import assert from "node:assert/strict";
import {build} from "esbuild";

const b=await build({
  entryPoints:["src/marketplace-shopify-channable-amazon-lines.ts"],
  bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"
});
const {readShopifyChannableAmazonOrderLines,compareAmazonOrderWithChannableShopifyLines}=
  await import("data:text/javascript;base64,"+
    Buffer.from(b.outputFiles[0].text).toString("base64"));
const orderId="101-2345678-1234567",gid="gid://shopify/Order/9001";
const input={shopify_order_gid:gid,amazon_order_id:orderId};
const env={SHOPIFY_SHOP_DOMAIN:"synthetic-store.myshopify.com"};
const line=(n,sku,quantity,currentQuantity=quantity)=>({
  id:"gid://shopify/LineItem/"+n,sku,quantity,currentQuantity,
  variant:{id:"gid://shopify/ProductVariant/"+n}
});
const firstLines=[line(1,"SKU_A",1),line(2,"SKU_B",1)];
const secondLines=[line(3,"SKU_A",1)];
const order=(nodes,hasNextPage,cursor=null,extra={})=>({
  id:gid,sourceName:"amazon",sourceIdentifier:null,
  app:{name:"Channable"},
  customAttributes:[{key:"Amazon Order ID",value:orderId},
    {key:"PrivateNote",value:"PII_CANARY_NEVER_OUTPUT"}],
  lineItems:{nodes,pageInfo:{hasNextPage,endCursor:cursor}},...extra
});
let requests=[];
const reader=async(_env,query,vars)=>{
  requests.push(vars);
  assert(query.includes("MareChannableImportedAmazonOrder"));
  assert.equal(vars.id,gid);
  if(vars.after==="next")return {order:order(secondLines,false)};
  assert.equal(vars.after,null);
  return {order:order(firstLines,true,"next")};
};
const record=await readShopifyChannableAmazonOrderLines(input,env,reader);
assert.equal(record.ok,true);
assert.equal(record.line_count,3);
assert.equal(record.pagination_complete,true);
assert.equal(record.order_import_already_present,true);
assert.equal(record.can_create_order,false);
assert.equal(record.can_adjust_inventory,false);
assert.equal(record.all_line_skus_mapped,true);
assert.equal(record.lines[2].sku,"SKU_A");
assert(!JSON.stringify(record).includes("PII_CANARY"));
assert.equal(requests.length,2);

const amazonOrder={
  order_id:orderId,
  items:[
    {seller_sku:"SKU_A",quantity_ordered:2},
    {seller_sku:"SKU_B",quantity_ordered:1}
  ]
};
const positive=compareAmazonOrderWithChannableShopifyLines(amazonOrder,record);
assert.equal(positive.ok,true);
assert.equal(positive.matched_unique_sku_count,2);
assert.equal(positive.status,"REFERENCE_AND_QUANTITIES_MATCHED_NEEDS_FULFILLMENT_REVIEW");
assert.equal(positive.may_create_shopify_order,false);
assert.equal(positive.may_release_reservations,false);
assert.equal(positive.does_not_prove_shipping_or_tracking,true);
const mismatch=compareAmazonOrderWithChannableShopifyLines({
  ...amazonOrder,items:[{seller_sku:"SKU_A",quantity_ordered:1},
    {seller_sku:"SKU_B",quantity_ordered:1}]
},record);
assert.equal(mismatch.status,"LINE_RECONCILIATION_REQUIRED");
assert.equal(mismatch.sku_quantity_mismatch_count,1);
const adjustedShopify={
  ...record,lines:record.lines.map((l,i)=>
    i===0?{...l,current_quantity:0}:l)
};
const adjusted=compareAmazonOrderWithChannableShopifyLines(amazonOrder,adjustedShopify);
assert.equal(adjusted.status,"LINE_RECONCILIATION_REQUIRED");
assert.equal(adjusted.shopify_current_quantity_differs_from_original,true);
assert.equal(adjusted.may_create_shopify_order,false);
const unknown=compareAmazonOrderWithChannableShopifyLines({
  ...amazonOrder,items:[{seller_sku:null,quantity_ordered:1}]
},record);
assert.equal(unknown.status,"LINE_RECONCILIATION_REQUIRED");
assert.equal(unknown.may_create_shopify_order,false);

for(const invalid of [
  {sourceName:"web"},
  {app:{name:"Unexpected"}},
  {customAttributes:[]},
  {sourceIdentifier:"OTHER"},
  {id:"gid://shopify/Order/OTHER"}
]){
  await assert.rejects(()=>readShopifyChannableAmazonOrderLines(input,env,
    async()=>({order:order(firstLines,false,null,invalid)})));
}
await assert.rejects(()=>readShopifyChannableAmazonOrderLines(input,env,
  async(_e,_q,vars)=>({order:order(vars.after?[firstLines[0]]:firstLines,
    !vars.after,vars.after?null:"next")})),/shopify_channable_lines_item_invalid_or_duplicate/);
await assert.rejects(()=>readShopifyChannableAmazonOrderLines(
  {...input,allow_publish:true},env,reader),/invalid_request/);
assert.equal(requests.length,2);
console.log("PASS R2.4 imported Channable order line proof: paginated Shopify read, Amazon seller SKU quantity comparison, duplicates and no import/shipping/stock writes");
