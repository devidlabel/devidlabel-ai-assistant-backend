import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";

/** No new contact values: revalidate an ALREADY SUBMITTED manufacturer email
 * via SP-API PATCH mode=VALIDATION_PREVIEW. Amazon guarantees no persistence
 * in validation preview; there is deliberately no live-write branch. */
type Row=Record<string,unknown>;
type Env=AmazonCredentials&{AMAZON_SP_API_SELLER_ID?:string};
type Deps={seller?:typeof readAmazonSellerListingsDirect;auth?:typeof getAmazonAccessToken;fetch?:typeof fetch};
const HOST="https://sellingpartnerapi-eu.amazon.com",MARKET="APJ6JRA9NG5V4";
const SKU=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const SELLER=/^[A-Z0-9]{8,30}$/;
const ASIN=/^[A-Z0-9]{10}$/;
const TYPE=/^[A-Z][A-Z0-9_]{1,79}$/;
const CODE=/^[A-Z0-9_]{1,72}$/;
const EMAIL=/^[^\s@]{1,100}@[^\s@.]{1,130}(?:\.[^\s@.]{2,30})+$/;
const MAX_BYTES=256000;
const FLAGS={preview_only:true,read_only_effect:true,provider_mutations:0,
 can_publish:false,can_modify_listing:false,can_change_price:false,
 can_change_stock:false,account_health_approval_verified:false,
 manufacturer_identity_approved:false,eu_responsible_person_approved:false,
 gpsr_compliance_proven:false,does_not_resolve_100632:true,
 channable_writer_unchanged:true} as const;
function obj(v:unknown):Row{return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};}
function fail(status:string,sku:string):Row{return {ok:false,status,sku,issue_codes:[],...FLAGS};}
async function json(resp:Response):Promise<Row|null>{
 if(resp.status!==200||!/^application\/json(?:\s*;|$)/i.test(resp.headers.get("content-type")||""))return null;
 const size=resp.headers.get("content-length");
 if(size&&(!/^\d+$/.test(size)||Number(size)>MAX_BYTES))return null;
 if(!resp.body)return null;
 let n=0,s="";const reader=resp.body.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});
 try{
  while(true){const c=await reader.read();if(c.done)break;n+=c.value.byteLength;
   if(n>MAX_BYTES){void reader.cancel().catch(()=>{});return null;}
   s+=decoder.decode(c.value,{stream:true});
  }s+=decoder.decode();return obj(JSON.parse(s));
 }catch{return null;}finally{reader.releaseLock();}
}
export async function previewExistingItManufacturerReference(raw:unknown,env:Env,deps:Deps={}):Promise<Row>{
 const r=obj(raw),sku=r.sku;
 if(Object.keys(r).length!==1||typeof sku!=="string"||!SKU.test(sku)||
    sku!==sku.trim()||/kangol/i.test(sku))
  throw Error("gpsr_existing_manufacturer_preview_invalid_request");
 const seller=env.AMAZON_SP_API_SELLER_ID;
 if(typeof seller!=="string"||!SELLER.test(seller))
  return fail("SELLER_CONFIG_UNVERIFIED",sku);
 let prior:Row;
 try{prior=obj(await(deps.seller??readAmazonSellerListingsDirect)({marketplace:"IT",skus:[sku]},env));}
 catch{return fail("SELLER_READ_UNAVAILABLE",sku);}
 if(prior.ok!==true||prior.read_only!==true||prior.provider_mutations!==0||
  prior.marketplace!=="IT"||!Array.isArray(prior.results)||prior.results.length!==1)
  return fail("SELLER_EVIDENCE_INCOMPLETE",sku);
 const l=obj(prior.results[0]);
 const issues=Array.isArray(l.issue_signals)?l.issue_signals.map(obj):[];
 if(l.sku!==sku||l.state!=="PRESENT"||l.identity_state!=="VERIFIED"||
   typeof l.asin!=="string"||!ASIN.test(l.asin)||
   typeof l.product_type!=="string"||!TYPE.test(l.product_type)||
   !Array.isArray(l.statuses)||l.statuses.includes("BUYABLE")||
   !Number.isSafeInteger(l.current_fbm_quantity)||(l.current_fbm_quantity as number)<=0||
   !issues.some(z=>z.code==="100632"&&z.severity==="ERROR"))
  return fail("NOT_ELIGIBLE_EXISTING_POSITIVE_STOCK_100632",sku);
 let token:string;
 try{token=await(deps.auth??getAmazonAccessToken)(env);}
 catch{return fail("AMAZON_AUTH_UNAVAILABLE",sku);}
 if(typeof token!=="string"||!token||token.length>16384||/[\s\u0000-\u001f\u007f]/.test(token))
  return fail("AMAZON_AUTH_UNAVAILABLE",sku);
 const fetcher=deps.fetch??fetch;
 const endpoint=new URL(HOST+"/listings/2021-08-01/items/"+encodeURIComponent(seller)+"/"+encodeURIComponent(sku));
 endpoint.searchParams.set("marketplaceIds",MARKET);
 endpoint.searchParams.set("includedData","summaries,attributes,issues");
 endpoint.searchParams.set("issueLocale","en_US");
 let detail:Row|null=null;
 try{detail=await json(await fetcher(endpoint.toString(),{
   method:"GET",headers:{"x-amz-access-token":token,Accept:"application/json"},
   redirect:"manual",signal:AbortSignal.timeout(20000)
  }));}catch{return fail("AMAZON_EXISTING_ATTRIBUTES_UNAVAILABLE",sku);}
 if(!detail)return fail("AMAZON_EXISTING_ATTRIBUTES_UNAVAILABLE",sku);
 const summaries=Array.isArray(detail.summaries)?detail.summaries.map(obj):[];
 if(detail.sku!==sku||summaries.length!==1||
  summaries[0].marketplaceId!==MARKET||summaries[0].asin!==l.asin)
  return fail("AMAZON_ASIN_IDENTITY_MISMATCH",sku);
 const attr=obj(detail.attributes);
 const list=attr.gpsr_manufacturer_reference;
 if(!Array.isArray(list)||list.length!==1)return fail("NO_UNIQUE_EXISTING_MANUFACTURER_REFERENCE",sku);
 const mf=obj(list[0]);
 const email=mf.gpsr_manufacturer_email_address;
 if(typeof email!=="string"||email.length>254||!EMAIL.test(email)||
    (mf.marketplace_id!==undefined&&mf.marketplace_id!==MARKET)||
    Object.keys(mf).some(k=>!["gpsr_manufacturer_email_address","marketplace_id"].includes(k)))
  return fail("EXISTING_MANUFACTURER_REFERENCE_NOT_SAFE_TO_REPLAY",sku);
 // Preserve only original Amazon existing value; no guessed contact or
 // responsible-person data and no default safety attestation.
 const payload={productType:l.product_type,patches:[{
  op:"replace",path:"/attributes/gpsr_manufacturer_reference",
  value:[{gpsr_manufacturer_email_address:email,marketplace_id:MARKET}]
 }]};
 const preview=new URL(HOST+"/listings/2021-08-01/items/"+encodeURIComponent(seller)+"/"+encodeURIComponent(sku));
 preview.searchParams.set("marketplaceIds",MARKET);
 preview.searchParams.set("mode","VALIDATION_PREVIEW");
 preview.searchParams.set("includedData","issues");
 preview.searchParams.set("issueLocale","en_US");
 let feedback:Row|null=null;
 try{feedback=await json(await fetcher(preview.toString(),{
  method:"PATCH",headers:{"x-amz-access-token":token,
   "content-type":"application/json",Accept:"application/json"},
  body:JSON.stringify(payload),redirect:"manual",signal:AbortSignal.timeout(20000)
 }));}catch{return fail("AMAZON_VALIDATION_PREVIEW_UNAVAILABLE",sku);}
 if(!feedback)return fail("AMAZON_VALIDATION_PREVIEW_UNAVAILABLE",sku);
 if(feedback.sku!==sku||!["ACCEPTED","INVALID"].includes(String(feedback.status))||
    !Array.isArray(feedback.issues)||feedback.issues.length>64)
  return fail("AMAZON_VALIDATION_PREVIEW_RESPONSE_UNVERIFIED",sku);
 const issuesFromPreview=feedback.issues.map(obj);
 const codes=[...new Set(issuesFromPreview.filter(x=>x.severity==="ERROR"&&typeof x.code==="string"&&CODE.test(x.code)).map(x=>x.code))].sort();
 return {ok:true,status:"AMAZON_MANUFACTURER_EXISTING_VALUE_PREVIEW_ONLY",
  sku,asin:l.asin,product_type:l.product_type,marketplace:"IT",
  response_status:feedback.status,issue_codes:codes,
  preview_attribute:"gpsr_manufacturer_reference",
  email_address_exposed:false,existing_value_reused_without_changes:true,
  validation_is_not_listing_publication:true,...FLAGS};
}
