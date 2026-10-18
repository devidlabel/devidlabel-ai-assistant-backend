import assert from "node:assert/strict";
import {build} from "esbuild";
const b=await build({entryPoints:["src/marketplace-shopify-channable-fulfillments.ts"],
 bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
const {readShopifyChannableFulfillmentMetadata,compareChannableFulfillmentCoverage}=
 await import("data:text/javascript;base64,"+
  Buffer.from(b.outputFiles[0].text).toString("base64"));
const shopify_order_gid="gid://shopify/Order/1001";
const amazonId="101-2345678-1234567",spartooId="1234567890123456";
const env={SHOPIFY_SHOP_DOMAIN:"synthetic.myshopify.com"};
const line=(id,sku,quantity)=>({
 id:"gid://shopify/FulfillmentLineItem/"+id,quantity,
 lineItem:{id:"gid://shopify/LineItem/"+id,sku}
});
const shipment=(id,lines,company="brt")=>({
 id:"gid://shopify/Fulfillment/"+id,status:"SUCCESS",displayStatus:"FULFILLED",
 trackingInfo:[{company,number:"PII_CANARY_TRACKING_NUMBER_NOT_ALLOWED",
   url:"https://example.com/PRIVATE_TRACKING_CANARY"}],
 fulfillmentLineItems:{nodes:lines,pageInfo:{hasNextPage:false,endCursor:null}}
});
const record=(source,reference,fulfillments)=>({
 id:shopify_order_gid,sourceName:source,app:{name:"Channable"},
 customAttributes:[{key:source==="amazon"?"Amazon Order ID":"Spartoo Order ID",value:reference},
  {key:"Private Note",value:"PII_CANARY_ORDER_NOTE"}],
 displayFulfillmentStatus:fulfillments.length?"FULFILLED":"UNFULFILLED",
 fulfillments
});
const ship1=shipment(1,[line(71,"00_SKU_TEST",1)]);
const input={provider:"amazon",shopify_order_gid,external_order_id:amazonId};
const fake=async(_env,query,vars)=>{
 assert(query.includes("MareChannableMarketplaceFulfillments"));
 assert(query.includes("trackingInfo(first:10){company}"));
 assert(!query.includes("trackingInfo{number"));
 assert.equal(vars.id,shopify_order_gid);
 return {order:record("amazon",amazonId,[ship1])};
};
const r=await readShopifyChannableFulfillmentMetadata(input,env,fake);
assert.equal(r.ok,true);
assert.equal(r.shipment_count,1);
assert.equal(r.tracking_info_entries,1);
assert.equal(r.shipments[0].carrier_names[0],"brt");
assert.equal(r.shipments[0].lines[0].sku,"00_SKU_TEST");
assert.equal(r.fulfillment_line_units,1);
assert.equal(r.can_confirm_marketplace_shipment,false);
assert.equal(r.can_release_stock_reservation,false);
assert.equal(r.tracking_numbers_or_urls_requested,false);
assert(!JSON.stringify(r).includes("PII_CANARY"));
assert(!JSON.stringify(r).includes("PRIVATE_TRACKING_CANARY"));
const orderLines={
 ok:true,source:"shopify_channable_amazon_order_lines",
 shopify_order_gid,amazon_order_id:amazonId,
 lines:[{line_item_gid:"gid://shopify/LineItem/71",
  sku:"00_SKU_TEST",ordered_quantity:1}]
};
const complete=compareChannableFulfillmentCoverage(orderLines,r);
assert.equal(complete.coverage,"SHOPIFY_FULFILLMENT_LINES_COMPLETE");
assert.equal(complete.amazon_tracking_confirmation_proven,false);
assert.equal(complete.may_confirm_marketplace_shipment,false);
const unfulfilled=await readShopifyChannableFulfillmentMetadata(input,env,
 async()=>({order:record("amazon",amazonId,[])}));
assert.equal(unfulfilled.shipment_count,0);
const none=compareChannableFulfillmentCoverage(orderLines,unfulfilled);
assert.equal(none.coverage,"NO_SHIPMENTS");
const partial=compareChannableFulfillmentCoverage({
 ...orderLines,lines:[{...orderLines.lines[0],ordered_quantity:2}]
},r);
assert.equal(partial.coverage,"PARTIAL");
assert.throws(()=>compareChannableFulfillmentCoverage(orderLines,{
 ...r,shipments:[{...r.shipments[0],lines:[
   {...r.shipments[0].lines[0],quantity:2}
 ]}]
}),/overshipped/);
assert.throws(()=>compareChannableFulfillmentCoverage(orderLines,{
 ...r,shipments:[{...r.shipments[0],lines:[
   {...r.shipments[0].lines[0],line_item_gid:"gid://shopify/LineItem/888"}
 ]}]
}),/unknown_line/);
const spartoo=await readShopifyChannableFulfillmentMetadata({
 provider:"spartoo",shopify_order_gid,external_order_id:spartooId
},env,async()=>({order:record("spartoo",spartooId,[shipment(2,[line(80,"SPARTOO_TEST",1)],"UPS")])}));
assert.equal(spartoo.ok,true);
assert.equal(spartoo.provider,"spartoo");
assert.equal(spartoo.shipments[0].carrier_names[0],"UPS");
for(const altered of [
 {sourceName:"web"},
 {app:{name:"Another App"}},
 {customAttributes:[]},
 {fulfillments:[ship1,ship1]},
 {fulfillments:[shipment(5,[line(5,"TEST",1)],"Bad\nCarrier")]},
 {fulfillments:[{...ship1,fulfillmentLineItems:{
   nodes:ship1.fulfillmentLineItems.nodes,
   pageInfo:{hasNextPage:true,endCursor:"next"}
 }}]},
 {fulfillments:[{...ship1,trackingInfo:Array(10).fill({company:"brt"})}]}
]){
 await assert.rejects(()=>readShopifyChannableFulfillmentMetadata(input,env,
  async()=>({order:{...record("amazon",amazonId,[ship1]),...altered}})));
}
await assert.rejects(()=>readShopifyChannableFulfillmentMetadata({
 ...input,confirm:true
},env,fake),/invalid_request/);

// Audit F05: failed/cancelled/pending records cannot stand in for SUCCESS.
for(const status of ["CANCELLED","ERROR","FAILURE","OPEN","PENDING"]){
 const observed=await readShopifyChannableFulfillmentMetadata(input,env,
  async()=>({order:record("amazon",amazonId,[{...ship1,status}])}));
 const coverage=compareChannableFulfillmentCoverage(orderLines,observed);
 assert.equal(coverage.fulfillment_line_units,0);
 assert.equal(coverage.successful_fulfillments,0);
 assert.equal(coverage.excluded_non_success_fulfillments,1);
 assert.equal(coverage.coverage,["OPEN","PENDING"].includes(status)?
   "PENDING_FULFILLMENT_REVIEW":"NO_SUCCESSFUL_FULFILLMENTS");
 assert.equal(coverage.may_confirm_marketplace_shipment,false);
 assert.equal(coverage.may_release_reservations,false);
}
const successful=r.shipments[0];
const replacement=compareChannableFulfillmentCoverage(orderLines,{
 ...r,shipments:[{...successful,fulfillment_gid:"gid://shopify/Fulfillment/99",
 status:"CANCELLED"},successful]
});
assert.equal(replacement.fulfillment_line_units,1);
assert.equal(replacement.coverage,"SHOPIFY_FULFILLMENT_LINES_COMPLETE");
assert.equal(replacement.excluded_non_success_fulfillments,1);
const successPlusPending=compareChannableFulfillmentCoverage(orderLines,{
 ...r,shipments:[successful,{...successful,
 fulfillment_gid:"gid://shopify/Fulfillment/98",status:"PENDING"}]
});
assert.equal(successPlusPending.coverage,"PENDING_FULFILLMENT_REVIEW");
assert.equal(successPlusPending.fulfillment_line_units,1);
assert.throws(()=>compareChannableFulfillmentCoverage(orderLines,{
 ...r,shipments:[successful,successful]
}),/shipment_identity_conflict/);
assert.throws(()=>compareChannableFulfillmentCoverage(orderLines,{
 ...r,shipments:[{...successful,status:"NEW_UNRECOGNIZED_PROVIDER_STATE"}]
}),/unknown_status/);
assert.throws(()=>compareChannableFulfillmentCoverage({
 ...orderLines,lines:[{...orderLines.lines[0],ordered_quantity:2}]
},{...r,shipments:[{...successful,lines:[successful.lines[0],successful.lines[0]]}]}),
 /duplicate_line/);
console.log("PASS F05 fulfillment coverage: only SUCCESS counted, five non-success states excluded, pending ambiguity and duplicates blocked; no external writes");
