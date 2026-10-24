import {shopifyGraphQL} from "./index.js";
import type {MareBusinessShopifyEnv} from "./mare-business-shopify.js";

/** Read-only Shopify metafield LOCATION evidence for compliance-related keys.
 * No metafield value, customer record, legal contact, manufacturer assertion,
 * verification status or storefront change is ever returned. */
type Row=Record<string,unknown>;
type Deps={queryShopify?:typeof shopifyGraphQL};
const SKU=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const KEY=/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/;
const TERMS=/(?:gpsr|dsa|responsib|manufacturer|manufactur|fabbricant|produttor|producer|compliance|safety|sicurezza|importer|legal.?entity|eu.?contact)/i;
const QUERY='query GpsrFieldLocations($search:String!){productVariants(first:5,query:$search){pageInfo{hasNextPage} nodes{ id sku inventoryQuantity metafields(first:100){pageInfo{hasNextPage} nodes{namespace key type value}} product{id vendor status metafields(first:100){pageInfo{hasNextPage} nodes{namespace key type value}}}}}}';
const FLAGS={read_only:true,provider_mutations:0,values_exported:false,
 manufacturer_verified:false,eu_responsible_person_verified:false,
 gpsr_compliance_proven:false,ready_for_amazon_patch:false,
 channable_writer_unchanged:true,shopify_storefront_unchanged:true} as const;
function obj(v:unknown):Row{return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};}
function blocked(sku:string,status:string):Row{return {ok:false,sku,status,fields:[],...FLAGS};}
export async function readShopifyGpsrFieldLocations(raw:unknown,env:MareBusinessShopifyEnv,deps:Deps={}):Promise<Row>{
 const x=obj(raw),ks=Object.keys(x),sku=x.sku;
 if(ks.length!==1||typeof sku!=="string"||!SKU.test(sku)||sku.trim()!==sku)
  throw Error("shopify_gpsr_fields_invalid_request");
 let data:Row;
 try{data=obj(await(deps.queryShopify??shopifyGraphQL)(env,QUERY,{search:'sku:"'+sku+'"'}));}
 catch{return blocked(sku,"SHOPIFY_QUERY_FAILED");}
 const root=obj(data.productVariants);
 if(obj(root.pageInfo).hasNextPage!==false||!Array.isArray(root.nodes)||
   root.nodes.length>5)return blocked(sku,"SHOPIFY_SKU_SEARCH_INCOMPLETE");
 const hits=root.nodes.map(obj).filter(v=>v.sku===sku);
 if(hits.length!==1)return blocked(sku,"SHOPIFY_SKU_NOT_UNIQUE");
 const v=hits[0],p=obj(v.product);
 if(p.status!=="ACTIVE"||typeof p.vendor!=="string"||!p.vendor||
    !Number.isSafeInteger(v.inventoryQuantity)||(v.inventoryQuantity as number)<=0)
   return blocked(sku,"SHOPIFY_SKU_NOT_ACTIVE_OR_IN_STOCK");
 const evidence:Array<{owner:string;namespace:string;key:string;type:string;non_empty:boolean}>=[];
 for(const [owner,source] of [["product",p],["variant",v]] as const){
   const conn=obj(source.metafields),page=obj(conn.pageInfo);
   if(page.hasNextPage!==false||!Array.isArray(conn.nodes)||conn.nodes.length>100)
     return blocked(sku,"SHOPIFY_METAFIELDS_NOT_COMPLETE");
   for(const input of conn.nodes){
     const f=obj(input);
     if(typeof f.namespace!=="string"||!KEY.test(f.namespace)||
       typeof f.key!=="string"||!KEY.test(f.key)||
       typeof f.type!=="string"||!KEY.test(f.type))continue;
     if(!TERMS.test(f.namespace+"."+f.key))continue;
     evidence.push({owner,namespace:f.namespace,key:f.key,type:f.type,
       non_empty:typeof f.value==="string"&&f.value.trim().length>0});
   }
 }
 return {ok:true,status:evidence.length?"GPSR_RELATED_FIELD_LOCATIONS_OBSERVED":"NO_GPSR_RELATED_FIELD_KEYS_OBSERVED",
   sku,vendor:p.vendor,shopify_quantity:v.inventoryQuantity,
   fields:evidence.slice(0,80),fields_truncated:evidence.length>80,
   search_scope:"PRODUCT_AND_VARIANT_METAFIELDS",
   field_key_presence_does_not_prove_valid_compliance:true,
   ...FLAGS};
}
