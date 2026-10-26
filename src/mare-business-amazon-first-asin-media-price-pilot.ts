import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { shopifyGraphQL } from "./index.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";
import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";

/** Single real product SKU/ASIN proof of concept: image + B2C price only.
 * It never writes inventory, storefront, GPSR, or another marketplace.
 * A validated Amazon PATCH is accepted for asynchronous catalog processing,
 * never treated as proof of a BUYABLE listing.
 */
type Row=Record<string,unknown>;
type Env=AmazonCredentials & MareBusinessShopifyEnv & {
  AMAZON_SP_API_SELLER_ID?:string;
  AMAZON_OFFER_PREVIEW_ENABLED?:string;
};
export type Dependencies={
  sellerReader?:typeof readAmazonSellerListingsDirect;
  shopifyReader?:typeof shopifyGraphQL;
  token?:typeof getAmazonAccessToken;
  fetch?:typeof fetch;
};
const HOST="https://sellingpartnerapi-eu.amazon.com";
const MARKET_ID="APJ6JRA9NG5V4";
const SKU="4B12_PLAYNEW_D2045_39_EU";
const ASIN="B0HPBKM8SL";
const VARIANT_ID="gid://shopify/ProductVariant/54713971048789";
const PRODUCT_ID="gid://shopify/Product/11523332047189";
const SELLER_RE=/^[A-Z0-9]{8,30}$/;
const REQUEST_ID=/^[A-Za-z0-9._:-]{4,160}$/;
const BODY_MAX=65536;
const QUERY=`query PatchPhotoPrice($id:ID!){
  productVariant(id:$id){
    id sku price compareAtPrice inventoryQuantity
    product{
      id title vendor status productType
      media(first:1){nodes{mediaContentType ... on MediaImage {
        image{url width height}
      }}}
    }
  }
}`;
function obj(v:unknown):Row{
  return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};
}
function bad(reason:string):Row{return {
  ok:false,status:"BLOCKED_FIRST_ASIN_MEDIA_PRICE_PILOT",reason,
  provider_write_attempted:false,price_updated_verified:false,
  image_updated_verified:false,buyable_verified:false,
  inventory_mutated:false,shopify_mutated:false,channable_mutated:false
};}
function validate(input:unknown):boolean{
  const o=obj(input);
  if(!input||typeof input!=="object"||Array.isArray(input)||
     !(Object.getPrototypeOf(input)===Object.prototype||Object.getPrototypeOf(input)===null))
    return false;
  if(Reflect.ownKeys(input).length!==3)return false;
  for(const [k,v] of Object.entries({marketplace:"IT",sku:SKU,asin:ASIN})){
    const d=Object.getOwnPropertyDescriptor(input,k);
    if(!d||!("value" in d)||d.value!==v||!d.enumerable)return false;
  }
  return Object.keys(o).length===3;
}
function issueCodes(v:unknown):string[]{
  if(!Array.isArray(v)||v.length>24)return["INVALID_ISSUES"];
  return [...new Set(v.map(x=>{
    const c=obj(x).code;
    return typeof c==="string"&&/^[A-Za-z0-9_.-]{1,70}$/.test(c)?c:"UNCLASSIFIED";
  }))];
}
async function jsonBounded(res:Response):Promise<Row>{
  if(!/^application\/json(?:\s*;|$)/i.test(res.headers.get("content-type")||""))
    throw new Error("image_price_pilot_content_type");
  const len=res.headers.get("content-length");
  if(len&&/^\d+$/.test(len)&&Number(len)>BODY_MAX)
    throw new Error("image_price_pilot_large_json");
  if(!res.body)throw new Error("image_price_pilot_missing_body");
  const reader=res.body.getReader();
  const decoder=new TextDecoder("utf-8",{fatal:true});
  let raw="",size=0;
  try{
    for(;;){
      const b=await reader.read();
      if(b.done)break;
      size+=b.value.byteLength;
      if(size>BODY_MAX)throw new Error("image_price_pilot_large_json");
      raw+=decoder.decode(b.value,{stream:true});
    }
    raw+=decoder.decode();
  }finally{reader.releaseLock();}
  let value:unknown;
  try{value=JSON.parse(raw);}catch{throw new Error("image_price_pilot_bad_json");}
  if(!value||typeof value!=="object"||Array.isArray(value))
    throw new Error("image_price_pilot_bad_json");
  return obj(value);
}
async function checkSeller(env:Env,dep:Dependencies):Promise<boolean>{
  const result=obj(await(dep.sellerReader??readAmazonSellerListingsDirect)(
    {marketplace:"IT",skus:[SKU]},env));
  const rows=Array.isArray(result.results)?result.results:[];
  const row=obj(rows[0]);
  return result.ok===true&&rows.length===1&&result.marketplace==="IT"&&
    row.sku===SKU&&row.state==="PRESENT"&&row.asin===ASIN&&
    row.product_type==="SHOES"&&row.identity_state==="VERIFIED"&&
    Array.isArray(row.statuses)&&row.statuses.includes("DISCOVERABLE")&&
    Array.isArray(row.issue_signals)&&row.issue_signals.length===0&&
    row.price_state==="UNKNOWN"&&row.reported_offer_count===0;
}
async function shopifyValues(env:Env,dep:Dependencies):Promise<{image:string,price:number}|null>{
  const data=obj(await(dep.shopifyReader??shopifyGraphQL)(env,QUERY,{id:VARIANT_ID}));
  const variant=obj(data.productVariant),product=obj(variant.product);
  const media=obj(product.media),first=Array.isArray(media.nodes)?obj(media.nodes[0]):{};
  const image=obj(first.image);
  const url=image.url;
  if(variant.id!==VARIANT_ID||variant.sku!==SKU||variant.price!=="179.10"||
     variant.compareAtPrice!=="199.00"||
     !Number.isSafeInteger(variant.inventoryQuantity)||
     (variant.inventoryQuantity as number)<1||
     product.id!==PRODUCT_ID||product.status!=="ACTIVE"||
     product.title!=="PlayNew D-2045 White/Bronze"||
     product.vendor!=="4B12"||product.productType!=="Sneakers"||
     first.mediaContentType!=="IMAGE"||
     typeof url!=="string"||url.length>512)return null;
  let parsed:URL;
  try{parsed=new URL(url);}catch{return null;}
  if(parsed.protocol!=="https:"||parsed.hostname!=="cdn.shopify.com"||
     !/^\/s\/files\/[0-9/]+\/files\/[a-z0-9-]+\.jpe?g$/i.test(parsed.pathname)||
     typeof image.width!=="number"||image.width<500||image.width>10000||
     typeof image.height!=="number"||image.height<500||image.height>10000)return null;
  return{image:url,price:179.10};
}
export async function patchFirstAmazonAsinImagePrice(
  input:unknown,env:Env,dep:Dependencies={}
):Promise<Row>{
  if(!validate(input))throw new Error("image_price_pilot_invalid_input");
  const seller=env.AMAZON_SP_API_SELLER_ID;
  if(!SELLER_RE.test(seller??"")||env.AMAZON_OFFER_PREVIEW_ENABLED!=="true")
    return bad("not_configured");
  if(!await checkSeller(env,dep))return bad("seller_or_offer_state_changed");
  const source=await shopifyValues(env,dep);
  if(!source)return bad("shopify_image_price_identity_unverified");
  const token=await(dep.token??getAmazonAccessToken)(env);
  if(typeof token!=="string"||!token||token.length>16000||
     /[\u0000-\u0020\u007f]/.test(token))throw new Error("image_price_pilot_auth");
  const base=HOST+"/listings/2021-08-01/items/"+
    encodeURIComponent(seller as string)+"/"+encodeURIComponent(SKU);
  const patches=[
    {op:"replace",path:"/attributes/main_product_image_locator",value:[{
      media_location:source.image,marketplace_id:MARKET_ID
    }]},
    {op:"replace",path:"/attributes/purchasable_offer",value:[{
      currency:"EUR",our_price:[{schedule:[{value_with_tax:source.price}]}],
      marketplace_id:MARKET_ID
    }]}
  ];
  const body=JSON.stringify({productType:"SHOES",patches});
  const transport=dep.fetch??fetch;
  const headers={"x-amz-access-token":token,"Content-Type":"application/json",Accept:"application/json"};
  const request=async(mode:"PREVIEW"|"LIVE"):Promise<{code:number,ack:Row}>=>{
    const url=new URL(base);
    url.searchParams.set("marketplaceIds",MARKET_ID);
    if(mode==="PREVIEW")url.searchParams.set("mode","VALIDATION_PREVIEW");
    let res:Response;
    try{
      res=await transport(url.toString(),{
        method:"PATCH",headers,body,redirect:"manual",
        signal:AbortSignal.timeout(20000)
      });
    }catch{throw new Error(mode==="LIVE"?
      "image_price_pilot_uncertain_delivery_reconcile":
      "image_price_pilot_preview_network_error");}
    if(res.status!==200){
      void res.body?.cancel().catch(()=>{});
      return{code:res.status,ack:{}};
    }
    try{return{code:res.status,ack:await jsonBounded(res)};}
    catch{throw new Error(mode==="LIVE"?
      "image_price_pilot_uncertain_ack_reconcile":
      "image_price_pilot_preview_invalid_ack");}
  };
  const preview=await request("PREVIEW");
  const issues=issueCodes(preview.ack.issues??[]);
  if(preview.code!==200||preview.ack.sku!==SKU||
     !["VALID","ACCEPTED"].includes(String(preview.ack.status))||
     issues.length>0)return bad("amazon_patch_validation_not_valid");
  // Independent fresh check immediately before modifying the real offer.
  if(!await checkSeller(env,dep))return bad("seller_identity_changed_after_preview");
  const submitted=await request("LIVE");
  const code=issueCodes(submitted.ack.issues??[]);
  if(submitted.code!==200||submitted.ack.sku!==SKU||
     submitted.ack.status!=="ACCEPTED"||code.length>0)
    return{ok:false,status:"PATCH_REJECTED_OR_UNKNOWN",provider_write_attempted:true,
      http_status:submitted.code,issue_codes:code,
      price_updated_verified:false,image_updated_verified:false,
      buyable_verified:false,inventory_mutated:false,channable_mutated:false};
  const submission=submitted.ack.submissionId;
  const ref=typeof submission==="string"&&REQUEST_ID.test(submission)?submission:null;
  return{ok:true,status:"IMAGE_AND_PRICE_PATCH_SUBMITTED_AWAITING_READBACK",
    sku:SKU,marketplace:"IT",asin:ASIN,
    submission_reference:ref,provider_write_attempted:true,
    submitted_price_eur:source.price,stock_unchanged:true,
    image_submitted:true,price_updated_verified:false,
    image_updated_verified:false,buyable_verified:false,
    inventory_mutated:false,shopify_mutated:false,channable_mutated:false,
    next_step:"VERIFY_ASIN_IMAGE_AND_SELLER_PRICE; CHANNABLE_REMAINS_STOCK_WRITER"};
}
