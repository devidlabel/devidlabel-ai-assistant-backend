/**
 * Read-only merchant-private Shopify OAuth scope diagnostics.
 * Only scope names and installation metadata are returned. Never return,
 * print, parse for output, or persist an access token or encrypted secret.
 */
type Store={get(key:string):Promise<string|null>};
type Env={
  SHOPIFY_SHOP_DOMAIN?:string;
  SHOPIFY_TOKENS_KV?:Store;
};
const SHOP_RE=/^[a-z0-9][a-z0-9-]{1,120}\.myshopify\.com$/;
const SCOPE_RE=/^[a-z][a-z0-9_]{1,100}$/;
export async function readMarketplaceShopifyPermissionReadiness(env:Env):Promise<Record<string,unknown>>{
  const shop=typeof env.SHOPIFY_SHOP_DOMAIN==="string"
    ? env.SHOPIFY_SHOP_DOMAIN.trim().toLowerCase():"";
  if(!SHOP_RE.test(shop)||!env.SHOPIFY_TOKENS_KV)
    return {ok:false,status:"BLOCKED_CONFIG",read_only:true,
      blocker:"shopify_shop_domain_or_token_store_missing",
      can_import_orders:false,can_update_tracking:false};
  let raw:string|null;
  try {raw=await env.SHOPIFY_TOKENS_KV.get("shopify:offline_token:"+shop);}
  catch{throw new Error("marketplace_shopify_scope_store_unavailable")}
  if(!raw)return {ok:false,status:"BLOCKED_NO_INSTALLATION",
    blocker:"shopify_oauth_offline_installation_not_found",
    read_only:true,can_import_orders:false,can_update_tracking:false};
  let parsed:unknown;
  try{parsed=JSON.parse(raw);}
  catch{throw new Error("marketplace_shopify_scope_metadata_invalid")}
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))
    throw new Error("marketplace_shopify_scope_metadata_invalid");
  const value=parsed as Record<string,unknown>;
  if(value.shop!==shop||typeof value.scope!=="string"||value.scope.length>4000)
    throw new Error("marketplace_shopify_scope_metadata_invalid");
  const scopes=value.scope.split(",").map(s=>s.trim()).filter(Boolean);
  if(scopes.some(s=>!SCOPE_RE.test(s))||new Set(scopes).size!==scopes.length)
    throw new Error("marketplace_shopify_scope_metadata_invalid");
  const granted=new Set(scopes);
  const requiredForOrderRead=["read_orders"];
  const requiredForOrderCreate=["write_orders"];
  const requiredForStockRead=["read_inventory"];
  const gaps={
    order_read:requiredForOrderRead.filter(x=>!granted.has(x)),
    order_create:requiredForOrderCreate.filter(x=>!granted.has(x)),
    stock_read:requiredForStockRead.filter(x=>!granted.has(x))
  };
  const fulfillmentScopes=Array.from(granted).filter(x=>
    /^(read|write)_(merchant_managed_fulfillment_orders|assigned_fulfillment_orders|third_party_fulfillment_orders|fulfillments)$/.test(x));
  return {
    ok:true,source:"shopify_oauth_kv_scope_metadata",
    read_only:true,customer_data_returned:false,credential_returned:false,
    installed_at:typeof value.created_at==="string"?value.created_at:null,
    scope_count:scopes.length,
    granted_scopes:scopes.sort(),
    required_scope_gaps:gaps,
    order_create_scope_present:gaps.order_create.length===0,
    fulfillment_scope_candidates:fulfillmentScopes,
    fulfillment_workflow_scope_validation_required:true,
    inventory_write_scope_present:granted.has("write_inventory"),
    can_import_orders:false,can_update_tracking:false,
    status:"SCOPES_OBSERVED_BUT_LIVE_IMPORT_LOCKED",
    next_step:"VERIFY_OAUTH_APP_CONFIGURATION_AND_ORDER_FULFILLMENT_WORKFLOW_BEFORE_EXPANDING_SCOPES"
  };
}
