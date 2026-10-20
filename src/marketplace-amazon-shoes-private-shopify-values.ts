import { shopifyGraphQL } from "./index.js";
import { resolveAmazonListingBrand } from "./marketplace-amazon-listing-brand.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/**
 * Reads only merchant-maintained Amazon SHOES metadata from Shopify Admin API.
 * Values are for VALIDATION_PREVIEW ONLY, never product publishing.
 * No GraphQL mutation, public Storefront API request or storefront/theme write.
 */
type Row=Record<string,unknown>;
const GID=/^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,24}$/;
const SKU=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const QUERY='query MerchantPrivateShoesValues($variantId:ID!){productVariant(id:$variantId){id sku selectedOptions{name value} product{id title vendor status productType metafields(first:20,namespace:"amazon_ptd_shoes"){nodes{key namespace type value} pageInfo{hasNextPage endCursor}}}}}';
function obj(value:unknown):Row {
  return value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Row:{};
}
function safeText(raw:unknown,max=95):raw is string {
  return typeof raw==="string"&&raw.length>0&&raw.length<=max&&
    raw===raw.trim()&&!/[\u0000-\u001f\u007f<>]/.test(raw);
}
function fail(reason:string):{ok:false;reason:string}{
  return {ok:false,reason};
}
type Expected=Readonly<{
  sku:string;variantId:string;productTitle:string;shopifyVendor:string;amazonBrand:string;
}>;
export async function readAmazonShoesPrivateShopifyValues(
  expected:Expected,env:MareBusinessShopifyEnv,
  deps:{queryShopify?:typeof shopifyGraphQL}={},
):Promise<Row>{
  if(!expected||!safeText(expected.sku,120)||!SKU.test(expected.sku)||
     !GID.test(expected.variantId)||!safeText(expected.productTitle,200)||
     !safeText(expected.shopifyVendor,100)||!safeText(expected.amazonBrand,100))
    return fail("source_identity_invalid");
  const identity=resolveAmazonListingBrand(expected.shopifyVendor);
  if(!identity||identity.amazon_brand!==expected.amazonBrand)
    return fail("amazon_brand_mapping_unverified");
  let result:Row;
  try {
    result=obj(await(deps.queryShopify??shopifyGraphQL)(
      env,QUERY,{variantId:expected.variantId}));
  } catch {return fail("shopify_private_fields_unavailable");}
  const variant=obj(result.productVariant),product=obj(variant.product);
  if(variant.id!==expected.variantId||variant.sku!==expected.sku||
     product.status!=="ACTIVE"||product.productType!=="Sneakers"||
     product.title!==expected.productTitle||product.vendor!==expected.shopifyVendor)
    return fail("shopify_identity_changed");
  const connection=obj(product.metafields),page=obj(connection.pageInfo);
  if(page.hasNextPage!==false||!Array.isArray(connection.nodes)||connection.nodes.length>20)
    return fail("shopify_metafields_incomplete");
  const fields=new Map<string,string>();
  for(const item of connection.nodes){
    const field=obj(item),key=field.key;
    if(field.namespace!=="amazon_ptd_shoes"||
       typeof key!=="string"||
       !["amazon_brand","model_name","color","target_gender","model_number",
         "age_range_description","country_of_origin","manufacturer"].includes(key)||
       field.type!=="single_line_text_field"||fields.has(key))
      return fail("shopify_metafields_unverified");
    if(typeof field.value!=="string")return fail("shopify_metafields_unverified");
    fields.set(key,field.value);
  }
  if(fields.get("amazon_brand")!==expected.amazonBrand)
    return fail("shopify_brand_field_mismatch");
  const model=fields.get("model_name"),color=fields.get("color");
  if(!safeText(model,80)||!safeText(color,80))
    return fail("shopify_pilot_model_or_color_missing");

  const rawGender=fields.get("target_gender");
  const genderMap:Record<string,string>={Donna:"female",Uomo:"male",Unisex:"unisex"};
  if(!rawGender||!Object.hasOwn(genderMap,rawGender))
    return fail("shopify_shoes_gender_unverified");
  const choices=variant.selectedOptions;
  if(!Array.isArray(choices)||choices.length===0||choices.length>8)
    return fail("shopify_shoes_size_unverified");
  const sizes=choices.map(obj).filter(o=>typeof o.name==="string"&&
    /^(numero|taglia|size|shoe size|eu size)$/i.test(o.name.trim()));
  if(sizes.length!==1||typeof sizes[0].value!=="string")
    return fail("shopify_shoes_size_unverified");
  const match=/^([1-9]\d?)(?:[.,](5))?\s+EU$/i.exec(sizes[0].value.trim());
  if(!match||Number(match[1])<20||Number(match[1])>55)
    return fail("shopify_shoes_size_unverified");
  const euSize=match[1]+(match[2]?".5":"");
  // Identical Admin-verified variant selection and private product metafields.
  // Never guess manufacturer, origin, footwear materials, GPSR or package metrics.
  return {ok:true,model_name:model,color,
    eu_footwear_size:euSize,amazon_target_gender:genderMap[rawGender],
    verified_paths:["product.amazon_ptd_shoes.amazon_brand",
      "product.amazon_ptd_shoes.model_name","product.amazon_ptd_shoes.color",
      "product.amazon_ptd_shoes.target_gender","variant.selectedOptions"],
    draft_values_review_only:true,public_storefront_access_used:false,
    product_created:false,ready_for_publication:false};
}
