import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";

/**
 * R2.0 Orders API v2026-01-01 merchant-fulfilled observation only.
 *
 * No customer name/address, payments, Shopify mutations or provider writes.
 * A complete page scan is NOT order-import authorization, inventory proof,
 * or evidence that Channable has stopped importing an order.
 *
 * The selected marketplace IDs are filters, NOT order identity dimensions:
 * Amazon seller-account + orderId is the stable deduplication identity.
 */
type Row = Record<string, unknown>;
type Env = AmazonCredentials & { AMAZON_SP_API_SELLER_ID?: string };
type Market = keyof typeof AMAZON_EU_MARKETPLACES;
const HOST = "https://sellingpartnerapi-eu.amazon.com";
const ENDPOINT = "/orders/2026-01-01/orders";
const SELLER_RE = /^[A-Z0-9]{8,30}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_PAGES = 5;
const PAGE_SIZE = 100;
const MAX_RESPONSE_BYTES = 4_000_000;
const MAX_WINDOW_MS = 7 * 24 * 60 * 60_000;
const MIN_SAFETY_DELAY_MS = 3 * 60_000;

function dict(value:unknown):Row {
  return value!==null&&typeof value==="object"&&!Array.isArray(value)
    ? value as Row : {};
}
function id(value:unknown,max=200):string {
  return typeof value==="string" && value.length>0 && value.length<=max &&
    !/[\u0000-\u001f\u007f]/.test(value) ? value : "";
}
function iso(value:unknown):string {
  if (typeof value!=="string"||!ISO_RE.test(value)||!Number.isFinite(Date.parse(value)))
    throw new Error("amazon_orders_invalid_time");
  return value;
}
function qty(value:unknown):number|null {
  return typeof value==="number"&&Number.isSafeInteger(value)&&value>=0
    ? value : null;
}

/** Fixed diagnostic codes only: never include a raw field, ID, SKU or error body.
 * The accepted inputs remain exactly the same as the original line guard.
 * Missing sellerSku is deliberately NOT part of this guard.
 */
export function amazonOrderLineGuardReason(raw:unknown, seen:ReadonlySet<string>):string|null {
  if(raw===null||typeof raw!=="object"||Array.isArray(raw)) return "line_not_object";
  const item=raw as Row;
  if(item.orderItemId===undefined) return "line_id_missing";
  if(item.orderItemId===null) return "line_id_null";
  if(typeof item.orderItemId!=="string") return "line_id_type";
  if(!id(item.orderItemId,128)) return "line_id_format";
  if(seen.has(item.orderItemId)) return "duplicate_line_id";
  const value=item.quantityOrdered;
  if(value===undefined) return "quantity_missing";
  if(value===null) return "quantity_null";
  if(typeof value!=="number") {
    if(typeof value==="string") return "quantity_type_string";
    if(typeof value==="boolean") return "quantity_type_boolean";
    return "quantity_type_other";
  }
  if(!Number.isFinite(value)) return "quantity_nonfinite";
  if(!Number.isInteger(value)) return "quantity_noninteger";
  if(!Number.isSafeInteger(value)) return "quantity_unsafe_integer";
  if(value<0) return "quantity_negative";
  if(value===0) return "quantity_zero";
  return null;
}

function normalizeOrder(raw:unknown, sellerId:string, allowed:Set<string>):Row {
  const order=dict(raw);
  const orderId=id(order.orderId,128);
  const created=iso(order.createdTime);
  const updated=iso(order.lastUpdatedTime);
  const sales=dict(order.salesChannel);
  const marketplace=id(sales.marketplaceId,60);
  if (!orderId||!marketplace||!allowed.has(marketplace)||
      sales.channelName!=="AMAZON"||Date.parse(updated)<Date.parse(created)||
      !Array.isArray(order.orderItems))
    throw new Error("amazon_orders_invalid_order_identity");
  const fulfillment=dict(order.fulfillment);
  if (fulfillment.fulfilledBy && fulfillment.fulfilledBy!=="MERCHANT")
    throw new Error("amazon_orders_wrong_fulfillment_route");
  const items:Row[]=[];
  const unique=new Set<string>();
  for (const rawItem of order.orderItems) {
    const reason=amazonOrderLineGuardReason(rawItem,unique);
    if(reason!==null) throw new Error("amazon_orders_invalid_line:"+reason);
    const item=dict(rawItem);
    const lineId=id(item.orderItemId,128);
    const ordered=qty(item.quantityOrdered)!;
    unique.add(lineId);
    const product=dict(item.product);
    const sku=id(product.sellerSku,200) || null; // opaque, never trim/normalize
    const asin=id(product.asin,10) || null;
    if (asin && !/^[A-Z0-9]{10}$/.test(asin))
      throw new Error("amazon_orders_invalid_asin");
    const itemFulfillment=dict(item.fulfillment);
    const fulfilled=itemFulfillment.quantityFulfilled===undefined?null:
      qty(itemFulfillment.quantityFulfilled);
    if (itemFulfillment.quantityFulfilled!==undefined &&
        (fulfilled===null||fulfilled>ordered))
      throw new Error("amazon_orders_invalid_fulfilled_qty");
    items.push({
      line_id:lineId, seller_sku:sku, asin,
      quantity_ordered:ordered,quantity_fulfilled:fulfilled,
      mapping_status:sku?"UNRESOLVED_VARIANT":"MISSING_SELLER_SKU"
    });
  }
  items.sort((a,b)=>String(a.line_id).localeCompare(String(b.line_id),"en"));
  const fulfillmentStatus=id(fulfillment.fulfillmentStatus,40)||null;
  return {
    account_id:sellerId,
    order_id:orderId,
    order_key:"amazon:"+sellerId+":"+orderId,
    created_at:created,last_updated_at:updated,marketplace_id:marketplace,
    fulfillment_owner:fulfillment.fulfilledBy==="MERCHANT"?"MERCHANT":"UNVERIFIED",
    fulfillment_status:fulfillmentStatus,
    line_count:items.length,items,
    order_import_authorized:false,
    needs_enrichment:items.length===0||items.some(item=>item.seller_sku===null)||
      fulfillmentStatus===null,
    contains_customer_data:false
  };
}

/** Only searchOrders. Requires an overlap window supplied by a future durable
 * cursor coordinator. Never promotes a cursor itself. Pagination must complete.
 */
export async function readAmazonOrdersPilot(
  input: Row,
  env: Env,
  clock:()=>number=Date.now
):Promise<Row> {
  const marketplaces=input.marketplaces;
  if (!Array.isArray(marketplaces)||marketplaces.length===0||marketplaces.length>4||
      marketplaces.some(m=>typeof m!=="string"||!Object.hasOwn(AMAZON_EU_MARKETPLACES,m))||
      new Set(marketplaces).size!==marketplaces.length ||
      Object.keys(input).some(k=>!["marketplaces","last_updated_after","last_updated_before","max_pages"].includes(k)))
    throw new Error("amazon_orders_invalid_request");
  const after=iso(input.last_updated_after), before=iso(input.last_updated_before);
  const since=Date.parse(after),until=Date.parse(before),now=clock();
  if (!Number.isFinite(now)||!Number.isSafeInteger(now)||
      since>=until||until>now-MIN_SAFETY_DELAY_MS||until-since>MAX_WINDOW_MS)
    throw new Error("amazon_orders_invalid_window");
  const maxPages=input.max_pages===undefined?MAX_PAGES:input.max_pages;
  if (typeof maxPages!=="number"||!Number.isSafeInteger(maxPages)||
      maxPages<1||maxPages>MAX_PAGES)
    throw new Error("amazon_orders_invalid_pages");
  const sellerId=env.AMAZON_SP_API_SELLER_ID;
  if (typeof sellerId!=="string"||!SELLER_RE.test(sellerId))
    throw new Error("amazon_orders_seller_not_configured");
  const marketIds=(marketplaces as Market[]).map(m=>AMAZON_EU_MARKETPLACES[m]);
  const allowed=new Set<string>(marketIds);
  const token=await getAmazonAccessToken(env);
  const url=new URL(HOST+ENDPOINT);
  url.searchParams.set("lastUpdatedAfter",after);
  url.searchParams.set("lastUpdatedBefore",before);
  url.searchParams.set("marketplaceIds",marketIds.join(","));
  url.searchParams.set("fulfilledBy","MERCHANT");
  url.searchParams.set("includedData","FULFILLMENT");
  url.searchParams.set("maxResultsPerPage",String(PAGE_SIZE));
  let pages=0, next:string|null=null;
  const seenTokens=new Set<string>();
  const orders=new Map<string,Row>();
  while (true) {
    if (pages>=maxPages)throw new Error("amazon_orders_scan_incomplete_max_pages");
    if (next)url.searchParams.set("paginationToken",next);
    let response:Response;
    try {
      response=await fetch(url.toString(),{
        method:"GET",headers:{"x-amz-access-token":token,Accept:"application/json"},
        signal:AbortSignal.timeout(20000),redirect:"manual"
      });
    } catch(error) {
      const kind=error instanceof Error?error.name:"Unknown";
      throw new Error(kind==="TimeoutError"||kind==="AbortError"?
        "amazon_orders_transport_timeout":kind==="TypeError"?
        "amazon_orders_transport_type_error":"amazon_orders_transport_other");
    }
    if (!response.ok)throw new Error("amazon_orders_http_"+response.status);
    const text=await response.text();
    if (new TextEncoder().encode(text).length>MAX_RESPONSE_BYTES)
      throw new Error("amazon_orders_page_too_large");
    let parsed:unknown;
    try {parsed=JSON.parse(text);}catch{throw new Error("amazon_orders_invalid_json");}
    const page=dict(parsed);
    if (!Array.isArray(page.orders)||page.orders.length>PAGE_SIZE)
      throw new Error("amazon_orders_invalid_page");
    for (const rawOrder of page.orders){
      const item=normalizeOrder(rawOrder,sellerId,allowed);
      if (Date.parse(String(item.last_updated_at))<since ||
          Date.parse(String(item.last_updated_at))>until)
        throw new Error("amazon_orders_out_of_window");
      const key=String(item.order_key);
      if (orders.has(key)) {
        if (JSON.stringify(orders.get(key))!==JSON.stringify(item))
          throw new Error("amazon_orders_inconsistent_duplicate");
      } else {
        orders.set(key,item);
      }
    }
    pages++;
    const pagination=dict(page.pagination);
    if (page.pagination!==undefined && page.pagination!==null &&
        (typeof page.pagination!=="object" || Array.isArray(page.pagination)))
      throw new Error("amazon_orders_invalid_pagination");
    const nextRaw=pagination.nextToken;
    if (nextRaw===undefined || nextRaw===null) break;
    if (typeof nextRaw!=="string"||nextRaw.length===0||nextRaw.length>8192||
        seenTokens.has(nextRaw))
      throw new Error("amazon_orders_invalid_pagination");
    seenTokens.add(nextRaw);
    next=nextRaw;
  }
  return {
    ok:true,read_only:true,source:"amazon_spapi_orders_2026_01_01",
    account_id:sellerId,identity_scope:"SELLER_ACCOUNT_PLUS_ORDER_ID",
    selected_marketplaces:marketplaces,fulfilled_by:"MERCHANT",
    last_updated_after:after,last_updated_before:before,
    pages_read:pages,order_count:orders.size,complete_pagination:true,
    orders:[...orders.values()],
    customer_personal_data_requested:false,
    importer_enabled:false,tracking_enabled:false,quantity_mutations_enabled:false,
    can_advance_checkpoint:false,
    remaining_gates:[
      "authenticated_permissions_probe",
      "durable_cursor_with_overlap_and_watermark",
      "single_order_importer_and_channable_adoption",
      "complete_merchant_order_financial_tax_address_data_under_approved_roles",
      "shopify_inventory_reflection_and_reservations",
      "shipments_and_tracking_reconciliation"
    ]
  };
}
