import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";

/** Inspect the current Amazon IT Product Type Definition for one VERIFIED
 * existing non-BUYABLE seller offer. Never send listing updates, expose
 * schema enum/default values or infer regulatory/Account Health approval. */
type Row=Record<string,unknown>;
type Env=AmazonCredentials&{AMAZON_SP_API_SELLER_ID?:string};
type Deps={
 readSeller?:typeof readAmazonSellerListingsDirect;
 token?:typeof getAmazonAccessToken;
 fetch?:typeof fetch;
};
const HOST="https://sellingpartnerapi-eu.amazon.com";
const MARKET="APJ6JRA9NG5V4";
const SKU=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const SELLER=/^[A-Z0-9]{8,30}$/;
const TYPE=/^[A-Z][A-Z0-9_]{1,79}$/;
const ASIN=/^[A-Z0-9]{10}$/;
const KEY=/^[a-z][a-z0-9_]{0,119}$/;
const FIELDS=["gpsr_manufacturer_reference","dsa_responsible_party_address",
 "gpsr_safety_attestation","compliance_media"] as const;
const MAX_BYTES=2_000_000;
const FLAGS={read_only:true,provider_mutations:0,can_publish:false,
 manufacturer_verified:false,eu_responsible_person_verified:false,
 account_health_approved:false,gpsr_compliance_proven:false,
 ptd_partial_validation_performed:false,schema_checksum_verified:false,
 channable_writer_unchanged:true} as const;
function obj(x:unknown):Row{return x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Row:{};}
function fail(status:string,sku:string):Row{
 return {ok:false,status,sku,fields:[],...FLAGS};
}
function safeSchemaUrl(value:unknown):string|null{
 if(typeof value!=="string"||value.length>4096)return null;
 let u:URL;try{u=new URL(value);}catch{return null;}
 if(u.protocol!=="https:"||u.port||u.username||u.password||u.hash||
  !(/(^|\.)amazonaws\.com$/.test(u.hostname)||/(^|\.)amazon\.com$/.test(u.hostname)))
   return null;
 return u.toString();
}
async function readJson(url:string,token:string|null,fetcher:typeof fetch,isSchema:boolean):Promise<Row|null>{
 let response:Response;
 try{response=await fetcher(url,{
  method:"GET",headers:token?{"x-amz-access-token":token,Accept:"application/json"}:{Accept:"application/json"},
  redirect:"manual",signal:AbortSignal.timeout(20000)
 });}catch{return null;}
 if(response.status!==200)return null;
 if(!isSchema&&!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type")??""))
  return null;
 const len=response.headers.get("content-length");
 if(len&&(!/^\d+$/.test(len)||Number(len)>MAX_BYTES))return null;
 if(!response.body)return null;
 const reader=response.body.getReader();
 const decoder=new TextDecoder("utf-8",{fatal:true});
 let size=0,raw="";
 try{
  while(true){
   const chunk=await reader.read();
   if(chunk.done)break;
   size+=chunk.value.byteLength;
   if(size>MAX_BYTES){void reader.cancel().catch(()=>{});return null;}
   raw+=decoder.decode(chunk.value,{stream:true});
  }
  raw+=decoder.decode();
  const val=JSON.parse(raw);
  return val!==null&&typeof val==="object"&&!Array.isArray(val)?val as Row:null;
 }catch{return null;}finally{reader.releaseLock();}
}
/** Return only schema KEY paths; never schema enum/default/example/description,
 * because Amazon can include seller-specific email addresses or RP names. */
function paths(root:unknown):string[]{
 const found:string[]=[];
 const seen=new Set<object>();
 function walk(x:unknown,prefix:string,depth:number){
  if(depth>5||!x||typeof x!=="object"||Array.isArray(x)||seen.has(x))return;
  seen.add(x);
  const node=obj(x);
  const props=obj(node.properties);
  for(const [key,val]of Object.entries(props)){
   if(!KEY.test(key)||found.length>=36)continue;
   const path=prefix?prefix+"."+key:key;
   found.push(path);walk(val,path,depth+1);
  }
  if(node.items)walk(node.items,prefix,depth+1);
 }
 walk(root,"",0);
 return found;
}
export async function readExistingItGpsrPtd(raw:unknown,env:Env,deps:Deps={}):Promise<Row>{
 const q=obj(raw);
 if(Object.keys(q).length!==1||typeof q.sku!=="string"||
    !SKU.test(q.sku)||q.sku.trim()!==q.sku||q.sku.startsWith("KANGOL_"))
  throw Error("amazon_existing_gpsr_ptd_invalid_request");
 const sku=q.sku;
 const seller=env.AMAZON_SP_API_SELLER_ID;
 if(typeof seller!=="string"||!SELLER.test(seller))
  return fail("SELLER_CONFIG_UNVERIFIED",sku);
 let current:Row;
 try{current=obj(await(deps.readSeller??readAmazonSellerListingsDirect)({marketplace:"IT",skus:[sku]},env));}
 catch{return fail("SELLER_READ_FAILED",sku);}
 if(current.ok!==true||current.read_only!==true||current.provider_mutations!==0||
   current.marketplace!=="IT"||!Array.isArray(current.results)||current.results.length!==1)
  return fail("SELLER_EVIDENCE_INCOMPLETE",sku);
 const listing=obj(current.results[0]);
 if(listing.sku!==sku||listing.state!=="PRESENT"||listing.identity_state!=="VERIFIED"||
   typeof listing.asin!=="string"||!ASIN.test(listing.asin)||
   typeof listing.product_type!=="string"||!TYPE.test(listing.product_type)||
   !Array.isArray(listing.statuses)||listing.statuses.includes("BUYABLE")||
   !Array.isArray(listing.issue_signals)||!listing.issue_signals.some(x=>{
     const i=obj(x);return i.code==="100632"&&i.severity==="ERROR";
   }))return fail("SELLER_NOT_CONFIRMED_EXISTING_GPSR_TARGET",sku);
 const productType=listing.product_type;
 let accessToken:string;
 try{accessToken=await(deps.token??getAmazonAccessToken)(env);}
 catch{return fail("AMAZON_AUTH_UNAVAILABLE",sku);}
 if(typeof accessToken!=="string"||!accessToken||accessToken.length>16384||
   /[\u0000-\u0020\u007f]/.test(accessToken))
  return fail("AMAZON_AUTH_UNAVAILABLE",sku);
 const fetcher=deps.fetch??fetch;
 const endpoint=new URL(HOST+"/definitions/2020-09-01/productTypes/"+productType);
 endpoint.searchParams.set("marketplaceIds",MARKET);
 endpoint.searchParams.set("sellerId",seller);
 endpoint.searchParams.set("productTypeVersion","LATEST");
 endpoint.searchParams.set("requirements","LISTING");
 endpoint.searchParams.set("requirementsEnforced","NOT_ENFORCED");
 endpoint.searchParams.set("locale","it_IT");
 const definition=await readJson(endpoint.toString(),accessToken,fetcher,false);
 if(!definition)return fail("PTD_METADATA_UNAVAILABLE",sku);
 const link=obj(obj(definition.schema).link);
 const schemaUrl=safeSchemaUrl(link.resource);
 const version=obj(definition.productTypeVersion);
 if(definition.productType!==productType||
    definition.requirements!=="LISTING"||
    definition.requirementsEnforced!=="NOT_ENFORCED"||
    !Array.isArray(definition.marketplaceIds)||definition.marketplaceIds.length!==1||
    definition.marketplaceIds[0]!==MARKET||link.verb!=="GET"||
    typeof obj(definition.schema).checksum!=="string"||
    !schemaUrl||version.latest!==true||typeof version.version!=="string")
  return fail("PTD_METADATA_IDENTITY_UNVERIFIED",sku);
 const schema=await readJson(schemaUrl,null,fetcher,true);
 if(!schema)return fail("PTD_SCHEMA_UNAVAILABLE",sku);
 const props=obj(schema.properties);
 if(!Object.keys(props).length)return fail("PTD_SCHEMA_STRUCTURE_UNVERIFIED",sku);
 const required=Array.isArray(schema.required)?schema.required.filter(z=>typeof z==="string"):[];
 const fields=FIELDS.map(name=>{
  const node=props[name];
  return {name,available:node!==undefined,
   direct_required:required.includes(name),
   nested_property_paths:node!==undefined?paths(node):[]};
 });
 return {ok:true,status:"GPSR_PTD_SCHEMA_INSPECTED",sku,asin:listing.asin,
  product_type:productType,marketplace:"IT",
  schema_version:version.version,
  ptd_requirements:"LISTING",ptd_requirements_enforced:"NOT_ENFORCED",
  fields,provider_raw_schema_exposed:false,
  properties_not_in_schema_are_not_proven_ineligible:true,
  fields_present_do_not_prove_legal_compliance:true,...FLAGS};
}
