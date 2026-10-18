import assert from "node:assert/strict";
import {build} from "esbuild";

// PR210 SUCCESS-only regression cases, extended with private tracking-presence
// observations. Synthetic fixtures only; no provider/network calls are allowed.
const b=await build({entryPoints:["src/marketplace-shopify-channable-fulfillments.ts"],
 bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent",
 plugins:[{name:"provider-reader-boundary",setup(build){
  build.onResolve({filter:/\/index\.js$/},()=>({path:"no-provider-reader",namespace:"fixture"}));
  build.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:'export function shopifyGraphQL(){throw Error("PROVIDER_READ_FORBIDDEN");}',loader:"js"}));
 }}]});
const {readShopifyChannableFulfillmentMetadata,compareChannableFulfillmentCoverage,
 readShopifyChannableAmazonFulfillmentReview,SHOPIFY_CHANNABLE_FULFILLMENT_QUERY}=
 await import("data:text/javascript;base64,"+Buffer.from(b.outputFiles[0].text).toString("base64"));
let checks=0;
const eq=(actual,want)=>{assert.equal(actual,want);checks++;};
const bad=(fn,pattern)=>{assert.throws(fn,pattern);checks++;};
const rejects=async(fn,pattern)=>{await assert.rejects(fn,pattern);checks++;};
const clone=x=>structuredClone(x);
const shopify_order_gid="gid://shopify/Order/1001";
const amazonId="101-2345678-1234567",spartooId="1234567890123456";
const env={SHOPIFY_SHOP_DOMAIN:"synthetic.myshopify.com"};
const line=(id,sku,quantity)=>({id:"gid://shopify/FulfillmentLineItem/"+id,quantity,
 lineItem:{id:"gid://shopify/LineItem/"+id,sku}});
const shipment=(id,lines,company="brt",number="PII_CANARY_TRACKING_NUMBER")=>({
 id:"gid://shopify/Fulfillment/"+id,status:"SUCCESS",displayStatus:"FULFILLED",
 trackingInfo:[{company,number,url:"https://example.com/PRIVATE_TRACKING_CANARY"}],
 fulfillmentLineItems:{nodes:lines,pageInfo:{hasNextPage:false,endCursor:null}}});
const record=(source,reference,fulfillments)=>({id:shopify_order_gid,sourceName:source,app:{name:"Channable"},
 customAttributes:[{key:source==="amazon"?"Amazon Order ID":"Spartoo Order ID",value:reference},
  {key:"Private Note",value:"PII_CANARY_ORDER_NOTE"}],
 displayFulfillmentStatus:fulfillments.length?"FULFILLED":"UNFULFILLED",fulfillments});
const ship1=shipment(1,[line(71,"00_SKU_TEST ",1)]);
const input={provider:"amazon",shopify_order_gid,external_order_id:amazonId};
const reviewInput={shopify_order_gid,amazon_order_id:amazonId};
const fake=async(_env,query,vars)=>{
 eq(query,SHOPIFY_CHANNABLE_FULFILLMENT_QUERY);
 assert(query.includes("trackingInfo(first:10){company number}"));checks++;
 assert(!/\burl\b|\baddress\b|\bcustomer\b|\btrackingCompany\b/.test(query));checks++;
 eq(vars.id,shopify_order_gid);
 return {order:record("amazon",amazonId,[ship1])};
};
const r=await readShopifyChannableFulfillmentMetadata(input,env,fake);
for(const [field,value] of Object.entries({ok:true,shipment_count:1,tracking_info_entries:1,
 fulfillment_line_units:1,tracking_number_present_count:1,tracking_number_missing_count:0,
 all_tracking_entries_have_numbers:true,tracking_numbers_or_urls_requested:true,
 tracking_numbers_requested:true,tracking_numbers_returned:false,tracking_urls_requested:false,
 tracking_number_fingerprints_returned:false,can_confirm_marketplace_shipment:false,
 can_change_shopify_fulfillment:false,can_release_stock_reservation:false}))eq(r[field],value);
eq(r.shipments[0].carrier_names[0],"brt");
eq(r.shipments[0].lines[0].sku,"00_SKU_TEST ");
eq(r.shipments[0].tracking_number_present_count,1);
eq(r.shipments[0].all_tracking_entries_have_numbers,true);
const privateValues=["PII_CANARY","PRIVATE_TRACKING_CANARY"];
for(const value of privateValues){assert(!JSON.stringify(r).includes(value));checks++;}
const orderLines={ok:true,source:"shopify_channable_amazon_order_lines",shopify_order_gid,amazon_order_id:amazonId,
 importer_app:"Channable",source_name:"amazon",line_count:1,pagination_complete:true,read_only:true,
 all_line_skus_mapped:true,order_import_already_present:true,full_line_comparison_pending:true,
 can_create_order:false,can_adjust_inventory:false,can_confirm_shipment:false,
 lines:[{line_item_gid:"gid://shopify/LineItem/71",sku:"00_SKU_TEST ",ordered_quantity:1,current_quantity:1,
  variant_gid:"gid://shopify/ProductVariant/81"}]};
function withShipments(shipments){return {...r,shipments,shipment_count:shipments.length,
 tracking_info_entries:shipments.reduce((n,x)=>n+x.tracking_entry_count,0),
 tracking_number_present_count:shipments.reduce((n,x)=>n+x.tracking_number_present_count,0),
 tracking_number_missing_count:shipments.reduce((n,x)=>n+x.tracking_number_missing_count,0),
 all_tracking_entries_have_numbers:shipments.some(x=>x.tracking_entry_count>0)&&shipments.every(x=>x.tracking_number_missing_count===0),
 fulfillment_line_units:shipments.reduce((n,x)=>n+x.lines.reduce((sum,l)=>sum+l.quantity,0),0)};}
const complete=compareChannableFulfillmentCoverage(orderLines,r);
for(const [field,value] of Object.entries({coverage:"SHOPIFY_FULFILLMENT_LINES_COMPLETE",
 tracking_review:"SUCCESSFUL_FULFILLMENTS_TRACKING_PRESENT",successful_fulfillments:1,
 successful_fulfillments_with_tracking_presence:1,successful_fulfillments_missing_tracking_presence:0,
 successful_line_units_with_tracking_presence:1,current_quantity_review_required:false,
 sku_consistency_verified:true,carrier_mapping_proven:false,tracking_number_validity_proven:false,
 carrier_handover_proven:false,amazon_tracking_confirmation_proven:false,
 may_confirm_marketplace_shipment:false,may_release_reservations:false}))eq(complete[field],value);
const unfulfilled=await readShopifyChannableFulfillmentMetadata(input,env,
 async()=>({order:record("amazon",amazonId,[])}));
eq(unfulfilled.shipment_count,0);
eq(unfulfilled.all_tracking_entries_have_numbers,false);
eq(compareChannableFulfillmentCoverage(orderLines,unfulfilled).coverage,"NO_SHIPMENTS");
eq(compareChannableFulfillmentCoverage(orderLines,unfulfilled).tracking_review,"NO_SUCCESSFUL_FULFILLMENTS");
const larger={...orderLines,lines:[{...orderLines.lines[0],ordered_quantity:2,current_quantity:2}]};
const partial=compareChannableFulfillmentCoverage(larger,r);
eq(partial.coverage,"PARTIAL");eq(partial.tracking_review,"PARTIAL_SUCCESSFUL_FULFILLMENTS");
const changedCurrent=compareChannableFulfillmentCoverage({...orderLines,lines:[{...orderLines.lines[0],current_quantity:0}]},r);
eq(changedCurrent.current_quantity_review_required,true);
eq(changedCurrent.tracking_review,"CURRENT_QUANTITY_REVIEW_REQUIRED");
eq(changedCurrent.may_confirm_marketplace_shipment,false);
const successful=r.shipments[0];
bad(()=>compareChannableFulfillmentCoverage(orderLines,withShipments([{...successful,
 lines:[{...successful.lines[0],quantity:2}]}])),/overshipped/);
bad(()=>compareChannableFulfillmentCoverage(orderLines,withShipments([{...successful,
 lines:[{...successful.lines[0],line_item_gid:"gid://shopify/LineItem/888"}]}])),/unknown_line/);
bad(()=>compareChannableFulfillmentCoverage(orderLines,withShipments([{...successful,
 lines:[{...successful.lines[0],sku:"00_SKU_TEST"}]}])),/sku_conflict/);
const spartoo=await readShopifyChannableFulfillmentMetadata({provider:"spartoo",shopify_order_gid,external_order_id:spartooId},
 env,async()=>({order:record("spartoo",spartooId,[shipment(2,[line(80,"SPARTOO_TEST",1)],"UPS")])}));
eq(spartoo.ok,true);eq(spartoo.provider,"spartoo");eq(spartoo.shipments[0].carrier_names[0],"UPS");
bad(()=>compareChannableFulfillmentCoverage(orderLines,spartoo),/untrusted_source/);

// PR210: SUCCESS only, with failed/cancelled records diagnostic and pending
// operations blocking a complete-coverage verdict even alongside SUCCESS.
for(const status of ["CANCELLED","ERROR","FAILURE","OPEN","PENDING"]){
 const observed=await readShopifyChannableFulfillmentMetadata(input,env,
  async()=>({order:record("amazon",amazonId,[{...ship1,status}])}));
 const coverage=compareChannableFulfillmentCoverage(orderLines,observed);
 eq(coverage.fulfillment_line_units,0);eq(coverage.successful_fulfillments,0);
 eq(coverage.excluded_non_success_fulfillments,1);
 eq(coverage.successful_line_units_with_tracking_presence,0);
 eq(coverage.coverage,["OPEN","PENDING"].includes(status)?"PENDING_FULFILLMENT_REVIEW":"NO_SUCCESSFUL_FULFILLMENTS");
 eq(coverage.tracking_review,["OPEN","PENDING"].includes(status)?"PENDING_FULFILLMENT_REVIEW":"NO_SUCCESSFUL_FULFILLMENTS");
 eq(coverage.may_confirm_marketplace_shipment,false);eq(coverage.may_release_reservations,false);
}
const replacement=compareChannableFulfillmentCoverage(orderLines,withShipments([
 {...successful,fulfillment_gid:"gid://shopify/Fulfillment/99",status:"CANCELLED"},successful]));
eq(replacement.fulfillment_line_units,1);eq(replacement.coverage,"SHOPIFY_FULFILLMENT_LINES_COMPLETE");
eq(replacement.excluded_non_success_fulfillments,1);eq(replacement.successful_fulfillments_with_tracking_presence,1);
const pending=compareChannableFulfillmentCoverage(orderLines,withShipments([successful,
 {...successful,fulfillment_gid:"gid://shopify/Fulfillment/98",status:"PENDING"}]));
eq(pending.coverage,"PENDING_FULFILLMENT_REVIEW");eq(pending.fulfillment_line_units,1);
eq(pending.tracking_review,"PENDING_FULFILLMENT_REVIEW");
bad(()=>compareChannableFulfillmentCoverage(orderLines,withShipments([successful,successful])),/shipment_identity_conflict/);
bad(()=>compareChannableFulfillmentCoverage(orderLines,withShipments([{...successful,status:"NEW_UNRECOGNIZED_PROVIDER_STATE"}])),/unknown_status/);
bad(()=>compareChannableFulfillmentCoverage(larger,withShipments([{...successful,lines:[successful.lines[0],successful.lines[0]]}])),/duplicate_line/);

// A carrier-only entry, null, empty or whitespace number is not tracking.
for(const trackingInfo of [[],[{company:"brt",number:null}],[{company:"brt",number:""}],
 [{company:"brt",number:"   "}],[{company:"brt",number:"SYNTHETIC_NUMBER"},{company:"brt",number:null}]]){
 const observed=await readShopifyChannableFulfillmentMetadata(input,env,
  async()=>({order:record("amazon",amazonId,[{...ship1,trackingInfo}])}));
 eq(observed.shipments[0].all_tracking_entries_have_numbers,false);
 const review=compareChannableFulfillmentCoverage(orderLines,observed);
 eq(review.coverage,"SHOPIFY_FULFILLMENT_LINES_COMPLETE");
 eq(review.tracking_review,"SUCCESSFUL_FULFILLMENTS_TRACKING_MISSING");
 eq(review.successful_line_units_with_tracking_presence,0);
 eq(review.successful_fulfillments_missing_tracking_presence,1);
}
// Split SUCCESS fulfillments require tracking on each contributing shipment.
const split=withShipments([successful,{...successful,fulfillment_gid:"gid://shopify/Fulfillment/2",
 tracking_entry_count:0,carrier_names:[],tracking_number_present_count:0,tracking_number_missing_count:0,
 all_tracking_entries_have_numbers:false}]);
const splitReview=compareChannableFulfillmentCoverage(larger,split);
eq(splitReview.fulfillment_line_units,2);eq(splitReview.successful_line_units_with_tracking_presence,1);
eq(splitReview.tracking_review,"SUCCESSFUL_FULFILLMENTS_TRACKING_MISSING");

// Strict bounds, complete sets and safe source identity are mandatory.
for(const altered of [{sourceName:"web"},{app:{name:"Another App"}},{customAttributes:[]},
 {fulfillments:[ship1,ship1]},
 {fulfillments:Array.from({length:10},(_,i)=>({...ship1,id:"gid://shopify/Fulfillment/"+(100+i)}))},
 {fulfillments:[shipment(5,[line(5,"TEST",1)],"Bad\nCarrier")]},
 {fulfillments:[{...ship1,fulfillmentLineItems:{nodes:ship1.fulfillmentLineItems.nodes,pageInfo:{hasNextPage:true,endCursor:"next"}}}]},
 {fulfillments:[{...ship1,fulfillmentLineItems:{nodes:Array.from({length:51},(_,i)=>line(100+i,"TEST",1)),pageInfo:{hasNextPage:false}}}]},
 {fulfillments:[{...ship1,trackingInfo:Array(10).fill({company:"brt",number:"SYNTHETIC_NUMBER"})}]},
 ...[undefined,1,true,{},"X".repeat(257),"SYNTHETIC\nPRIVATE"].map(number=>({fulfillments:[{...ship1,trackingInfo:[{company:"brt",number}]}]}))]){
 await rejects(()=>readShopifyChannableFulfillmentMetadata(input,env,
  async()=>({order:{...record("amazon",amazonId,[ship1]),...altered}})));
}
// Connection pageInfo proves an exact 50-line page complete. The bounded
// fulfillment/tracking arrays do not expose a comparable completion flag.
const fiftyLines=Array.from({length:50},(_,i)=>line(100+i,"SYNTHETIC_SKU_"+i,1));
const fifty=await readShopifyChannableFulfillmentMetadata(input,env,async()=>({order:record("amazon",amazonId,
 [{...ship1,fulfillmentLineItems:{nodes:fiftyLines,pageInfo:{hasNextPage:false,endCursor:null}}}])}));
eq(fifty.fulfillment_line_units,50);eq(fifty.shipments[0].lines.length,50);
const fiftyExpected={...orderLines,line_count:50,lines:fiftyLines.map((x,i)=>({line_item_gid:x.lineItem.id,
 sku:x.lineItem.sku,ordered_quantity:1,current_quantity:1,variant_gid:"gid://shopify/ProductVariant/"+(100+i)}))};
eq(compareChannableFulfillmentCoverage(fiftyExpected,fifty).coverage,"SHOPIFY_FULFILLMENT_LINES_COMPLETE");
await rejects(()=>readShopifyChannableFulfillmentMetadata(input,env,async()=>({order:record("amazon",amazonId,
 [{...ship1,fulfillmentLineItems:{nodes:fiftyLines,pageInfo:{hasNextPage:true,endCursor:"next"}}}])})),/pagination_incomplete/);

for(const mutate of [x=>{x.pagination_complete=false;},x=>{x.read_only=false;},x=>{x.can_create_order=true;},
 x=>{x.can_adjust_inventory=true;},x=>{x.can_confirm_shipment=true;},x=>{x.all_line_skus_mapped=false;},
 x=>{x.line_count++;},x=>{x.shopify_order_gid="gid://shopify/Order/999";},x=>{x.importer_app="Other";},
 x=>{x.lines[0].variant_gid="gid://shopify/Product/81";},x=>{x.lines[0].current_quantity=2;},
 x=>{x.lines[0].current_quantity=-1;},x=>{x.lines[0].current_quantity="1";},x=>{x.lines[0].sku=null;}]){
 const badLines=clone(orderLines);mutate(badLines);
 bad(()=>compareChannableFulfillmentCoverage(badLines,r));
}
for(const mutate of [x=>{x.tracking_numbers_returned=true;},x=>{x.tracking_numbers_requested=false;},
 x=>{x.can_confirm_marketplace_shipment=true;},x=>{x.metadata_complete_bounded=false;},x=>{x.shipment_count++;},
 x=>{x.tracking_number_present_count++;},x=>{x.fulfillment_line_units++;},
 x=>{x.shipments[0].all_tracking_entries_have_numbers=false;},x=>{x.shipments[0].tracking_number_present_count=-1;},
 x=>{x.shipments[0].tracking_number_missing_count=1;},x=>{x.shipments[0].tracking_entry_count=10;},
 x=>{x.order_display_fulfillment_status={private:"PII_CANARY"};}]){
 const badMeta=clone(r);mutate(badMeta);
 bad(()=>compareChannableFulfillmentCoverage(orderLines,badMeta));
}

// Server wrapper admits only IDs and fetches both observations itself.
let lineCalls=0,metadataCalls=0;
const deps={clock:()=>Date.parse("2026-10-18T12:00:00Z"),
 readOrderLines:async request=>{lineCalls++;assert.deepEqual(request,reviewInput);return clone(orderLines);},
 readFulfillmentMetadata:async request=>{metadataCalls++;assert.deepEqual(request,input);return clone(r);}};
const reviewed=await readShopifyChannableAmazonFulfillmentReview(reviewInput,env,deps);
eq(lineCalls,1);eq(metadataCalls,1);eq(reviewed.observed_at,"2026-10-18T12:00:00.000Z");
eq(reviewed.review_status,"SUCCESSFUL_FULFILLMENTS_TRACKING_PRESENT");
eq(reviewed.provider_mutations,0);eq(reviewed.importer_ownership,"NOT_TRANSFERRED_FROM_CHANNABLE");
eq(reviewed.tracking_numbers_returned,false);eq(reviewed.tracking_urls_requested,false);
eq(reviewed.can_confirm_marketplace_shipment,false);eq(reviewed.can_change_shopify_fulfillment,false);
for(const privateValue of [...privateValues,amazonId,shopify_order_gid,"00_SKU_TEST","gid://shopify/"]){
 assert(!JSON.stringify(reviewed).includes(privateValue));checks++;
}
for(const request of [{...reviewInput,tracking_number:"PII_CANARY"},{...reviewInput,lines:orderLines.lines},
 {...reviewInput,provider:"amazon"},{...reviewInput,amazon_order_id:"invalid"},{shopify_order_gid},null]){
 await rejects(()=>readShopifyChannableAmazonFulfillmentReview(request,env,deps),/invalid_request/);
}
eq(lineCalls,1);eq(metadataCalls,1);
await rejects(()=>readShopifyChannableAmazonFulfillmentReview(reviewInput,env,{...deps,
 readOrderLines:async()=>({...orderLines,amazon_order_id:"999-9999999-9999999"})}),/identity_conflict/);
eq(metadataCalls,1);
for(const call of [
 ()=>readShopifyChannableFulfillmentMetadata(input,env,async()=>{throw Error("PII_CANARY_TRACKING_NUMBER");}),
 ()=>readShopifyChannableAmazonFulfillmentReview(reviewInput,env,{...deps,readOrderLines:async()=>{throw Error("PII_CANARY_TRACKING_NUMBER");}}),
 ()=>readShopifyChannableAmazonFulfillmentReview(reviewInput,env,{...deps,readOrderLines:async()=>{throw Error("channable_fulfillment_sensitive_tracking_canary");}}),
 ()=>readShopifyChannableAmazonFulfillmentReview(reviewInput,env,{...deps,readFulfillmentMetadata:async()=>{throw Error("channable_fulfillment_sensitive_tracking_canary");}})
]){
 await rejects(call,error=>{assert(!error.message.includes("PII_CANARY"));assert(!error.message.includes("sensitive_tracking_canary"));return /^channable_fulfillment_[a-z_]+$/.test(error.message);});
}
await rejects(()=>readShopifyChannableAmazonFulfillmentReview(reviewInput,env,{...deps,clock:()=>NaN}),/clock_invalid/);
const reviewedChanged=await readShopifyChannableAmazonFulfillmentReview(reviewInput,env,{...deps,
 readOrderLines:async()=>({...orderLines,lines:[{...orderLines.lines[0],current_quantity:0}]})});
eq(reviewedChanged.review_status,"CURRENT_QUANTITY_REVIEW_REQUIRED");
console.log("PASS fulfillment review: "+checks+" checks; PR210 SUCCESS-only coverage, tracking presence without numbers/URLs/fingerprints, SKU/current quantities, bounded sets, server-only reads and redacted failures; zero provider mutations");
