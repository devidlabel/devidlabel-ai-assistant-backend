import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { MarketplaceCoreLedger, validateOrderSnapshot, type OrderSnapshot } from "./marketplace-core-ledger.js";

/** Read-only provider observations -> local shadow ledger. Never imports an
 * order, adjusts inventory, clears reservations or promotes a polling cursor.
 * The caller authenticates the source and derives seller identity server-side.
 */
type Row = Record<string, unknown>;
const SELLER_RE=/^[A-Z0-9]{8,30}$/;
const LINE_KEYS=["line_id","seller_sku","asin","quantity_ordered","quantity_fulfilled","mapping_status"];
const ORDER_KEYS=[
  "account_id","order_id","order_key","created_at","last_updated_at",
  "marketplace_id","fulfillment_owner","fulfillment_status","line_count",
  "items","order_import_authorized","needs_enrichment","contains_customer_data"
];
const TIME_RE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
function object(value:unknown):Row{
  return value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Row:{};
}
function onlyKeys(value:Row, keys:string[]):boolean{
  return Object.keys(value).every(x=>keys.includes(x));
}
function exactString(value:unknown,max=200):string {
  return typeof value==="string"&&value.length>0&&value.length<=max&&
    !/[\u0000-\u001f\u007f]/.test(value)?value:"";
}
function safeQty(value:unknown):value is number {
  return typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
}
function timestamp(value:unknown):number {
  if(typeof value!=="string"||!TIME_RE.test(value)||!Number.isFinite(Date.parse(value)))
    throw new Error("amazon_order_stage_invalid_time");
  return Date.parse(value);
}
export type PreparedAmazonObservation={snapshot:OrderSnapshot;needsReview:boolean};

/** Validate the entire batch with the SAME validator used by the ledger,
 * before any local transaction. No duplicate normalizer or staging-package code.
 */
export function prepareAmazonOrderObservations(
  resultRaw:unknown,configuredSellerId:string
):PreparedAmazonObservation[]{
  const result=object(resultRaw);
  if (!SELLER_RE.test(configuredSellerId)||
      result.ok!==true||result.read_only!==true||
      result.source!=="amazon_spapi_orders_2026_01_01"||
      result.account_id!==configuredSellerId||
      result.identity_scope!=="SELLER_ACCOUNT_PLUS_ORDER_ID"||
      result.fulfilled_by!=="MERCHANT"||
      result.complete_pagination!==true||result.importer_enabled!==false||
      result.can_advance_checkpoint!==false||
      result.customer_personal_data_requested!==false||
      !Array.isArray(result.orders)||
      !Number.isSafeInteger(result.order_count)||
      result.order_count!==result.orders.length||
      !Number.isSafeInteger(result.pages_read)||Number(result.pages_read)<1||
      Number(result.pages_read)>5||
      !Array.isArray(result.selected_marketplaces)||
      result.selected_marketplaces.length<1||result.selected_marketplaces.length>4)
    throw new Error("amazon_order_stage_invalid_source");
  const since=timestamp(result.last_updated_after),until=timestamp(result.last_updated_before);
  if(since>=until)throw new Error("amazon_order_stage_invalid_window");
  const allowed=new Set<string>();
  for(const market of result.selected_marketplaces){
    if (typeof market!=="string"||!Object.hasOwn(AMAZON_EU_MARKETPLACES,market))
      throw new Error("amazon_order_stage_invalid_marketplace");
    const id=AMAZON_EU_MARKETPLACES[market as keyof typeof AMAZON_EU_MARKETPLACES];
    if(allowed.has(id))throw new Error("amazon_order_stage_duplicate_marketplace");
    allowed.add(id);
  }
  const normalized:PreparedAmazonObservation[]=[];
  const ids=new Set<string>();
  for(const raw of result.orders){
    const order=object(raw),items=order.items;
    const orderId=exactString(order.order_id,128);
    const orderKey=exactString(order.order_key,330);
    if(!onlyKeys(order,ORDER_KEYS)||!orderId||ids.has(orderId)||
       order.account_id!==configuredSellerId||
       orderKey!=="amazon:"+configuredSellerId+":"+orderId||
       !allowed.has(String(order.marketplace_id))||
       order.order_import_authorized!==false||order.contains_customer_data!==false||
       typeof order.needs_enrichment!=="boolean"||
       !Array.isArray(items)||items.length<1||items.length>200||
       order.line_count!==items.length||
       (order.fulfillment_owner!=="MERCHANT"&&order.fulfillment_owner!=="UNVERIFIED")||
       (order.fulfillment_status!==null&&!exactString(order.fulfillment_status,40)))
      throw new Error("amazon_order_stage_invalid_order");
    const created=timestamp(order.created_at),updated=timestamp(order.last_updated_at);
    if(created>updated||updated<since||updated>until)
      throw new Error("amazon_order_stage_invalid_chronology");
    ids.add(orderId);
    const lines:OrderSnapshot["items"]=[];
    const lineIds=new Set<string>();
    for (const rawLine of items) {
      const line=object(rawLine),lineId=exactString(line.line_id,128);
      const sku=line.seller_sku===null?null:exactString(line.seller_sku,200);
      if (!onlyKeys(line,LINE_KEYS)||!lineId||lineIds.has(lineId)||
          (line.seller_sku!==null&&!sku)||
          !safeQty(line.quantity_ordered)||
          (line.quantity_fulfilled!==null&&
           (!safeQty(line.quantity_fulfilled)||line.quantity_fulfilled>line.quantity_ordered))||
          !["UNRESOLVED_VARIANT","MISSING_SELLER_SKU"].includes(String(line.mapping_status))||
          (sku===null)!==(line.mapping_status==="MISSING_SELLER_SKU"))
        throw new Error("amazon_order_stage_invalid_line");
      lineIds.add(lineId);
      lines.push({line_id:lineId,seller_sku:sku,
        quantity_ordered:line.quantity_ordered,quantity_fulfilled:line.quantity_fulfilled});
    }
    // Numeric zero is retained, not interpreted as a cancellation or a restock.
    const snapshot=validateOrderSnapshot({
      provider:"amazon",account:configuredSellerId,order_id:orderId,
      marketplace_id:String(order.marketplace_id),
      source_updated_at:order.last_updated_at as string,
      fulfillment_owner:order.fulfillment_owner as "MERCHANT"|"UNVERIFIED",
      fulfillment_status:order.fulfillment_status as string|null,items:lines
    });
    normalized.push({snapshot,needsReview:order.needs_enrichment===true||
      lines.some(x=>x.seller_sku===null||x.quantity_ordered===0)||
      order.fulfillment_owner!=="MERCHANT"||order.fulfillment_status==="CANCELLED"});
  }
  return normalized;
}

/** Per-order transactions. If interrupted, replay is safe but no scan
 * checkpoint is acknowledged here, including empty or fully duplicate scans.
 */
export async function stageAmazonOrdersReadOnly(
  resultRaw:unknown,
  ledger:Pick<MarketplaceCoreLedger,"observeMarketplaceOrder">,
  configuredSellerId:string
):Promise<Row>{
  const normalized=prepareAmazonOrderObservations(resultRaw,configuredSellerId);
  let recorded=0,duplicate=0,stale=0,review=0;
  for(const {snapshot,needsReview} of normalized){
    const outcome=await ledger.observeMarketplaceOrder(snapshot);
    if(outcome.status==="RECORDED")recorded++;
    else if(outcome.status==="DUPLICATE")duplicate++;
    else if(outcome.status==="STALE")stale++;
    else throw new Error("amazon_order_stage_unverified_ledger_outcome");
    if(needsReview)review++;
  }
  return {
    ok:true,source:"mare_order_shadow_intake",
    scanned:normalized.length,recorded,duplicate,stale,needs_review:review,
    import_state:"SHADOW_ONLY",shopify_adoption_reconciliation_required:true,
    channable_order_import_ownership_not_proven:true,
    no_import_or_inventory_mutation:true,stock_reservations_not_released:true,
    can_advance_checkpoint:false,provider_write_calls:0,
    next_step:"PERSIST_SCAN_CURSOR_ONLY_AFTER_SEPARATE_PROVIDER_AND_LEDGER_COMPLETENESS_PROOF"
  };
}
