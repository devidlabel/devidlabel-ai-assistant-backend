import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";
import { shopifyGraphQL } from "./index.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/** One-ASIN, contact-only GPSR pilot. Never declares safety or account approval.
 * The exact K-Way brand-operator email must be present in existing Shopify
 * evidence. The same email may be used as a candidate EU contact only for
 * this initial diagnostic submission; Amazon independently decides validity. */
type Row=Record<string,unknown>;
type Env=AmazonCredentials&MareBusinessShopifyEnv&{
 AMAZON_SP_API_SELLER_ID?:string;AMAZON_OFFER_PREVIEW_ENABLED?:string;
};
type Deps={
 seller?:typeof readAmazonSellerListingsDirect;
 shopify?:typeof shopifyGraphQL;
 auth?:typeof getAmazonAccessToken;
 fetch?:typeof fetch;
};
const SKU="KWAY_K6131ZW_USY_S";
const ASIN="B0HQ4XP9NZ";
const EMAIL="customer@k-way.com";
const MARKET="APJ6JRA9NG5V4";
const HOST="https://sellingpartnerapi-eu.amazon.com";
const SKU_QUERY='query KwayGpsrExact($query:String!){productVariants(first:20,query:$query){nodes{sku inventoryQuantity product{id vendor status evidence:metafield(namespace:"custom",key:"amazon_gpsr_evidence"){type value} mf:metafield(namespace:"custom",key:"gpsr_manufacturer_reference_email_address"){value} rp:metafield(namespace:"custom",key:"dsa_responsible_party_address"){value}}}pageInfo{hasNextPage}}}';
const NO_WRITE={marketplace:"IT",sku:SKU,asin:ASIN,product_type:"COAT",
 qty_changed:false,price_changed:false,safety_attestation_submitted:false,
 channable_changed:false,brand_approval_proven:false,
 gpsr_compliance_proven:false,buyable_verified:false};
function obj(x:unknown):Row{return x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Row:{};}
function block(reason:string):Row{return {ok:false,status:reason,provider_mutations:0,...NO_WRITE};}
async function json(resp:Response):Promise<Row|null>{
 if(resp.status!==200||!/^application\/json(?:;|$)/i.test(resp.headers.get("content-type")||""))return null;
 const len=Number(resp.headers.get("content-length")||"0");
 if(!Number.isFinite(len)||len>256000)return null;
 try{const s=await resp.text();return s.length<=256000?obj(JSON.parse(s)):null;}catch{return null;}
}
export async function patchKwayRoulandGpsrContacts(raw:unknown,env:Env,deps:Deps={}):Promise<Row>{
 const r=obj(raw);
 if(Object.keys(r).length!==3||r.marketplace!=="IT"||r.sku!==SKU||r.asin!==ASIN)
  throw Error("kway_gpsr_contact_pilot_invalid_request");
 const sellerId=env.AMAZON_SP_API_SELLER_ID;
 if(!sellerId||!/^[A-Z0-9]{8,30}$/.test(sellerId)||env.AMAZON_OFFER_PREVIEW_ENABLED!=="true")
  return block("CONFIG_UNVERIFIED");
 let seller:Row;
 try{seller=obj(await (deps.seller??readAmazonSellerListingsDirect)({marketplace:"IT",skus:[SKU]},env));}
 catch{return block("AMAZON_SELLER_READ_FAILED");}
 if(seller.ok!==true||seller.provider_mutations!==0||!Array.isArray(seller.results)||seller.results.length!==1)
  return block("AMAZON_SELLER_IDENTITY_UNVERIFIED");
 const listing=obj(seller.results[0]);
 const issue=Array.isArray(listing.issue_signals)?listing.issue_signals.map(obj):[];
 if(listing.sku!==SKU||listing.state!=="PRESENT"||listing.identity_state!=="VERIFIED"||
   listing.asin!==ASIN||listing.product_type!=="COAT"||
   listing.current_fbm_quantity!==0||!Array.isArray(listing.statuses)||
   listing.statuses.includes("BUYABLE")||
   !issue.some(x=>["100632","100528"].includes(String(x.code))))
  return block("NONBUYABLE_ZERO_STOCK_IDENTITY_UNVERIFIED");
 let data:Row;
 try{data=obj(await (deps.shopify??shopifyGraphQL)(
   env,SKU_QUERY,{query:"sku:"+SKU}));}
 catch{return block("SHOPIFY_CONTACT_EVIDENCE_UNAVAILABLE");}
 const connection=obj(data.productVariants);
 if(obj(connection.pageInfo).hasNextPage===true||!Array.isArray(connection.nodes))
  return block("SHOPIFY_VARIANT_PAGE_INCOMPLETE");
 const active=connection.nodes.map(obj).filter(x=>x.sku===SKU&&obj(x.product).status==="ACTIVE");
 if(active.length!==1||!Number.isSafeInteger(active[0].inventoryQuantity)||
    (active[0].inventoryQuantity as number)<=0)
  return block("SHOPIFY_ACTIVE_VARIANT_UNVERIFIED");
 const product=obj(active[0].product);
 if(product.vendor!=="K-Way"||product.id!=="gid://shopify/Product/11523512729941")
  return block("SHOPIFY_PRODUCT_IDENTITY_UNVERIFIED");
 const meta=obj(product.evidence);
 if(meta.type!=="json"||typeof meta.value!=="string")return block("SHOPIFY_GPSR_SOURCE_MISSING");
 let evidence:Row;
 try{evidence=obj(JSON.parse(meta.value));}catch{return block("SHOPIFY_GPSR_SOURCE_INVALID");}
 const operator=obj(evidence.brand_operator);
 if(evidence.brand!=="K-Way"||
   evidence.source_scope!=="OFFICIAL_COMPANY_CONTACT_NOT_PRODUCT_LABEL_GPSR_PROOF"||
   operator.name!=="K-Way S.p.A."||operator.public_contact_email!==EMAIL||
   obj(product.mf).value!==EMAIL||obj(product.rp).value!==EMAIL||
   evidence.amazon_mapping_status!=="DRAFT_GPSR_FIELDS_NOT_SUBMITTED_TO_AMAZON")
  return block("SHOPIFY_GPSR_CONTACTS_UNVERIFIED");
 let token:string;
 try{token=await(deps.auth??getAmazonAccessToken)(env);}
 catch{return block("AMAZON_AUTH_UNAVAILABLE");}
 if(typeof token!=="string"||token.length<5||token.length>16384||/[\s\u0000-\u001f\u007f]/.test(token))
  return block("AMAZON_AUTH_UNAVAILABLE");
 const fetcher=deps.fetch??fetch;
 const base=HOST+"/listings/2021-08-01/items/"+encodeURIComponent(sellerId)+"/"+encodeURIComponent(SKU);
 const getUrl=new URL(base);
 getUrl.searchParams.set("marketplaceIds",MARKET);
 getUrl.searchParams.set("includedData","summaries,attributes,issues");
 const headers={"x-amz-access-token":token,Accept:"application/json"};
 let before:Row|null;
 try{before=await json(await fetcher(getUrl.toString(),{
   method:"GET",headers,redirect:"manual",signal:AbortSignal.timeout(20000)}));}
 catch{return block("AMAZON_LISTING_ATTRIBUTES_UNAVAILABLE");}
 const summaries=Array.isArray(before?.summaries)?before.summaries.map(obj):[];
 if(!before||before.sku!==SKU||summaries.length!==1||
   summaries[0].marketplaceId!==MARKET||summaries[0].asin!==ASIN)
  return block("AMAZON_LISTING_ASIN_MISMATCH");
 const attrs=obj(before.attributes);
 // Never overwrite other registered compliance identities.
 for(const name of ["gpsr_manufacturer_reference","dsa_responsible_party_address"]){
  const values=attrs[name];
  if(values!==undefined&&(!Array.isArray(values)||values.length>0))
   return block("EXISTING_GPSR_REFERENCE_NOT_SAFE_TO_OVERWRITE");
 }
 const payload={productType:"COAT",patches:[
  {op:"replace",path:"/attributes/gpsr_manufacturer_reference",
   value:[{gpsr_manufacturer_email_address:EMAIL,marketplace_id:MARKET}]},
  {op:"replace",path:"/attributes/dsa_responsible_party_address",
   value:[{value:EMAIL,marketplace_id:MARKET}]}
 ]};
 const patchUrl=new URL(base);
 patchUrl.searchParams.set("marketplaceIds",MARKET);
 patchUrl.searchParams.set("issueLocale","en_US");
 patchUrl.searchParams.set("mode","VALIDATION_PREVIEW");
 const patchHeaders={...headers,"content-type":"application/json"};
 let preview:Row|null;
 try{preview=await json(await fetcher(patchUrl.toString(),{
  method:"PATCH",headers:patchHeaders,body:JSON.stringify(payload),
  redirect:"manual",signal:AbortSignal.timeout(20000)}));}
 catch{return block("GPSR_VALIDATION_PREVIEW_FAILED");}
 const issues=Array.isArray(preview?.issues)?preview.issues.map(obj):[];
 const errors=issues.filter(x=>x.severity==="ERROR").map(x=>String(x.code)).slice(0,20);
 if(!preview||preview.sku!==SKU||preview.status!=="VALID"||errors.length>0)
  return {ok:false,status:"GPSR_CONTACT_PREVIEW_NOT_VALID",issue_codes:errors,
   provider_mutations:0,...NO_WRITE};
 // Live call is intentionally one-shot; on network uncertainty never retry.
 patchUrl.searchParams.delete("mode");
 let live:Row|null=null;
 try{live=await json(await fetcher(patchUrl.toString(),{
  method:"PATCH",headers:patchHeaders,body:JSON.stringify(payload),
  redirect:"manual",signal:AbortSignal.timeout(20000)}));}
 catch{return {ok:false,status:"GPSR_LIVE_ACKNOWLEDGEMENT_UNKNOWN_NO_RETRY",
  provider_write_attempted:true,...NO_WRITE};}
 if(!live||live.sku!==SKU||!["ACCEPTED","VALID"].includes(String(live.status)))
  return {ok:false,status:"GPSR_LIVE_RESPONSE_UNKNOWN_NO_RETRY",
   provider_write_attempted:true,...NO_WRITE};
 return {ok:true,status:"GPSR_CONTACT_PATCH_SUBMITTED_AWAITING_READBACK",
  provider_write_attempted:true,amazon_submission_status:live.status,
  provider_submission_id:typeof live.submissionId==="string"?live.submissionId:null,
  gpsr_attributes_submitted:["gpsr_manufacturer_reference","dsa_responsible_party_address"],
  ...NO_WRITE};
}
