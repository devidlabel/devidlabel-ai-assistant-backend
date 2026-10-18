/**
 * R2.3 deterministic Amazon -> Shopify Channable order reconciliation.
 *
 * Pure and read-only: a positive custom attribute reference is evidence that
 * the order has been imported already. A negative lookup is NEVER proof that
 * Shopify orderCreate is safe (Shopify windows and Amazon updated-at windows
 * differ, and the incumbent Channable importer may still be running).
 */
type Row=Record<string,unknown>;
const ORDER_ID_RE=/^\d{3}-\d{7}-\d{7}$/;
const SHOPIFY_GID_RE=/^gid:\/\/shopify\/Order\/\d+$/;
const ACCOUNT_RE=/^[A-Z0-9]{8,30}$/;
function object(value:unknown):Row{
  return value!==null&&typeof value==="object"&&!Array.isArray(value)
    ? value as Row:{};
}
function string(value:unknown):string {
  return typeof value==="string"?value:"";
}
export function reconcileAmazonShopifyOrderAdoption(
  amazonRaw:unknown,shopifyRaw:unknown
):Row {
  const amazon=object(amazonRaw),shopify=object(shopifyRaw);
  if(amazon.ok!==true||amazon.read_only!==true||
      amazon.source!=="amazon_spapi_orders_2026_01_01"||
      amazon.identity_scope!=="SELLER_ACCOUNT_PLUS_ORDER_ID"||
      amazon.complete_pagination!==true||
      amazon.importer_enabled!==false||
      amazon.can_advance_checkpoint!==false||
      shopify.ok!==true||shopify.read_only!==true||
      shopify.source!=="shopify_channable_amazon_order_signature"||
      shopify.pagination_complete!==true||
      shopify.absence_proven!==false||
      shopify.safe_to_create_shopify_order!==false||
      shopify.order_importer_owner!=="CHANNABLE"||
      !Array.isArray(amazon.orders)||!Array.isArray(shopify.found)||
      !Array.isArray(shopify.unverified)||
      !Number.isSafeInteger(amazon.order_count)||
      amazon.order_count!==amazon.orders.length||
      !Number.isSafeInteger(shopify.found_count)||
      shopify.found_count!==shopify.found.length||
      !Number.isSafeInteger(shopify.unverified_count)||
      shopify.unverified_count!==shopify.unverified.length||
      !ACCOUNT_RE.test(string(amazon.account_id)))
    throw new Error("marketplace_adoption_incomplete_or_untrusted_source");

  const indexed=new Map<string,string>();
  const gids=new Set<string>();
  for(const raw of shopify.found){
    const row=object(raw);
    const orderId=string(row.amazon_order_id),gid=string(row.shopify_order_gid);
    if(!ORDER_ID_RE.test(orderId)||!SHOPIFY_GID_RE.test(gid)||
       row.adoption_status!=="FOUND_CHANNABLE"||
       row.source_name!=="amazon"||row.importing_app!=="Channable"||
       indexed.has(orderId)||gids.has(gid))
      throw new Error("marketplace_adoption_shopify_index_conflict");
    indexed.set(orderId,gid);
    gids.add(gid);
  }

  const matched:Array<{
    amazon_order_id:string;shopify_order_gid:string;
    status:"EXISTING_SHOPIFY_REFERENCE_FOUND";requires_line_check:true
  }>=[];
  const unresolved:Array<{
    amazon_order_id:string;
    status:"UNVERIFIED_WINDOW_OR_IMPORT_IN_FLIGHT"
  }>=[];
  const seen=new Set<string>();
  for(const raw of amazon.orders){
    const order=object(raw);
    const orderId=string(order.order_id);
    if(!ORDER_ID_RE.test(orderId)||
       order.account_id!==amazon.account_id||
       order.order_key!=="amazon:"+amazon.account_id+":"+orderId||
       seen.has(orderId))
      throw new Error("marketplace_adoption_amazon_identity_invalid");
    seen.add(orderId);
    const gid=indexed.get(orderId);
    if(gid){
      matched.push({
        amazon_order_id:orderId,shopify_order_gid:gid,
        status:"EXISTING_SHOPIFY_REFERENCE_FOUND",requires_line_check:true
      });
    }else {
      unresolved.push({
        amazon_order_id:orderId,status:"UNVERIFIED_WINDOW_OR_IMPORT_IN_FLIGHT"
      });
    }
  }
  return {
    ok:true,source:"mare_marketplace_shadow_order_reconciliation",
    account_id:amazon.account_id,
    amazon_orders_checked:seen.size,
    positive_existing_reference_count:matched.length,
    unresolved_count:unresolved.length,
    channable_shopify_index_unverified_count:shopify.unverified.length,
    matched,unresolved,
    match_meaning:"SHOPIFY_REFERENCE_PRESENT_BUT_FULL_ORDER_LINE_RECONCILIATION_REQUIRED",
    no_match_meaning:"UNKNOWN_NOT_SAFE_TO_IMPORT",
    importer_ownership:"NOT_TRANSFERRED_FROM_CHANNABLE",
    read_only:true,no_provider_mutations:true,
    allow_shopify_order_create:false,
    can_advance_orders_checkpoint:false,
    can_activate_offer_stock:false,
    required_next_steps:[
      "verify_all_existing_shopify_line_items_inventory_and_external_order_reference",
      "reconcile_pending_channable_imports_and_in_flight_orders",
      "prove_incumbent_importer_handoff_for_the_entire_seller_account",
      "prove_inventory_by_location_and_tracking_ownership_before_live_stock"
    ]
  };
}
