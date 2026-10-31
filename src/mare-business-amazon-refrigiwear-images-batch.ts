import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { shopifyGraphQL } from "./index.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";
import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";

/** Bounded media-only catalog repair. Never touches prices, quantities,
 * Shopify, Channable or product attribute values other than main image.
 * Previews the exact PATCH, rechecks seller identity, and stops on ambiguity.
 */
type Row=Record<string,unknown>;
type Env=AmazonCredentials&MareBusinessShopifyEnv&{
  AMAZON_SP_API_SELLER_ID?:string;AMAZON_OFFER_PREVIEW_ENABLED?:string;
};
type Item={sku:string;asin:string};
export type Deps={
 sellerReader?:typeof readAmazonSellerListingsDirect;
 shopifyReader?:typeof shopifyGraphQL;
 token?:typeof getAmazonAccessToken;
 fetch?:typeof fetch;
};
const HOST="https://sellingpartnerapi-eu.amazon.com";
const MARKET="APJ6JRA9NG5V4";
const TYPES=new Set(["COAT","HAT","SHIRT","BACKPACK","SWEATER","SWEATSHIRT","SCARF"]);
const QUERY=`query RfrMediaOnly($query:String!){
 productVariants(first:5,query:$query){
  nodes{id sku product{id title vendor status
   media(first:1){nodes{mediaContentType ... on MediaImage{image{url width height}}}}
  }}
  pageInfo{hasNextPage}
 }
}`;
function obj(v:unknown):Row{
 return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};
}
function validate(raw:unknown):Item[]{
 const x=obj(raw),list=x.items;
 if(Object.keys(x).sort().join("|")!=="items|marketplace"||x.marketplace!=="IT"||
    !Array.isArray(list)||list.length<1||list.length>8)throw Error("rfr_media_batch_invalid");
 const seen=new Set<string>(),items:Item[]=[];
 for(const v of list){
  const i=obj(v);
  if(Object.keys(i).sort().join("|")!=="asin|sku"||
    typeof i.sku!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_]{10,119}$/.test(i.sku)||
    !i.sku.startsWith("RFR_")||
    typeof i.asin!=="string"||!/^[A-Z0-9]{10}$/.test(i.asin)||
    seen.has(i.sku)||seen.has(i.asin))throw Error("rfr_media_batch_identity_invalid");
  seen.add(i.sku);seen.add(i.asin);
  items.push({sku:i.sku,asin:i.asin});
 }
 return items;
}
function blocked(item:Item,reason:string):Row{
 return {sku:item.sku,asin:item.asin,status:"BLOCKED_IMAGE_ONLY",
  reason,write_attempted:false,image_verified:false};
}
async function seller(item:Item,env:Env,dep:Deps):Promise<string|null>{
 const r=obj(await(dep.sellerReader??readAmazonSellerListingsDirect)(
   {marketplace:"IT",skus:[item.sku]},env));
 const list=Array.isArray(r.results)?r.results:[];
 const row=obj(list[0]),issue=Array.isArray(row.issue_signals)?
   row.issue_signals.map(obj):[];
 if(r.ok!==true||r.marketplace!=="IT"||list.length!==1||
    row.sku!==item.sku||row.state!=="PRESENT"||row.asin!==item.asin||
    row.identity_state!=="VERIFIED"||
    !TYPES.has(String(row.product_type))||
    !Array.isArray(row.statuses)||row.statuses.includes("BUYABLE")||
    !issue.some(x=>x.code==="18320"&&x.severity==="ERROR"))return null;
 return row.product_type as string;
}
async function photo(item:Item,env:Env,dep:Deps):Promise<string|null>{
 const data=obj(await(dep.shopifyReader??shopifyGraphQL)(
   env,QUERY,{query:"sku:"+item.sku}));
 const variants=obj(data.productVariants),pi=obj(variants.pageInfo);
 const nodes=variants.nodes;
 if(!Array.isArray(nodes)||nodes.length!==1||pi.hasNextPage!==false)return null;
 const v=obj(nodes[0]),p=obj(v.product),med=obj(p.media);
 const images=Array.isArray(med.nodes)?med.nodes:[];
 const media=obj(images[0]),im=obj(media.image);
 const url=im.url;
 if(typeof v.id!=="string"||!/^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,24}$/.test(v.id)||
    v.sku!==item.sku||
    typeof p.id!=="string"||!/^gid:\/\/shopify\/Product\/[1-9]\d{0,24}$/.test(p.id)||
    p.vendor!=="Refrigiwear"||p.status!=="ACTIVE"||
    typeof p.title!=="string"||p.title.length<3||p.title.length>200||
    media.mediaContentType!=="IMAGE"||
    typeof url!=="string"||url.length>700||
    !Number.isInteger(im.width)||!Number.isInteger(im.height)||
    Number(im.width)<1000||Number(im.height)<1000||
    Number(im.width)>10000||Number(im.height)>10000)return null;
 let u:URL;try{u=new URL(url);}catch{return null;}
 if(u.protocol!=="https:"||u.hostname!=="cdn.shopify.com"||
    !/^\/s\/files\/[0-9/]+\/files\/[A-Za-z0-9_-]+\.jpe?g$/.test(u.pathname)||
    (u.search&&!/^\?v=\d{1,15}$/.test(u.search))||u.hash)return null;
 return url;
}
async function boundedJson(res:Response):Promise<Row>{
 if(res.status!==200)return {};
 if(!/^application\/json(?:;|$)/i.test(res.headers.get("content-type")??""))
   throw Error("invalid_json_type");
 const len=res.headers.get("content-length");
 if(len&&/^\d+$/.test(len)&&Number(len)>65536)throw Error("too_large");
 if(!res.body)throw Error("missing_body");
 const reader=res.body.getReader(),parts:Uint8Array[]=[];
 let size=0;
 try{for(;;){const x=await reader.read();if(x.done)break;
   size+=x.value.byteLength;if(size>65536)throw Error("too_large");
   parts.push(x.value);}}
 finally{await reader.cancel().catch(()=>{});}
 const merged=new Uint8Array(size);let offset=0;
 for(const part of parts){merged.set(part,offset);offset+=part.byteLength;}
 const raw=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(merged));
 if(!raw||typeof raw!=="object"||Array.isArray(raw))throw Error("bad_json");
 return obj(raw);
}
async function patch(item:Item,type:string,url:string,token:string,
 preview:boolean,env:Env,dep:Deps):Promise<Row>{
 const s=env.AMAZON_SP_API_SELLER_ID!;
 const target=new URL(HOST+"/listings/2021-08-01/items/"+
  encodeURIComponent(s)+"/"+encodeURIComponent(item.sku));
 target.searchParams.set("marketplaceIds",MARKET);
 if(preview)target.searchParams.set("mode","VALIDATION_PREVIEW");
 const body=JSON.stringify({productType:type,patches:[{
  op:"replace",path:"/attributes/main_product_image_locator",
  value:[{media_location:url,marketplace_id:MARKET}],
 }]});
 let res:Response;
 try{res=await(dep.fetch??fetch)(target.toString(),{
   method:"PATCH",headers:{"x-amz-access-token":token,
     "Content-Type":"application/json",Accept:"application/json"},
   body,redirect:"manual",signal:AbortSignal.timeout(20000)});
 }catch{throw Error(preview?"PREVIEW_NETWORK":"UNCERTAIN_LIVE_TRANSPORT");}
 try{return await boundedJson(res);}
 catch{throw Error(preview?"PREVIEW_BAD_ACK":"UNCERTAIN_LIVE_ACK");}
}
export async function patchRefrigiwearImagesBatch(
 raw:unknown,env:Env,dep:Deps={}
):Promise<Row>{
 const items=validate(raw),out:Row[]=[];
 const sellerId=env.AMAZON_SP_API_SELLER_ID;
 if(typeof sellerId!=="string"||!/^[A-Z0-9]{8,30}$/.test(sellerId)||
    env.AMAZON_OFFER_PREVIEW_ENABLED!=="true")
  return{ok:false,status:"BLOCKED_IMAGE_BATCH",reason:"not_configured",provider_write_attempted:false};
 const token=await(dep.token??getAmazonAccessToken)(env);
 if(typeof token!=="string"||!token||token.length>16000||
    /[\u0000-\u0020\u007f]/.test(token))throw Error("rfr_image_batch_auth");
 for(const item of items){
  try{
   const type=await seller(item,env,dep);
   if(!type){out.push(blocked(item,"seller_issue_or_identity_unverified"));continue;}
   const url=await photo(item,env,dep);
   if(!url){out.push(blocked(item,"shopify_unique_main_photo_unverified"));continue;}
   const preview=await patch(item,type,url,token,true,env,dep);
   const issues=Array.isArray(preview.issues)?preview.issues.map(obj):[{}];
   if(preview.sku!==item.sku||
      !["VALID","ACCEPTED"].includes(String(preview.status))||
      issues.some(q=>q.severity==="ERROR")){
    out.push(blocked(item,"amazon_image_patch_preview_invalid"));continue;}
   if(await seller(item,env,dep)!==type){
    out.push(blocked(item,"seller_changed_after_preview"));continue;}
   const sent=await patch(item,type,url,token,false,env,dep);
   const errors=Array.isArray(sent.issues)?sent.issues.map(obj):[{}];
   if(sent.sku!==item.sku||sent.status!=="ACCEPTED"||
      errors.some(q=>q.severity==="ERROR"))
     return{ok:false,status:"IMAGE_BATCH_STOP_AFTER_LIVE_REJECTION",
      processed:out,stop_at:item.sku,provider_write_attempted:true,
      image_verified:false,price_unchanged:true,stock_unchanged:true,
      channable_unchanged:true};
   const id=sent.submissionId;
   out.push({sku:item.sku,asin:item.asin,
    status:"IMAGE_PATCH_SUBMITTED_AWAITING_READBACK",
    submission_reference:typeof id==="string"&&
      /^[A-Za-z0-9._:-]{1,160}$/.test(id)?id:null,
    write_attempted:true,image_verified:false});
  }catch(e){
   const message=e instanceof Error?e.message:"UNKNOWN";
   if(message.startsWith("UNCERTAIN_LIVE"))
    throw Error("UNCERTAIN_IMAGE_BATCH_STOP_AND_RECONCILE_"+item.sku);
   return{ok:false,status:"IMAGE_BATCH_STOP_UNVERIFIED",stop_at:item.sku,
     reason:message.slice(0,100),processed:out,
     price_unchanged:true,stock_unchanged:true,channable_unchanged:true};
  }
 }
 return{ok:true,status:"IMAGE_BATCH_SUBMITTED_AND_BLOCKED_MIXED",
   marketplace:"IT",processed:out,
   live_submissions:out.filter(x=>x.write_attempted===true).length,
   pending_readback:out.filter(x=>x.write_attempted===true).length,
   image_verified:false,buyable_verified:false,price_unchanged:true,
   stock_unchanged:true,channable_unchanged:true};
}
