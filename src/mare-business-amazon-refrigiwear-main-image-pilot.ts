import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { shopifyGraphQL } from "./index.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";
import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";

/** One-image-only Refrigiwear pilot. Never writes price, inventory or other fields. */
type Row=Record<string,unknown>;
type Env=AmazonCredentials & MareBusinessShopifyEnv & {
  AMAZON_SP_API_SELLER_ID?:string; AMAZON_OFFER_PREVIEW_ENABLED?:string;
};
export type ImagePilotDeps={sellerReader?:typeof readAmazonSellerListingsDirect;
  shopifyReader?:typeof shopifyGraphQL;token?:typeof getAmazonAccessToken;
  fetch?:typeof fetch};
const SKU="RFR_W53800_NY2303_E06107_S";
const ASIN="B0HPY8J51M";
const PRODUCT="gid://shopify/Product/10426204815701";
const VARIANT="gid://shopify/ProductVariant/52554538123605";
const MARKET="APJ6JRA9NG5V4";
const HOST="https://sellingpartnerapi-eu.amazon.com";
const QUERY=`query RfrImageOnly($id:ID!){productVariant(id:$id){
  id sku product{id title vendor status
    media(first:1){nodes{mediaContentType ... on MediaImage{image{url width height}}}}
  }
}}`;
function obj(v:unknown):Row{
  return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};
}
function blocked(reason:string):Row{return{ok:false,
  status:"BLOCKED_REFRIGIWEAR_IMAGE_ONLY",
  reason,provider_write_attempted:false,stock_unchanged:true,
  price_unchanged:true,channable_unchanged:true,
  image_verified:false,buyable_verified:false};}
async function sellerVerified(env:Env,dep:ImagePilotDeps):Promise<boolean>{
  const r=obj(await (dep.sellerReader??readAmazonSellerListingsDirect)(
    {marketplace:"IT",skus:[SKU]},env));
  const rows=Array.isArray(r.results)?r.results:[];
  const row=obj(rows[0]), issues=Array.isArray(row.issue_signals)?
    row.issue_signals.map(obj):[];
  return r.ok===true&&r.marketplace==="IT"&&rows.length===1&&
    row.sku===SKU&&row.state==="PRESENT"&&row.asin===ASIN&&
    row.product_type==="COAT"&&row.identity_state==="VERIFIED"&&
    issues.some(i=>i.code==="18320"&&i.severity==="ERROR")&&
    Array.isArray(row.statuses)&&!row.statuses.includes("BUYABLE");
}
async function mainPhoto(env:Env,dep:ImagePilotDeps):Promise<string|null>{
  const r=obj(await (dep.shopifyReader??shopifyGraphQL)(env,QUERY,{id:VARIANT}));
  const v=obj(r.productVariant),p=obj(v.product);
  const nodes=obj(p.media).nodes;
  const media=Array.isArray(nodes)?obj(nodes[0]):{};
  const image=obj(media.image),raw=image.url;
  if(v.id!==VARIANT||v.sku!==SKU||p.id!==PRODUCT||
    p.title!=="Braffy Jacket Green Lily"||p.vendor!=="Refrigiwear"||
    p.status!=="ACTIVE"||media.mediaContentType!=="IMAGE"||
    typeof raw!=="string"||raw.length>700||
    typeof image.width!=="number"||image.width<1000||image.width>10000||
    typeof image.height!=="number"||image.height<1000||image.height>10000)
    return null;
  let u:URL;
  try{u=new URL(raw);}catch{return null;}
  if(u.protocol!=="https:"||u.hostname!=="cdn.shopify.com"||
    !/^\/s\/files\/[0-9/]+\/files\/[A-Za-z0-9_-]+\.jpe?g$/.test(u.pathname)||
    (u.search&&!/^\?v=\d{1,15}$/.test(u.search))||
    u.hash)return null;
  return raw;
}
async function readJson(res:Response):Promise<Row>{
  if(res.status!==200)throw new Error("not_ok");
  if(!/^application\/json(?:;|$)/i.test(res.headers.get("content-type")??""))
    throw new Error("invalid_content_type");
  const len=res.headers.get("content-length");
  if(len&&/^\d+$/.test(len)&&Number(len)>65536)throw new Error("oversized");
  if(!res.body)throw new Error("missing_body");
  const reader=res.body.getReader(), parts:Uint8Array[]=[];
  let count=0;try{
    for(;;){const x=await reader.read();if(x.done)break;
      count+=x.value.byteLength;
      if(count>65536)throw new Error("oversized");
      parts.push(x.value);}
  }finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(count);let at=0;
  for(const p of parts){bytes.set(p,at);at+=p.byteLength;}
  let j:unknown;try{j=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}
  catch{throw new Error("invalid_json");}
  if(!j||typeof j!=="object"||Array.isArray(j))throw new Error("not_object");
  return obj(j);
}
export async function patchRefrigiwearMainImagePilot(
 input:unknown,env:Env,dep:ImagePilotDeps={}
):Promise<Row>{
  const q=obj(input);
  if(Object.keys(q).sort().join("|")!=="asin|marketplace|sku"||
    q.marketplace!=="IT"||q.sku!==SKU||q.asin!==ASIN)
    throw new Error("image_only_pilot_request_invalid");
  const seller=env.AMAZON_SP_API_SELLER_ID;
  if(typeof seller!=="string"||!/^[A-Z0-9]{8,30}$/.test(seller)||
     env.AMAZON_OFFER_PREVIEW_ENABLED!=="true")return blocked("not_configured");
  if(!await sellerVerified(env,dep))return blocked("seller_issue_identity_changed");
  const image=await mainPhoto(env,dep);
  if(!image)return blocked("shopify_main_photo_unverified");
  const token=await(dep.token??getAmazonAccessToken)(env);
  if(typeof token!=="string"||token.length<1||token.length>16000||
     /[\u0000-\u0020\u007f]/.test(token))throw Error("auth_invalid");
  const base=HOST+"/listings/2021-08-01/items/"+
    encodeURIComponent(seller)+"/"+encodeURIComponent(SKU);
  const body=JSON.stringify({productType:"COAT",patches:[{
    op:"replace",path:"/attributes/main_product_image_locator",
    value:[{media_location:image,marketplace_id:MARKET}]}]});
  const fetcher=dep.fetch??fetch;
  const request=async(preview:boolean):Promise<Row>=>{
    const u=new URL(base);u.searchParams.set("marketplaceIds",MARKET);
    if(preview)u.searchParams.set("mode","VALIDATION_PREVIEW");
    let res:Response;
    try{res=await fetcher(u.toString(),{method:"PATCH",body,
      headers:{"x-amz-access-token":token,"Content-Type":"application/json",Accept:"application/json"},
      redirect:"manual",signal:AbortSignal.timeout(20000)});}
    catch{throw Error(preview?"image_preview_network_error":"uncertain_image_live_write_reconcile");}
    try{return await readJson(res);}
    catch{if(!preview)throw Error("uncertain_image_live_response_reconcile");return {};}
  };
  const preview=await request(true);
  const issues=Array.isArray(preview.issues)?preview.issues.map(obj):[{}];
  if(preview.sku!==SKU||!["VALID","ACCEPTED"].includes(String(preview.status))||
     issues.some(x=>x.severity==="ERROR"))return blocked("image_preview_invalid");
  if(!await sellerVerified(env,dep))return blocked("seller_changed_after_preview");
  const submitted=await request(false);
  const errors=Array.isArray(submitted.issues)?submitted.issues.map(obj):[{}];
  if(submitted.sku!==SKU||submitted.status!=="ACCEPTED"||
     errors.some(x=>x.severity==="ERROR"))
    return{ok:false,status:"IMAGE_PATCH_REJECTED",provider_write_attempted:true,
      price_unchanged:true,stock_unchanged:true,
      image_verified:false,buyable_verified:false};
  const ref=submitted.submissionId;
  return{ok:true,status:"IMAGE_PATCH_SUBMITTED_AWAITING_READBACK",
    sku:SKU,asin:ASIN,marketplace:"IT",submission_reference:
      typeof ref==="string"&&/^[A-Za-z0-9._:-]{1,160}$/.test(ref)?ref:null,
    provider_write_attempted:true,price_unchanged:true,stock_unchanged:true,
    channable_unchanged:true,image_verified:false,buyable_verified:false};
}
