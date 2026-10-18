import { shopifyGraphQL } from "./index.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/**
 * R2.2: merchant-private, READ-ONLY adoption evidence for orders created by
 * Channable in Shopify. Based on the live DevidLabel order signature:
 *   sourceName = "amazon", app.name = "Channable",
 *   customAttributes[{key:"Amazon Order ID"}].value = nnn-nnnnnnn-nnnnnnn.
 *
 * Shopify sourceIdentifier may be null even for valid imported orders.
 * Search window is never absence proof: NEVER permit Shopify orderCreate from
 * a "not found" observation, even if every page in the window was read.
 */
type Row = Record<string,unknown>;
type Connection = {nodes?:unknown[];pageInfo?:{hasNextPage?:boolean;endCursor?:string|null}};
type ShopifyOrderData = {orders?:Connection};
type ShopifyReader=typeof shopifyGraphQL;
const ORDER_ID_RE=/^\d{3}-\d{7}-\d{7}$/;
const GID_RE=/^gid:\/\/shopify\/Order\/\d+$/;
const ISO_RE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_PAGES=10;
const PAGE_SIZE=50;
const MAX_WINDOW_MS=14*24*60*60*1000;
// Shopify search interprets some date boundaries in shop timezone, not UTC.
// Add a conservative 24h margin; the local UTC check below is authoritative.
const SEARCH_BOUNDARY_PAD_MS=24*60*60*1000;
const SOURCE_QUERY=[
  'query MareChannableAmazonOrderIndex($first: Int!, $after: String, $query: String!) {',
  '  orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: false) {',
  '    pageInfo { hasNextPage endCursor }',
  '    nodes { id createdAt sourceName sourceIdentifier app { name }',
  '      customAttributes { key value } }',
  '  }',
  '}'
].join("\n");
export const SHOPIFY_CHANNABLE_AMAZON_ORDER_QUERY=SOURCE_QUERY;

function object(v:unknown):Row {
  return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};
}
function iso(raw:unknown):string {
  if(typeof raw!=="string"||!ISO_RE.test(raw)||!Number.isFinite(Date.parse(raw)))
    throw new Error("shopify_adoption_invalid_timestamp");
  return new Date(raw).toISOString();
}
/**
 * Shopify's search parser accepts timestamp seconds (e.g. 2026-10-11T00:00:00Z)
 * but can silently interpret millisecond timestamps such as .000Z as a
 * different boundary. Normalize for SEARCH ONLY; compare returned createdAt
 * against the precise original milliseconds to prevent false window claims.
 * Floor start/ceil end means boundary items cannot be accidentally excluded.
 */
function shopifySearchSecond(timestampMs:number,round:"floor"|"ceil"):string {
  const seconds=round==="floor"
    ?Math.floor(timestampMs/1000):Math.ceil(timestampMs/1000);
  return new Date(seconds*1000).toISOString().replace(/\.000Z$/,"Z");
}
function value(v:unknown):string {
  return typeof v==="string"?v:"";
}
type Imported = {
  amazon_order_id:string;shopify_order_gid:string;
  source_name:"amazon";importing_app:"Channable";
  shopify_created_at:string;adoption_status:"FOUND_CHANNABLE";
};
type Unverified = {shopify_order_gid:string;reason:string};
export async function readShopifyChannableAmazonAdoptionIndex(
  input:Row,env:MareBusinessShopifyEnv,
  reader:ShopifyReader=shopifyGraphQL
):Promise<Row>{
  if(!input||typeof input!=="object"||Array.isArray(input)||
    Object.keys(input).some(k=>!["created_after","created_before","max_pages"].includes(k)))
    throw new Error("shopify_adoption_invalid_request");
  const after=iso(input.created_after);
  const before=iso(input.created_before);
  const since=Date.parse(after),until=Date.parse(before);
  if(since>=until||until-since>MAX_WINDOW_MS)
    throw new Error("shopify_adoption_invalid_window");
  const maxPages=input.max_pages===undefined?MAX_PAGES:input.max_pages;
  if(typeof maxPages!=="number"||!Number.isSafeInteger(maxPages)||
    maxPages<1||maxPages>MAX_PAGES)
    throw new Error("shopify_adoption_invalid_pages");
  // Shopify source_name is a performance filter; not evidence that orders
  // outside this source or date window do not exist.
  const filter="source_name:amazon created_at:>="+shopifySearchSecond(since-SEARCH_BOUNDARY_PAD_MS,"floor")+
    " created_at:<="+shopifySearchSecond(until+SEARCH_BOUNDARY_PAD_MS,"ceil");
  const found=new Map<string,Imported>();
  const gidToExternal=new Map<string,string>();
  const unverified:Unverified[]=[];
  let cursor:string|null=null;
  const seenCursors=new Set<string>();
  let pages=0,scanned=0,ignoredOutsideWindow=0;
  while(true){
    if(pages>=maxPages)throw new Error("shopify_adoption_incomplete_pagination");
    const response:ShopifyOrderData=await reader<ShopifyOrderData>(
      env,SOURCE_QUERY,{first:PAGE_SIZE,after:cursor,query:filter}
    );
    const c=response?.orders;
    const nodes=c?.nodes;
    if(!Array.isArray(nodes)||nodes.length>PAGE_SIZE||
       !c?.pageInfo||typeof c.pageInfo.hasNextPage!=="boolean")
      throw new Error("shopify_adoption_malformed_page");
    for(const node of nodes){
      const order=object(node);
      const gid=value(order.id);
      if(!GID_RE.test(gid))throw new Error("shopify_adoption_order_id_invalid");
      const created=iso(order.createdAt);
      // Search returns a deliberately padded window; only original precise
      // UTC boundaries are eligible for a positive adoption reference.
      if(Date.parse(created)<since||Date.parse(created)>until){
        ignoredOutsideWindow++;
        continue;
      }
      scanned++;
      // Never fetch recipient, address, buyer or payment data for this job.
      if(order.sourceName!=="amazon"||value(object(order.app).name)!=="Channable"){
        unverified.push({shopify_order_gid:gid,reason:"unexpected_importing_app_or_source"});
        continue;
      }
      const attrs=order.customAttributes;
      if(!Array.isArray(attrs)){
        unverified.push({shopify_order_gid:gid,reason:"missing_custom_attributes"});
        continue;
      }
      const ids=attrs.map(object).filter(a=>a.key==="Amazon Order ID");
      if(ids.length!==1||!ORDER_ID_RE.test(value(ids[0]?.value))){
        unverified.push({shopify_order_gid:gid,reason:"amazon_order_id_missing_or_malformed"});
        continue;
      }
      const external=value(ids[0].value);
      const sourceIdentifier=value(order.sourceIdentifier);
      if(sourceIdentifier&&sourceIdentifier!==external)
        throw new Error("shopify_adoption_conflicting_source_identifier");
      const priorGid=found.get(external)?.shopify_order_gid;
      if(priorGid&&priorGid!==gid)
        throw new Error("shopify_adoption_duplicate_external_order");
      const priorExternal=gidToExternal.get(gid);
      if(priorExternal&&priorExternal!==external)
        throw new Error("shopify_adoption_order_reference_changed");
      gidToExternal.set(gid,external);
      found.set(external,{
        amazon_order_id:external,shopify_order_gid:gid,
        source_name:"amazon",importing_app:"Channable",
        shopify_created_at:created,adoption_status:"FOUND_CHANNABLE"
      });
    }
    pages++;
    if(!c.pageInfo.hasNextPage)break;
    const next=c.pageInfo.endCursor;
    if(typeof next!=="string"||next.length===0||next.length>8192||
      next===cursor||seenCursors.has(next))
      throw new Error("shopify_adoption_invalid_cursor");
    seenCursors.add(next);
    cursor=next;
  }
  return {
    ok:true,source:"shopify_channable_amazon_order_signature",
    read_only:true,created_after:after,created_before:before,
    pages_read:pages,shopify_orders_scanned:scanned,
    outside_requested_utc_window_ignored:ignoredOutsideWindow,
    search_boundaries_padded_for_shop_timezone:true,
    found_count:found.size,unverified_count:unverified.length,
    found:[...found.values()],unverified,
    pagination_complete:true,
    external_order_id_field:"customAttributes.Amazon Order ID",
    standard_source_identifier_may_be_null:true,
    absence_proven:false,
    safe_to_create_shopify_order:false,
    order_importer_owner:"CHANNABLE",
    next_step:"MATCH_FOUND_RECORDS_ONLY_AND_RECONCILE_ALL_UNVERIFIED_AND_OUT_OF_WINDOW_ORDERS"
  };
}
