import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { MarketplaceCoreLedger } from "./marketplace-core-ledger.js";

/**
 * R2.1 read-only order observer: accepts the normalized output from the
 * in-process Amazon Orders API reader, then durably records each entire order.
 *
 * NOT an order importer, Shopify inventory adjuster, provider dispatcher or
 * ownership handoff. Does not advance a polling cursor or clear reservations.
 * The caller MUST verify server-side seller identity and authenticate source.
 */
type Row = Record<string, unknown>;
const SELLER_RE=/^[A-Z0-9]{8,30}$/;
const LINE_KEYS=["line_id","seller_sku","asin","quantity_ordered","quantity_fulfilled","mapping_status"];
const ORDER_KEYS=[
  "account_id","order_id","order_key","created_at","last_updated_at",
  "marketplace_id","fulfillment_owner","fulfillment_status","line_count",
  "items","order_import_authorized","needs_enrichment","contains_customer_data"
];
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

/** Results are deliberately SHADOW_ONLY. The ledger transaction boundary is
 * per order. A mid-page failure must NOT promote the cursor: rerunning the same
 * page is safe because every order version is idempotent.
 */
export async function stageAmazonOrdersReadOnly(
  resultRaw:unknown,
  ledger:Pick<MarketplaceCoreLedger,"observeMarketplaceOrder">,
  configuredSellerId:string
):Promise<Row>{
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
  const allowed=new Set<string>();
  for(const market of result.selected_marketplaces){
    if (typeof market!=="string"||
        !Object.hasOwn(AMAZON_EU_MARKETPLACES,market))
      throw new Error("amazon_order_stage_invalid_marketplace");
    const id=AMAZON_EU_MARKETPLACES[market as keyof typeof AMAZON_EU_MARKETPLACES];
    if(allowed.has(id))throw new Error("amazon_order_stage_duplicate_marketplace");
    allowed.add(id);
  }

  // Prevalidate the ENTIRE result before making the first local durable write.
  const normalized:Array<{
    provider:"amazon";account:string;order_id:string;marketplace_id:string;
    source_updated_at:string;fulfillment_status:string|null;
    fulfillment_owner:"MERCHANT"|"UNVERIFIED";
    items:Array<{line_id:string;seller_sku:string|null;
      quantity_ordered:number;quantity_fulfilled:number|null}>;
    needsReview:boolean
  }>=[];
  const ids=new Set<string>();
  for(const raw of result.orders){
    const order=object(raw), items=order.items;
    const orderId=exactString(order.order_id,128);
    const orderKey=exactString(order.order_key,330);
    if(!onlyKeys(order,ORDER_KEYS)||!orderId||ids.has(orderId)||
       order.account_id!==configuredSellerId||
       orderKey!=="amazon:"+configuredSellerId+":"+orderId||
       !allowed.has(String(order.marketplace_id))||
       order.order_import_authorized!==false||
       order.contains_customer_data!==false||
       !Array.isArray(items)||items.length<1||items.length>200||
       order.line_count!==items.length||
       (order.fulfillment_owner!=="MERCHANT"&&order.fulfillment_owner!=="UNVERIFIED")||
       (order.fulfillment_status!==null&&!exactString(order.fulfillment_status,40))||
       typeof order.last_updated_at!=="string")
      throw new Error("amazon_order_stage_invalid_order");
    ids.add(orderId);
    const lines:Array<{line_id:string;seller_sku:string|null;
      quantity_ordered:number;quantity_fulfilled:number|null}>=[];
    const lineIds=new Set<string>();
    for (const rawLine of items) {
      const line=object(rawLine);
      const lineId=exactString(line.line_id,128);
      const sku=line.seller_sku===null?null:exactString(line.seller_sku,200);
      if (!onlyKeys(line,LINE_KEYS)||!lineId||lineIds.has(lineId)||
          (sku===null&&line.seller_sku!==null)||
          !safeQty(line.quantity_ordered)||line.quantity_ordered===0||
          (line.quantity_fulfilled!==null&&
           (!safeQty(line.quantity_fulfilled)||line.quantity_fulfilled>line.quantity_ordered))||
          !["UNRESOLVED_VARIANT","MISSING_SELLER_SKU"].includes(String(line.mapping_status))||
          (sku===null)!==(line.mapping_status==="MISSING_SELLER_SKU"))
        throw new Error("amazon_order_stage_invalid_line");
      lineIds.add(lineId);
      lines.push({
        line_id:lineId,seller_sku:sku,
        quantity_ordered:line.quantity_ordered,
        quantity_fulfilled:line.quantity_fulfilled
      });
    }
    normalized.push({
      provider:"amazon",account:configuredSellerId,order_id:orderId,
      marketplace_id:String(order.marketplace_id),
      source_updated_at:order.last_updated_at,
      fulfillment_owner:order.fulfillment_owner as "MERCHANT"|"UNVERIFIED",
      fulfillment_status:order.fulfillment_status as string|null,
      items:lines,
      needsReview:order.needs_enrichment===true||
        lines.some(x=>x.seller_sku===null)||
        order.fulfillment_owner!=="MERCHANT"
    });
  }

  let recorded=0,duplicate=0,stale=0,review=0;
  for(const order of normalized){
    // Never pass an untrusted remote body directly to durable storage. The
    // observation's only fields are the validated SKU-less sensitive metadata.
    const {needsReview,...safe}=order;
    const outcome=await ledger.observeMarketplaceOrder(safe);
    if(outcome.status==="RECORDED")recorded++;
    else if(outcome.status==="DUPLICATE")duplicate++;
    else stale++;
    if(needsReview)review++;
  }
  return {
    ok:true,source:"mare_order_shadow_intake",
    scanned:normalized.length,recorded,duplicate,stale,needs_review:review,
    import_state:"SHADOW_ONLY",
    shopify_adoption_reconciliation_required:true,
    channable_order_import_ownership_not_proven:true,
    no_import_or_inventory_mutation:true,
    stock_reservations_not_released:true,
    can_advance_checkpoint:false,
    provider_write_calls:0,
    next_step:"PERSIST_SCAN_CURSOR_ONLY_AFTER_SEPARATE_PROVIDER_AND_LEDGER_COMPLETENESS_PROOF"
  };
}
