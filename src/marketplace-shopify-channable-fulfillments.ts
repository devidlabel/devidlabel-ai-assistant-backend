import {shopifyGraphQL} from "./index.js";
import type {MareBusinessShopifyEnv} from "./mare-business-shopify.js";

/**
 * R2.5: merchant-private Shopify shipment observation, no tracking numbers
 * or URLs requested, no recipient/customer/address or mutation.
 */
type Row=Record<string,unknown>;
type Reader=typeof shopifyGraphQL;
type Data={order?:Row|null};
const ORDER_RE=/^gid:\/\/shopify\/Order\/\d+$/;
const FULFILLMENT_RE=/^gid:\/\/shopify\/Fulfillment\/\d+$/;
const LINE_RE=/^gid:\/\/shopify\/LineItem\/\d+$/;
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
  "   id status displayStatus trackingInfo(first:10){company}",
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

export async function readShopifyChannableFulfillmentMetadata(
 input:Row,env:MareBusinessShopifyEnv,
 reader:Reader=shopifyGraphQL
):Promise<Row>{
 if(!input||typeof input!=="object"||Array.isArray(input)||
    Object.keys(input).some(k=>!["provider","shopify_order_gid","external_order_id"].includes(k))||
    !Object.hasOwn(PROVIDERS,str(input.provider))||
    !ORDER_RE.test(str(input.shopify_order_gid)))
  throw new Error("channable_fulfillment_invalid_request");
 const provider=input.provider as keyof typeof PROVIDERS,conf=PROVIDERS[provider];
 if(!conf.pattern.test(str(input.external_order_id)))
  throw new Error("channable_fulfillment_external_id_invalid");
 const gid=String(input.shopify_order_gid);
 const data:Data=await reader<Data>(env,SHOPIFY_CHANNABLE_FULFILLMENT_QUERY,{id:gid});
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
  lines:Array<{line_item_gid:string;sku:string|null;quantity:number}>
 }>=[];
 let trackingEntries=0,totalLineUnits=0;
 const uniqueFulfillments=new Set<string>();
 for(const raw of order.fulfillments){
  const f=obj(raw),fid=str(f.id);
  if(!FULFILLMENT_RE.test(fid)||uniqueFulfillments.has(fid)||
     !str(f.status)||str(f.status).length>60)
   throw new Error("channable_fulfillment_invalid_or_duplicate_shipment");
  uniqueFulfillments.add(fid);
  if(!Array.isArray(f.trackingInfo)||f.trackingInfo.length>=TRACK_CAP)
   throw new Error("channable_fulfillment_tracking_metadata_incomplete");
  const carriers:string[]=[];
  for(const rawTrack of f.trackingInfo){
   const carrier=str(obj(rawTrack).company);
   if(carrier.length>90||/[\u0000-\u001f\u007f]/.test(carrier))
    throw new Error("channable_fulfillment_carrier_invalid");
   carriers.push(carrier||"UNVERIFIED");
   trackingEntries++;
  }
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
    tracking_entry_count:carriers.length,lines
  });
 }
 const status=str(order.displayFulfillmentStatus);
 if(!status||status.length>90)
  throw new Error("channable_fulfillment_order_status_invalid");
 return {
  ok:true,source:"shopify_channable_marketplace_fulfillment_metadata",
  provider,shopify_order_gid:gid,external_order_id:input.external_order_id,
  order_display_fulfillment_status:status,shipment_count:shipments.length,
  tracking_info_entries:trackingEntries,fulfillment_line_units:totalLineUnits,
  shipments,metadata_complete_bounded:true,read_only:true,
  tracking_numbers_or_urls_requested:false,
  carrier_presence_not_marketplace_confirmation:true,
  can_confirm_marketplace_shipment:false,can_change_shopify_fulfillment:false,
  can_release_stock_reservation:false
 };
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
    b.ok!==true||b.source!=="shopify_channable_marketplace_fulfillment_metadata"||
    b.provider!=="amazon"||b.metadata_complete_bounded!==true||
    b.read_only!==true||a.shopify_order_gid!==b.shopify_order_gid||
    a.amazon_order_id!==b.external_order_id||
    !Array.isArray(a.lines)||!Array.isArray(b.shipments)||
    a.lines.length>200||b.shipments.length>=FULFILLMENT_CAP)
   throw new Error("channable_fulfillment_coverage_untrusted_source");
 const expected=new Map<string,number>();
 for(const raw of a.lines){
  const x=obj(raw),id=str(x.line_item_gid),ordered=x.ordered_quantity;
  if(!LINE_RE.test(id)||expected.has(id)||!positive(ordered))
   throw new Error("channable_fulfillment_coverage_invalid_line");
  expected.set(id,ordered);
 }
 if(!expected.size)throw new Error("channable_fulfillment_coverage_empty_order");
 const allowedStatuses=new Set(["SUCCESS","CANCELLED","ERROR","FAILURE","OPEN","PENDING"]);
 const seenShipments=new Set<string>();
 const shipped=new Map<string,number>();
 let excludedShipments=0,pendingShipments=0,successfulShipments=0;
 for(const raw of b.shipments){
  const shipment=obj(raw),fid=str(shipment.fulfillment_gid),status=str(shipment.status);
  if(!FULFILLMENT_RE.test(fid)||seenShipments.has(fid))
   throw new Error("channable_fulfillment_coverage_shipment_identity_conflict");
  if(!allowedStatuses.has(status))
   throw new Error("channable_fulfillment_coverage_unknown_status");
  seenShipments.add(fid);
  const lines=shipment.lines;
  if(!Array.isArray(lines)||lines.length<1||lines.length>LINE_CAP)
   throw new Error("channable_fulfillment_coverage_missing_lines");
  const seenLines=new Set<string>();
  for(const rawLine of lines){
   const x=obj(rawLine),id=str(x.line_item_gid),quantity=x.quantity;
   if(!expected.has(id)||!positive(quantity))
    throw new Error("channable_fulfillment_coverage_unknown_line");
   if(seenLines.has(id))throw new Error("channable_fulfillment_coverage_duplicate_line");
   seenLines.add(id);
   if(status!=="SUCCESS")continue;
   const total=(shipped.get(id)??0)+quantity;
   if(!Number.isSafeInteger(total)||total>expected.get(id)!)
    throw new Error("channable_fulfillment_coverage_overshipped");
   shipped.set(id,total);
  }
  if(status==="SUCCESS")successfulShipments++;
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
 const coverage=pendingShipments>0?"PENDING_FULFILLMENT_REVIEW":
   b.shipments.length===0?"NO_SHIPMENTS":
   totalShipped===0?"NO_SUCCESSFUL_FULFILLMENTS":
   totalShipped===totalExpected?"SHOPIFY_FULFILLMENT_LINES_COMPLETE":"PARTIAL";
 return {
  ok:true,source:"channable_order_fulfillment_shadow_coverage",
  original_line_units:totalExpected,fulfillment_line_units:totalShipped,
  successful_fulfillments:successfulShipments,
  excluded_non_success_fulfillments:excludedShipments,
  pending_fulfillments:pendingShipments,coverage,
  coverage_basis:"SHOPIFY_SUCCESS_ONLY_NOT_CARRIER_HANDOVER",
  read_only:true,amazon_tracking_confirmation_proven:false,
  may_confirm_marketplace_shipment:false,may_release_reservations:false
 };
}
