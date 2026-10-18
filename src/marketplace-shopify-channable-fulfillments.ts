import {shopifyGraphQL} from "./index.js";
import type {MareBusinessShopifyEnv} from "./mare-business-shopify.js";
import {readShopifyChannableAmazonOrderLines} from "./marketplace-shopify-channable-amazon-lines.js";

/**
 * Merchant-private Shopify shipment observation. Public metadata contains
 * presence counts only. A separate internal projection keeps tracking numbers
 * transiently for exact Amazon readback comparison; no persistence or mutation.
 */
type Row=Record<string,unknown>;
type Reader=typeof shopifyGraphQL;
type Data={order?:Row|null};
export type PrivateChannableFulfillmentObservation={
 metadata:Row;
 private_tracking_entries:Array<{
  fulfillment_gid:string;
  tracking_entries:Array<{company:string|null;number:string|null}>;
 }>;
};
const ORDER_RE=/^gid:\/\/shopify\/Order\/\d+$/;
const FULFILLMENT_RE=/^gid:\/\/shopify\/Fulfillment\/\d+$/;
const LINE_RE=/^gid:\/\/shopify\/LineItem\/\d+$/;
const VARIANT_RE=/^gid:\/\/shopify\/ProductVariant\/\d+$/;
const PROVIDERS={
 amazon:{source:"amazon",key:"Amazon Order ID",pattern:/^\d{3}-\d{7}-\d{7}$/},
 spartoo:{source:"spartoo",key:"Spartoo Order ID",pattern:/^\d{16}$/}
} as const;
const FULFILLMENT_CAP=10;
const TRACK_CAP=10;
const LINE_CAP=50;
export const SHOPIFY_CHANNABLE_FULFILLMENT_QUERY=[
  "query MareChannableMarketplaceFulfillments($id:ID!){",
  " order(id:$id){",
  "  id sourceName app{name} customAttributes{key value} displayFulfillmentStatus",
  "  fulfillments(first:10){",
  "   id status displayStatus trackingInfo(first:10){company number}",
  "   fulfillmentLineItems(first:50){",
  "    pageInfo{hasNextPage endCursor}",
  "    nodes{id quantity lineItem{id sku}}",
  "   }",
  "  }",
  " }",
  "}"
].join("\n");
function obj(v:unknown):Row{return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};}
function str(v:unknown):string{return typeof v==="string"?v:"";}
function positive(v:unknown):v is number{
 return typeof v==="number"&&Number.isSafeInteger(v)&&v>=1&&v<=100000;
}
function nonnegative(v:unknown,max=Number.MAX_SAFE_INTEGER):v is number{
 return typeof v==="number"&&Number.isSafeInteger(v)&&v>=0&&v<=max;
}
function validSku(v:unknown):v is string{
 return typeof v==="string"&&v.length>0&&v.length<=200&&!/[\u0000-\u001f\u007f]/.test(v);
}
function trackingNumberPresent(value:unknown):boolean{
 if(value===null)return false;
 if(typeof value!=="string"||value.length>256||/[\u0000-\u001f\u007f]/.test(value))
  throw new Error("channable_fulfillment_tracking_number_invalid");
 // Presence is not carrier validation. Keep the original number private and
 // do not normalize, expose through public metadata, fingerprint or persist it.
 return value.trim().length>0;
}
function verifiedTrackingPresence(shipment:Row):boolean{
 const entries=shipment.tracking_entry_count,present=shipment.tracking_number_present_count,
  missing=shipment.tracking_number_missing_count;
 if(!nonnegative(entries,TRACK_CAP-1)||!nonnegative(present,entries)||!nonnegative(missing,entries)||
    present+missing!==entries||!Array.isArray(shipment.carrier_names)||shipment.carrier_names.length!==entries||
    shipment.carrier_names.some(v=>typeof v!=="string"||v.length<1||v.length>90||/[\u0000-\u001f\u007f]/.test(v))||
    shipment.all_tracking_entries_have_numbers!==(entries>0&&present===entries))
  throw new Error("channable_fulfillment_tracking_presence_invalid");
 return entries>0&&present===entries;
}

/** Internal server-only projection. Never register this reader directly as a
 * capability or serialize its result outside the shipment comparison boundary.
 * The public metadata reader below discards private_tracking_entries.
 */
export async function readShopifyChannableFulfillmentMetadataPrivate(
 input:Row,env:MareBusinessShopifyEnv,
 reader:Reader=shopifyGraphQL
):Promise<PrivateChannableFulfillmentObservation>{
 if(!input||typeof input!=="object"||Array.isArray(input)||
    Object.keys(input).some(k=>!["provider","shopify_order_gid","external_order_id"].includes(k))||
    !Object.hasOwn(PROVIDERS,str(input.provider))||
    !ORDER_RE.test(str(input.shopify_order_gid)))
  throw new Error("channable_fulfillment_invalid_request");
 const provider=input.provider as keyof typeof PROVIDERS,conf=PROVIDERS[provider];
 if(!conf.pattern.test(str(input.external_order_id)))
  throw new Error("channable_fulfillment_external_id_invalid");
 const gid=String(input.shopify_order_gid);
 let data:Data;
 try{data=await reader<Data>(env,SHOPIFY_CHANNABLE_FULFILLMENT_QUERY,{id:gid});}
 catch{throw new Error("channable_fulfillment_provider_read_failed");}
 const order=obj(data?.order);
 if(order.id!==gid||order.sourceName!==conf.source||obj(order.app).name!=="Channable")
  throw new Error("channable_fulfillment_order_identity_conflict");
 if(!Array.isArray(order.customAttributes))
  throw new Error("channable_fulfillment_order_reference_missing");
 const attrs=order.customAttributes.map(obj).filter(x=>x.key===conf.key);
 if(attrs.length!==1||attrs[0].value!==input.external_order_id)
  throw new Error("channable_fulfillment_order_reference_conflict");
 if(!Array.isArray(order.fulfillments)||order.fulfillments.length>=FULFILLMENT_CAP)
  throw new Error("channable_fulfillment_shipment_set_incomplete");
 const shipments:Array<{
  fulfillment_gid:string;status:string;carrier_names:string[];
  tracking_entry_count:number;
  tracking_number_present_count:number;tracking_number_missing_count:number;
  all_tracking_entries_have_numbers:boolean;
  lines:Array<{line_item_gid:string;sku:string|null;quantity:number}>
 }>=[];
 const privateTracking:PrivateChannableFulfillmentObservation["private_tracking_entries"]=[];
 let trackingEntries=0,totalLineUnits=0,trackingPresent=0,trackingMissing=0;
 const uniqueFulfillments=new Set<string>();
 for(const raw of order.fulfillments){
  const f=obj(raw),fid=str(f.id);
  if(!FULFILLMENT_RE.test(fid)||uniqueFulfillments.has(fid)||
     !str(f.status)||str(f.status).length>60||/[\u0000-\u001f\u007f]/.test(str(f.status)))
   throw new Error("channable_fulfillment_invalid_or_duplicate_shipment");
  uniqueFulfillments.add(fid);
  if(!Array.isArray(f.trackingInfo)||f.trackingInfo.length>=TRACK_CAP)
   throw new Error("channable_fulfillment_tracking_metadata_incomplete");
  const carriers:string[]=[];
  const privateEntries:Array<{company:string|null;number:string|null}>=[];
  let present=0;
  for(const rawTrack of f.trackingInfo){
   const track=obj(rawTrack),carrier=str(track.company);
   if(track.company!==null&&typeof track.company!=="string")
    throw new Error("channable_fulfillment_carrier_invalid");
   if(carrier.length>90||/[\u0000-\u001f\u007f]/.test(carrier))
    throw new Error("channable_fulfillment_carrier_invalid");
   carriers.push(carrier||"UNVERIFIED");
   if(trackingNumberPresent(track.number))present++;
   privateEntries.push({company:track.company as string|null,number:track.number as string|null});
   trackingEntries++;
  }
  const missing=carriers.length-present;
  trackingPresent+=present;trackingMissing+=missing;
  const lc=obj(f.fulfillmentLineItems),page=obj(lc.pageInfo);
  if(page.hasNextPage!==false||!Array.isArray(lc.nodes)||
     lc.nodes.length<1||lc.nodes.length>LINE_CAP)
   throw new Error("channable_fulfillment_line_pagination_incomplete");
  const lines:Array<{line_item_gid:string;sku:string|null;quantity:number}>=[];
  const lineIds=new Set<string>();
  for(const rawLine of lc.nodes){
   const node=obj(rawLine),line=obj(node.lineItem),lid=str(line.id),skuValue=line.sku;
   const sku=skuValue==null?null:str(skuValue);
   if(!LINE_RE.test(lid)||lineIds.has(lid)||!positive(node.quantity)||
      (sku!==null&&(!sku||sku.length>200||/[\u0000-\u001f\u007f]/.test(sku))))
    throw new Error("channable_fulfillment_invalid_line");
   lineIds.add(lid);
   totalLineUnits+=node.quantity;
   if(!Number.isSafeInteger(totalLineUnits))
    throw new Error("channable_fulfillment_quantity_overflow");
   lines.push({line_item_gid:lid,sku,quantity:node.quantity});
  }
  shipments.push({
    fulfillment_gid:fid,status:str(f.status),carrier_names:carriers,
    tracking_entry_count:carriers.length,
    tracking_number_present_count:present,tracking_number_missing_count:missing,
    all_tracking_entries_have_numbers:carriers.length>0&&missing===0,lines
  });
  privateTracking.push({fulfillment_gid:fid,tracking_entries:privateEntries});
 }
 const status=str(order.displayFulfillmentStatus);
 if(!status||status.length>90||/[\u0000-\u001f\u007f]/.test(status))
  throw new Error("channable_fulfillment_order_status_invalid");
 const metadata:Row={
  ok:true,source:"shopify_channable_marketplace_fulfillment_metadata",
  provider,shopify_order_gid:gid,external_order_id:input.external_order_id,
  order_display_fulfillment_status:status,shipment_count:shipments.length,
  tracking_info_entries:trackingEntries,fulfillment_line_units:totalLineUnits,
  tracking_number_present_count:trackingPresent,tracking_number_missing_count:trackingMissing,
  all_tracking_entries_have_numbers:trackingEntries>0&&trackingMissing===0,
  shipments,metadata_complete_bounded:true,read_only:true,
  tracking_numbers_or_urls_requested:true,
  tracking_numbers_requested:true,tracking_numbers_returned:false,
  tracking_urls_requested:false,tracking_number_fingerprints_returned:false,
  tracking_presence_not_marketplace_confirmation:true,
  carrier_presence_not_marketplace_confirmation:true,
  can_confirm_marketplace_shipment:false,can_change_shopify_fulfillment:false,
  can_release_stock_reservation:false
 };
 return {metadata,private_tracking_entries:privateTracking};
}

/** Existing public metadata shape is deliberately unchanged. The same single
 * validated provider read supplies either counts or the internal comparison.
 */
export async function readShopifyChannableFulfillmentMetadata(
 input:Row,env:MareBusinessShopifyEnv,reader:Reader=shopifyGraphQL
):Promise<Row>{
 return (await readShopifyChannableFulfillmentMetadataPrivate(input,env,reader)).metadata;
}

/** Audit F05: SUCCESS means Shopify completed the fulfillment operation,
 * not carrier handover, delivery or Amazon receipt. Count only SUCCESS.
 * Cancelled/failed records remain diagnostic evidence; pending records
 * prohibit a complete-coverage verdict even if other lines already match.
 */
export function compareChannableFulfillmentCoverage(
  orderLinesRaw:unknown,shipmentRaw:unknown
):Row{
 const a=obj(orderLinesRaw),b=obj(shipmentRaw);
 if(a.ok!==true||a.source!=="shopify_channable_amazon_order_lines"||
    a.importer_app!=="Channable"||a.source_name!=="amazon"||
    a.pagination_complete!==true||a.read_only!==true||a.order_import_already_present!==true||
    a.can_create_order!==false||a.can_adjust_inventory!==false||a.can_confirm_shipment!==false||
    a.all_line_skus_mapped!==true||!ORDER_RE.test(str(a.shopify_order_gid))||
    !PROVIDERS.amazon.pattern.test(str(a.amazon_order_id))||
    b.ok!==true||b.source!=="shopify_channable_marketplace_fulfillment_metadata"||
    b.provider!=="amazon"||b.metadata_complete_bounded!==true||
    b.tracking_numbers_requested!==true||b.tracking_numbers_or_urls_requested!==true||
    b.tracking_numbers_returned!==false||b.tracking_urls_requested!==false||
    b.tracking_number_fingerprints_returned!==false||b.tracking_presence_not_marketplace_confirmation!==true||
    b.can_confirm_marketplace_shipment!==false||b.can_change_shopify_fulfillment!==false||
    b.can_release_stock_reservation!==false||
    typeof b.order_display_fulfillment_status!=="string"||b.order_display_fulfillment_status.length<1||
    b.order_display_fulfillment_status.length>90||/[\u0000-\u001f\u007f]/.test(b.order_display_fulfillment_status)||
    b.read_only!==true||a.shopify_order_gid!==b.shopify_order_gid||
    a.amazon_order_id!==b.external_order_id||
    !Array.isArray(a.lines)||!Array.isArray(b.shipments)||
    a.lines.length>200||b.shipments.length>=FULFILLMENT_CAP||
    a.line_count!==a.lines.length||b.shipment_count!==b.shipments.length)
   throw new Error("channable_fulfillment_coverage_untrusted_source");
 const expected=new Map<string,number>();
 const expectedSkus=new Map<string,string>();
 let changedCurrentQuantities=false;
 for(const raw of a.lines){
  const x=obj(raw),id=str(x.line_item_gid),ordered=x.ordered_quantity;
  if(!LINE_RE.test(id)||expected.has(id)||!positive(ordered)||!validSku(x.sku)||
     !VARIANT_RE.test(str(x.variant_gid))||!nonnegative(x.current_quantity,ordered))
   throw new Error("channable_fulfillment_coverage_invalid_line");
  expected.set(id,ordered);
  expectedSkus.set(id,x.sku);
  if(x.current_quantity!==ordered)changedCurrentQuantities=true;
 }
 if(!expected.size)throw new Error("channable_fulfillment_coverage_empty_order");
 const allowedStatuses=new Set(["SUCCESS","CANCELLED","ERROR","FAILURE","OPEN","PENDING"]);
 const seenShipments=new Set<string>();
 const shipped=new Map<string,number>();
 let excludedShipments=0,pendingShipments=0,successfulShipments=0;
 let trackingEntries=0,trackingPresent=0,trackingMissing=0,allLineUnits=0;
 let successfulWithTracking=0,successfulMissingTracking=0,trackedSuccessfulUnits=0;
 for(const raw of b.shipments){
  const shipment=obj(raw),fid=str(shipment.fulfillment_gid),status=str(shipment.status);
  if(!FULFILLMENT_RE.test(fid)||seenShipments.has(fid))
   throw new Error("channable_fulfillment_coverage_shipment_identity_conflict");
  if(!allowedStatuses.has(status))
   throw new Error("channable_fulfillment_coverage_unknown_status");
  seenShipments.add(fid);
  const hasTracking=verifiedTrackingPresence(shipment);
  trackingEntries+=shipment.tracking_entry_count as number;
  trackingPresent+=shipment.tracking_number_present_count as number;
  trackingMissing+=shipment.tracking_number_missing_count as number;
  const lines=shipment.lines;
  if(!Array.isArray(lines)||lines.length<1||lines.length>LINE_CAP)
   throw new Error("channable_fulfillment_coverage_missing_lines");
  const seenLines=new Set<string>();
  for(const rawLine of lines){
   const x=obj(rawLine),id=str(x.line_item_gid),quantity=x.quantity;
   if(!expected.has(id)||!positive(quantity))
    throw new Error("channable_fulfillment_coverage_unknown_line");
   if(x.sku!==expectedSkus.get(id))
    throw new Error("channable_fulfillment_coverage_sku_conflict");
   if(seenLines.has(id))throw new Error("channable_fulfillment_coverage_duplicate_line");
   seenLines.add(id);
   allLineUnits+=quantity;
   if(!Number.isSafeInteger(allLineUnits))throw new Error("channable_fulfillment_coverage_overflow");
   if(status!=="SUCCESS")continue;
   const total=(shipped.get(id)??0)+quantity;
   if(!Number.isSafeInteger(total)||total>expected.get(id)!)
    throw new Error("channable_fulfillment_coverage_overshipped");
   shipped.set(id,total);
   if(hasTracking)trackedSuccessfulUnits+=quantity;
  }
  if(status==="SUCCESS"){
   successfulShipments++;
   if(hasTracking)successfulWithTracking++;else successfulMissingTracking++;
  }
  else {
   excludedShipments++;
   if(status==="OPEN"||status==="PENDING")pendingShipments++;
  }
 }
 let totalExpected=0,totalShipped=0;
 for(const [id,count] of expected){
  totalExpected+=count;totalShipped+=shipped.get(id)??0;
 }
 if(!Number.isSafeInteger(totalExpected)||!Number.isSafeInteger(totalShipped))
  throw new Error("channable_fulfillment_coverage_overflow");
 if(b.tracking_info_entries!==trackingEntries||b.tracking_number_present_count!==trackingPresent||
    b.tracking_number_missing_count!==trackingMissing||b.fulfillment_line_units!==allLineUnits||
    b.all_tracking_entries_have_numbers!==(trackingEntries>0&&trackingMissing===0))
  throw new Error("channable_fulfillment_coverage_counter_conflict");
 const coverage=pendingShipments>0?"PENDING_FULFILLMENT_REVIEW":
   b.shipments.length===0?"NO_SHIPMENTS":
   totalShipped===0?"NO_SUCCESSFUL_FULFILLMENTS":
   totalShipped===totalExpected?"SHOPIFY_FULFILLMENT_LINES_COMPLETE":"PARTIAL";
 const trackingReview=changedCurrentQuantities?"CURRENT_QUANTITY_REVIEW_REQUIRED":
   pendingShipments>0?"PENDING_FULFILLMENT_REVIEW":
   successfulShipments===0?"NO_SUCCESSFUL_FULFILLMENTS":
   successfulMissingTracking>0?"SUCCESSFUL_FULFILLMENTS_TRACKING_MISSING":
   totalShipped!==totalExpected?"PARTIAL_SUCCESSFUL_FULFILLMENTS":
   "SUCCESSFUL_FULFILLMENTS_TRACKING_PRESENT";
 return {
  ok:true,source:"channable_order_fulfillment_shadow_coverage",
  original_line_units:totalExpected,fulfillment_line_units:totalShipped,
  successful_fulfillments:successfulShipments,
  excluded_non_success_fulfillments:excludedShipments,
  pending_fulfillments:pendingShipments,coverage,
  coverage_basis:"SHOPIFY_SUCCESS_ONLY_NOT_CARRIER_HANDOVER",
  current_quantity_review_required:changedCurrentQuantities,
  successful_fulfillments_with_tracking_presence:successfulWithTracking,
  successful_fulfillments_missing_tracking_presence:successfulMissingTracking,
  successful_line_units_with_tracking_presence:trackedSuccessfulUnits,
  tracking_review:trackingReview,sku_consistency_verified:true,
  tracking_number_validity_proven:false,carrier_mapping_proven:false,
  carrier_handover_proven:false,tracking_numbers_returned:false,
  tracking_presence_not_marketplace_confirmation:true,
  read_only:true,amazon_tracking_confirmation_proven:false,
  may_confirm_marketplace_shipment:false,may_release_reservations:false
 };
}

type FulfillmentReviewDependencies={
 readOrderLines?:typeof readShopifyChannableAmazonOrderLines;
 readFulfillmentMetadata?:typeof readShopifyChannableFulfillmentMetadata;
 clock?:()=>number;
};
/** Private server-side review only. Callers supply identifiers, never provider
 * observations, quantities, tracking data or permission flags. Output contains
 * aggregate evidence only; even the private tracking number is discarded.
 */
export async function readShopifyChannableAmazonFulfillmentReview(
 input:Row,env:MareBusinessShopifyEnv,dependencies:FulfillmentReviewDependencies={}
):Promise<Row>{
 if(!input||typeof input!=="object"||Array.isArray(input)||
    Object.keys(input).length!==2||Object.keys(input).some(k=>!["shopify_order_gid","amazon_order_id"].includes(k))||
    !ORDER_RE.test(str(input.shopify_order_gid))||!PROVIDERS.amazon.pattern.test(str(input.amazon_order_id)))
  throw new Error("channable_fulfillment_review_invalid_request");
 const readLines=dependencies.readOrderLines??readShopifyChannableAmazonOrderLines;
 const readMetadata=dependencies.readFulfillmentMetadata??readShopifyChannableFulfillmentMetadata;
 let lines:Row;
 try{lines=await readLines({shopify_order_gid:input.shopify_order_gid,amazon_order_id:input.amazon_order_id},env);}
 catch{throw new Error("channable_fulfillment_review_order_read_failed");}
  lines=obj(lines);
  if(lines.shopify_order_gid!==input.shopify_order_gid||lines.amazon_order_id!==input.amazon_order_id||
     lines.ok!==true||lines.source!=="shopify_channable_amazon_order_lines"||
     lines.pagination_complete!==true||lines.read_only!==true||lines.order_import_already_present!==true)
   throw new Error("channable_fulfillment_review_order_identity_conflict");
  let metadata:Row;
  try{metadata=await readMetadata({provider:"amazon",shopify_order_gid:input.shopify_order_gid,
    external_order_id:input.amazon_order_id},env);}
  catch{throw new Error("channable_fulfillment_review_metadata_read_failed");}
  metadata=obj(metadata);
  const comparison=compareChannableFulfillmentCoverage(lines,metadata);
  let now:number;
  try{now=(dependencies.clock??Date.now)();}
  catch{throw new Error("channable_fulfillment_review_clock_invalid");}
  if(!nonnegative(now)||!Number.isFinite(new Date(now).getTime()))
   throw new Error("channable_fulfillment_review_clock_invalid");
  const carriers=[...new Set((metadata.shipments as Row[]).flatMap(x=>x.carrier_names as string[]))].sort();
  return {
   ok:true,source:"shopify_channable_amazon_fulfillment_review",observed_at:new Date(now).toISOString(),
   order_display_fulfillment_status:metadata.order_display_fulfillment_status,
   shipment_count:metadata.shipment_count,carrier_names:carriers,
   tracking_info_entries:metadata.tracking_info_entries,
   tracking_number_present_count:metadata.tracking_number_present_count,
   tracking_number_missing_count:metadata.tracking_number_missing_count,
   comparison,review_status:comparison.tracking_review,read_only:true,provider_mutations:0,
   importer_ownership:"NOT_TRANSFERRED_FROM_CHANNABLE",
   tracking_numbers_requested:true,tracking_numbers_returned:false,
   tracking_urls_requested:false,tracking_number_fingerprints_returned:false,
   tracking_presence_not_marketplace_confirmation:true,
   amazon_tracking_confirmation_proven:false,carrier_mapping_proven:false,
   can_confirm_marketplace_shipment:false,can_change_shopify_fulfillment:false,
   can_release_stock_reservation:false
  };
}
