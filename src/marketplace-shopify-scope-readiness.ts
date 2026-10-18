import {shopifyGraphQL, type Env as ShopifyEnv} from "./index.js";

/** Read-only permission evidence for the current M.A.R.E. Shopify app.
 * No token, customer data, mutation or permission expansion is returned.
 */
type Env=ShopifyEnv;
type Row=Record<string,unknown>;
const SHOP_RE=/^[a-z0-9][a-z0-9-]{1,120}\.myshopify\.com$/;
const SCOPE_RE=/^[a-z][a-z0-9_]{1,100}$/;
const INSTALLATION_RE=/^gid:\/\/shopify\/AppInstallation\/\d+$/;
export const SHOPIFY_CURRENT_APP_SCOPES_QUERY=
  "query MareMarketplaceCurrentAppScopes { currentAppInstallation { id accessScopes { handle } } }";

function checkedScopes(values:unknown[]):string[]{
  if(values.length>256||values.some(x=>typeof x!=="string"||!SCOPE_RE.test(x))||
     new Set(values).size!==values.length)
    throw new Error("marketplace_shopify_scope_metadata_invalid");
  return (values as string[]).slice().sort();
}
function scopeReport(scopes:string[]):Row{
  const granted=new Set(scopes);
  // A write scope includes reads of the SAME resource only. Marketplace-only
  // orders do not grant access to orders imported by Channable, and
  // read_all_orders alone is not a substitute for read_orders.
  const hasOrderRead=granted.has("read_orders")||granted.has("write_orders");
  const hasStockRead=granted.has("read_inventory")||granted.has("write_inventory");
  return {
    scope_count:scopes.length,granted_scopes:scopes,
    implied_read_scopes:[
      ...(granted.has("write_orders")&&!granted.has("read_orders")?["read_orders"]:[]),
      ...(granted.has("write_inventory")&&!granted.has("read_inventory")?["read_inventory"]:[])
    ],
    required_scope_gaps:{
      order_read:hasOrderRead?[]:["read_orders"],
      order_create:granted.has("write_orders")?[]:["write_orders"],
      stock_read:hasStockRead?[]:["read_inventory"]
    },
    order_create_scope_present:granted.has("write_orders"),
    inventory_write_scope_present:granted.has("write_inventory"),
    fulfillment_scope_candidates:scopes.filter(x=>
      /^(read|write)_(merchant_managed_fulfillment_orders|assigned_fulfillment_orders|third_party_fulfillment_orders|fulfillments)$/.test(x)),
    fulfillment_workflow_scope_validation_required:true,
    can_import_orders:false,can_update_tracking:false,
    can_change_inventory:false,can_publish_offers:false
  };
}

/** Cached metadata is diagnostic only. It is no longer used by the current
 * public capability, and is never a fallback when a live scope probe fails.
 */
export async function readMarketplaceShopifyCachedScopes(env:Env):Promise<Row>{
  const shop=typeof env.SHOPIFY_SHOP_DOMAIN==="string"?
    env.SHOPIFY_SHOP_DOMAIN.trim().toLowerCase():"";
  if(!SHOP_RE.test(shop)||!env.SHOPIFY_TOKENS_KV)
    return {ok:false,status:"BLOCKED_CONFIG",read_only:true,
      blocker:"shopify_shop_domain_or_token_store_missing",
      can_import_orders:false,can_update_tracking:false};
  let raw:string|null;
  try{raw=await env.SHOPIFY_TOKENS_KV.get("shopify:offline_token:"+shop);}
  catch{throw new Error("marketplace_shopify_scope_store_unavailable");}
  if(!raw)return {ok:false,status:"BLOCKED_NO_INSTALLATION",read_only:true,
    blocker:"shopify_oauth_offline_installation_not_found",
    can_import_orders:false,can_update_tracking:false};
  let parsed:unknown;
  try{parsed=JSON.parse(raw);}catch{throw new Error("marketplace_shopify_scope_metadata_invalid");}
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))
    throw new Error("marketplace_shopify_scope_metadata_invalid");
  const value=parsed as Row;
  if(value.shop!==shop||typeof value.scope!=="string"||value.scope.length>4000)
    throw new Error("marketplace_shopify_scope_metadata_invalid");
  const scopes=checkedScopes(value.scope.split(",").map(x=>x.trim()).filter(Boolean));
  return {
    ok:true,source:"shopify_oauth_kv_scope_metadata",scope_authority:"CACHED_NOT_LIVE",
    live_scope_observation:false,read_only:true,customer_data_returned:false,
    credential_returned:false,
    installed_at:typeof value.created_at==="string"?value.created_at:null,
    ...scopeReport(scopes),status:"CACHED_SCOPES_NOT_LIVE_PROOF",
    next_step:"READ_CURRENT_APP_INSTALLATION_WITH_THE_SAME_MARE_TOKEN"
  };
}

/** The existing capability now calls Shopify with its own GraphQL client.
 * No separate connector/app is consulted. Provider errors never fall back to
 * cached claims. A granted scope is evidence, not an execution approval.
 */
export async function readMarketplaceShopifyPermissionReadiness(
  env:Env,reader:typeof shopifyGraphQL=shopifyGraphQL
):Promise<Row>{
  const shop=typeof env.SHOPIFY_SHOP_DOMAIN==="string"?
    env.SHOPIFY_SHOP_DOMAIN.trim().toLowerCase():"";
  if(!SHOP_RE.test(shop))throw new Error("marketplace_shopify_scope_live_config_invalid");
  let data:{currentAppInstallation?:unknown};
  try{
    data=await reader<{currentAppInstallation?:unknown}>(env,SHOPIFY_CURRENT_APP_SCOPES_QUERY,{});
  }catch{
    throw new Error("marketplace_shopify_scope_live_probe_failed");
  }
  const raw=data?.currentAppInstallation;
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw new Error("marketplace_shopify_scope_live_response_invalid");
  const installation=raw as Row;
  if(typeof installation.id!=="string"||!INSTALLATION_RE.test(installation.id)||
     !Array.isArray(installation.accessScopes))
    throw new Error("marketplace_shopify_scope_live_response_invalid");
  const scopes=checkedScopes(installation.accessScopes.map(x=>
    x&&typeof x==="object"&&!Array.isArray(x)?(x as Row).handle:null));
  return {
    ok:true,source:"shopify_current_app_installation",
    scope_authority:"LIVE_CURRENT_AUTHENTICATED_APP",live_scope_observation:true,
    observed_at:new Date().toISOString(),installation_id:installation.id,
    read_only:true,customer_data_returned:false,credential_returned:false,
    ...scopeReport(scopes),status:"LIVE_SCOPES_OBSERVED_EXECUTION_STILL_LOCKED",
    next_step:"VERIFY_WORKFLOW_OWNERSHIP_AND_END_TO_END_EFFECTS_BEFORE_ANY_WRITE"
  };
}
