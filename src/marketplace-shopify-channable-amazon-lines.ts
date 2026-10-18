import {shopifyGraphQL} from "./index.js";
import type {MareBusinessShopifyEnv} from "./mare-business-shopify.js";

/**
 * Privacy-minimal readback of an Amazon order already imported by Channable.
 * No buyer/recipient/payment data. No Shopify mutation or import authorization.
 */
type Row=Record<string,unknown>;
type Reader=typeof shopifyGraphQL;
type Connection={pageInfo?:{hasNextPage?:boolean;endCursor?:string|null};nodes?:unknown[]};
type Data={order?:Row|null};
const SHOPIFY_ORDER_RE=/^gid:\/\/shopify\/Order\/\d+$/;
const LINE_RE=/^gid:\/\/shopify\/LineItem\/\d+$/;
const VARIANT_RE=/^gid:\/\/shopify\/ProductVariant\/\d+$/;
const AMAZON_ORDER_RE=/^\d{3}-\d{7}-\d{7}$/;
const PAGE_SIZE=50;
const MAX_PAGES=5;
const MAX_LINES=200;
export const SHOPIFY_CHANNABLE_ORDER_LINES_QUERY=[
  'query MareChannableImportedAmazonOrder($id: ID!, $after: String) {',
  ' order(id:$id) {',
  '   id sourceName sourceIdentifier app { name }',
  '   customAttributes { key value }',
  '   lineItems(first:50,after:$after) {',
  '     pageInfo { hasNextPage endCursor }',
  '     nodes { id sku quantity currentQuantity variant { id } }',
  '   }',
  ' }',
  '}'
].join("\n");
function object(v:unknown):Row{return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};}
function string(v:unknown):string{return typeof v==="string"?v:"";}
function qty(v:unknown):number|null{return typeof v==="number"&&Number.isSafeInteger(v)&&v>=0?v:null;}

export async function readShopifyChannableAmazonOrderLines(
  input:Row,env:MareBusinessShopifyEnv,
  reader:Reader=shopifyGraphQL
):Promise<Row>{
  if(!input||typeof input!=="object"||Array.isArray(input)||
     Object.keys(input).some(k=>!["shopify_order_gid","amazon_order_id"].includes(k))||
     !SHOPIFY_ORDER_RE.test(string(input.shopify_order_gid))||
     !AMAZON_ORDER_RE.test(string(input.amazon_order_id)))
    throw new Error("shopify_channable_lines_invalid_request");
  const gid=String(input.shopify_order_gid);
  const amazonId=String(input.amazon_order_id);
  const lines:Array<{
    line_item_gid:string;sku:string|null;ordered_quantity:number;
    current_quantity:number;variant_gid:string|null
  }>=[];
  const ids=new Set<string>();
  const seenCursors=new Set<string>();
  let cursor:string|null=null,pages=0;
  while(true){
    if(pages>=MAX_PAGES)throw new Error("shopify_channable_lines_pagination_incomplete");
    const data:Data=await reader<Data>(env,SHOPIFY_CHANNABLE_ORDER_LINES_QUERY,{
      id:gid,after:cursor
    });
    const order=object(data?.order);
    if(order.id!==gid)throw new Error("shopify_channable_lines_order_not_found_or_changed");
    if(order.sourceName!=="amazon"||object(order.app).name!=="Channable")
      throw new Error("shopify_channable_lines_order_not_legacy_amazon");
    if(order.sourceIdentifier&&order.sourceIdentifier!==amazonId)
      throw new Error("shopify_channable_lines_source_identifier_conflict");
    if(!Array.isArray(order.customAttributes))
      throw new Error("shopify_channable_lines_external_identifier_missing");
    const refs=order.customAttributes.map(object).filter(x=>x.key==="Amazon Order ID");
    if(refs.length!==1||refs[0].value!==amazonId)
      throw new Error("shopify_channable_lines_external_identifier_mismatch");
    const connection=object(order.lineItems);
    const rows=connection.nodes;
    const info=object(connection.pageInfo);
    if(!Array.isArray(rows)||rows.length>PAGE_SIZE||
       typeof info.hasNextPage!=="boolean")
      throw new Error("shopify_channable_lines_page_malformed");
    for(const raw of rows){
      const line=object(raw);
      const lineId=string(line.id);
      const ordered=qty(line.quantity);
      const current=qty(line.currentQuantity);
      const rawSku=line.sku;
      const sku=typeof rawSku==="string"&&rawSku.length>0&&rawSku.length<=200&&
        !/[\u0000-\u001f\u007f]/.test(rawSku)?rawSku:null;
      const variant=string(object(line.variant).id);
      if(!LINE_RE.test(lineId)||ids.has(lineId)||
         ordered===null||ordered===0||current===null||current>ordered||
         (rawSku!==null&&rawSku!==undefined&&sku===null)||
         (variant&&!VARIANT_RE.test(variant)))
        throw new Error("shopify_channable_lines_item_invalid_or_duplicate");
      ids.add(lineId);
      lines.push({
        line_item_gid:lineId,sku,ordered_quantity:ordered,
        current_quantity:current,variant_gid:variant||null
      });
      if(lines.length>MAX_LINES)throw new Error("shopify_channable_lines_too_many");
    }
    pages++;
    if(!info.hasNextPage)break;
    const next=info.endCursor;
    if(typeof next!=="string"||!next||next.length>8192||
       next===cursor||seenCursors.has(next))
      throw new Error("shopify_channable_lines_invalid_cursor");
    seenCursors.add(next);cursor=next;
  }
  if(lines.length===0)throw new Error("shopify_channable_lines_empty");
  return {
    ok:true,source:"shopify_channable_amazon_order_lines",
    amazon_order_id:amazonId,shopify_order_gid:gid,
    importer_app:"Channable",source_name:"amazon",
    line_count:lines.length,lines,
    pagination_complete:true,read_only:true,
    all_line_skus_mapped:lines.every(l=>l.sku!==null&&l.variant_gid!==null),
    order_import_already_present:true,
    full_line_comparison_pending:true,
    can_create_order:false,can_adjust_inventory:false,
    can_confirm_shipment:false
  };
}

/**
 * Pure comparison, robust to multiple lines of the same SKU.
 * Does not infer completed stock booking/fulfillment from matching quantities.
 */
export function compareAmazonOrderWithChannableShopifyLines(
  amazonRaw:unknown,shopifyRaw:unknown
):Row {
  const am=object(amazonRaw),sh=object(shopifyRaw);
  if(sh.ok!==true||sh.source!=="shopify_channable_amazon_order_lines"||
     sh.pagination_complete!==true||sh.read_only!==true||
     sh.can_create_order!==false||sh.order_import_already_present!==true||
     !AMAZON_ORDER_RE.test(string(am.order_id))||
     sh.amazon_order_id!==am.order_id||
     !Array.isArray(am.items)||!Array.isArray(sh.lines)||
     am.items.length<1||sh.lines.length<1)
    throw new Error("amazon_shopify_lines_unverified_source");
  const aggregate=(raw:unknown[], skuField:string, qtyField:string)=>{
    const map=new Map<string,number>();
    let unresolved=0;
    for(const rowRaw of raw){
      const row=object(rowRaw),sku=string(row[skuField]),quantity=qty(row[qtyField]);
      if(!sku||quantity===null||quantity===0){
        unresolved++;continue;
      }
      const combined=(map.get(sku)??0)+quantity;
      if(!Number.isSafeInteger(combined))throw new Error("amazon_shopify_lines_invalid_sum");
      map.set(sku,combined);
    }
    return {map,unresolved};
  };
  const external=aggregate(am.items,"seller_sku","quantity_ordered");
  const imported=aggregate(sh.lines,"sku","ordered_quantity");
  let differing=0;
  for(const k of new Set([...external.map.keys(),...imported.map.keys()])){
    if(external.map.get(k)!==imported.map.get(k))differing++;
  }
  const changedCurrentQuantities=sh.lines.some(raw=>{
    const line=object(raw);
    return line.current_quantity!==line.ordered_quantity;
  });
  const matched=differing===0&&external.unresolved===0&&imported.unresolved===0&&
    sh.all_line_skus_mapped===true&&!changedCurrentQuantities;
  return {
    ok:true,amazon_order_id:am.order_id,shopify_order_gid:sh.shopify_order_gid,
    status:matched?"REFERENCE_AND_QUANTITIES_MATCHED_NEEDS_FULFILLMENT_REVIEW":
      "LINE_RECONCILIATION_REQUIRED",
    sku_quantity_mismatch_count:differing,
    shopify_current_quantity_differs_from_original:changedCurrentQuantities,
    amazon_unresolved_lines:external.unresolved,
    shopify_unresolved_lines:imported.unresolved,
    matched_unique_sku_count:matched?external.map.size:0,
    read_only:true,does_not_prove_inventory_reservation:true,
    does_not_prove_shipping_or_tracking:true,
    may_create_shopify_order:false,may_release_reservations:false
  };
}
