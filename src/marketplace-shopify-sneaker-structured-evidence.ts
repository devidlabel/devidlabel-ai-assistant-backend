import { shopifyGraphQL } from "./index.js";
import { readShopifyCatalogComplete } from "./mare-business-shopify-complete.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/** Read-only Shopify metadata evidence LOCATIONS. Never outputs values or approval. */
type Row = Record<string,unknown>;
type Env = MareBusinessShopifyEnv;
export type SneakerEvidenceDeps = {
  readCatalog?: typeof readShopifyCatalogComplete;
  queryShopify?: typeof shopifyGraphQL;
};
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const PRODUCT_RE = /^gid:\/\/shopify\/Product\/[1-9][0-9]{0,24}$/;
const VARIANT_RE = /^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]{0,24}$/;
const FIELDS = [
  {owner:"product",field:"model",path:"custom.marketplace_model_name",candidate:"model_name",type:"single_line_text_field"},
  {owner:"product",field:"gender",path:"custom.navigation_gender",candidate:"target_gender",type:"list.single_line_text_field"},
  {owner:"product",field:"agenticColor",path:"agentic.color",candidate:"color",type:"single_line_text_field"},
  {owner:"product",field:"featureColor",path:"features.color",candidate:"color",type:"metaobject_reference"},
  {owner:"product",field:"featureMaterial",path:"features.material",candidate:null,type:"metaobject_reference"},
  {owner:"variant",field:"mpn",path:"mm-google-shopping.mpn",candidate:"model_number",type:"single_line_text_field"},
  {owner:"variant",field:"ageGroup",path:"mm-google-shopping.age_group",candidate:"age_range_description",type:"single_line_text_field"},
  {owner:"variant",field:"gender",path:"mm-google-shopping.gender",candidate:"target_gender",type:"single_line_text_field"},
  {owner:"variant",field:"sizeSystem",path:"mm-google-shopping.size_system",candidate:"footwear_size",type:"single_line_text_field"},
  {owner:"variant",field:"sizeType",path:"mm-google-shopping.size_type",candidate:"footwear_size",type:"single_line_text_field"},
] as const;
const QUERY = 'query MerchantShoesEvidence($productId:ID!,$variantId:ID!){product(id:$productId){id vendor status productType model:metafield(namespace:"custom",key:"marketplace_model_name"){type value} gender:metafield(namespace:"custom",key:"navigation_gender"){type value} agenticColor:metafield(namespace:"agentic",key:"color"){type value} featureColor:metafield(namespace:"features",key:"color"){type value} featureMaterial:metafield(namespace:"features",key:"material"){type value}} productVariant(id:$variantId){id sku product{id} mpn:metafield(namespace:"mm-google-shopping",key:"mpn"){type value} ageGroup:metafield(namespace:"mm-google-shopping",key:"age_group"){type value} gender:metafield(namespace:"mm-google-shopping",key:"gender"){type value} sizeSystem:metafield(namespace:"mm-google-shopping",key:"size_system"){type value} sizeType:metafield(namespace:"mm-google-shopping",key:"size_type"){type value}}}';
function obj(x:unknown):Row{return x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Row:{};}
function block(sku:string,reason:string):Row{return {ok:false,sku,status:"BLOCKED",blocker:reason,fields:[],
  ready_for_validation_preview:false,ready_for_publication:false,
  values_exported:false,manufacturer_verified:false,gpsr_compliance_proven:false,
  provider_mutations:0,read_only:true};}
function usable(x:unknown):boolean{return typeof x==="string"&&x.trim().length>0&&x.trim().length<=400&&
  !["n/a","n.d.","unknown","-","null"].includes(x.trim().toLowerCase());}
export async function readShopifySneakerStructuredEvidence(rawInput:unknown,env:Env,deps:SneakerEvidenceDeps={}):Promise<Row>{
  const input=obj(rawInput);
  if(Object.keys(input).length!==1||typeof input.sku!=="string"||
    !SKU_RE.test(input.sku)||input.sku!==input.sku.trim())
    throw new Error("shopify_sneaker_evidence_invalid_request");
  const sku=input.sku;
  let product:Row,variant:Row;
  try{
    const catalog=obj(await (deps.readCatalog??readShopifyCatalogComplete)({
      query:'sku:"'+sku+'" status:active,draft,archived,unlisted',
      max_products:50,inline_limit:50,include_csv:false,stable_order:true,persist_artifacts:false,
    },env));
    if(catalog.ok!==true||catalog.truncated!==false||catalog.complete_variant_pagination!==true||
      catalog.product_count!==catalog.inline_product_count||
      !Array.isArray(catalog.products)||catalog.products.length!==catalog.product_count)
      return block(sku,"shopify_catalog_unverified");
    const found:Array<{product:Row,variant:Row}>=[];
    for(const raw of catalog.products){
      const p=obj(raw);
      if(!Array.isArray(p.variants))return block(sku,"shopify_variants_unverified");
      for(const vv of p.variants){const v=obj(vv);if(v.sku===sku)found.push({product:p,variant:v});}
    }
    if(found.length!==1)return block(sku,"shopify_sku_missing_or_duplicated");
    ({product,variant}=found[0]);
    if(product.status!=="ACTIVE"||product.product_type!=="Sneakers"||
      typeof product.vendor!=="string"||!product.vendor.trim()||
      product.vendor.toLowerCase()==="p448"||
      typeof product.id!=="string"||!PRODUCT_RE.test(product.id)||
      typeof variant.id!=="string"||!VARIANT_RE.test(variant.id)||
      !Number.isSafeInteger(variant.inventory_quantity)||(variant.inventory_quantity as number)<1||
      variant.inventory_tracked!==true||variant.inventory_levels_complete!==true)
      return block(sku,"shopify_active_sneaker_stock_or_identity_unverified");
  }catch{return block(sku,"shopify_source_unavailable");}
  let result:Row;
  try{result=obj(await (deps.queryShopify??shopifyGraphQL)(env,QUERY,{productId:product.id,variantId:variant.id}));}
  catch{return block(sku,"shopify_metafields_unavailable");}
  const p=obj(result.product),v=obj(result.productVariant);
  if(p.id!==product.id||p.status!=="ACTIVE"||p.productType!=="Sneakers"||
    p.vendor!==product.vendor||v.id!==variant.id||v.sku!==sku||
    obj(v.product).id!==product.id)
    return block(sku,"shopify_metafield_identity_mismatch");
  const fields=FIELDS.flatMap(spec=>{
    const data=obj((spec.owner==="product"?p:v)[spec.field]);
    if(data.type!==spec.type||!usable(data.value))return [];
    return [{shopify_path:spec.owner+"."+spec.path,amazon_attribute_candidate:spec.candidate,
      evidence_state:spec.type==="metaobject_reference"?"REFERENCE_REVIEW":"TRANSFORM_REVIEW",
      manufacturer_verified:false}];
  });
  return {ok:true,status:"STRUCTURED_EVIDENCE_REVIEW_REQUIRED",sku,
    shopify_state:"ACTIVE_IN_STOCK",observed_at:new Date().toISOString(),fields,field_count:fields.length,
    mapped_attribute_candidate_count:fields.filter(x=>x.amazon_attribute_candidate!==null).length,
    unmapped_reference_count:fields.filter(x=>x.amazon_attribute_candidate===null).length,
    reference_values_resolved:false,values_exported:false,manufacturer_verified:false,
    gpsr_compliance_proven:false,brand_authorization_proven:false,
    ready_for_validation_preview:false,ready_for_publication:false,
    provider_mutations:0,read_only:true};
}
