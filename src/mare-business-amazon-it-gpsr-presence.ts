import {getAmazonAccessToken,type AmazonCredentials} from "./amazon-auth.js";
import {readAmazonSellerListingsDirect} from "./mare-business-amazon-listings-direct.js";
import {shopifyGraphQL} from "./index.js";
import type {MareBusinessShopifyEnv} from "./mare-business-shopify.js";

type Row=Record<string,unknown>;
type Env=AmazonCredentials&MareBusinessShopifyEnv&{AMAZON_SP_API_SELLER_ID?:string};
type Deps={
  sellerRead?:typeof readAmazonSellerListingsDirect;
  readShopify?:typeof shopifyGraphQL;
  getAccessToken?:typeof getAmazonAccessToken;
  fetch?:typeof fetch;
};
const SKU=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const ASIN=/^[A-Z0-9]{10}$/;
const SELLER=/^[A-Z0-9]{8,30}$/;
const MARKET="APJ6JRA9NG5V4";
const MAX_BYTES=512000;
const SHOPIFY_QUERY='query ExistingGpsrStock($query:String!){productVariants(first:3,query:$query){nodes{sku inventoryQuantity product{status vendor}}}}';
function obj(v:unknown):Row{return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};}
function flag(v:unknown):string{
  return Array.isArray(v)&&v.length>0?"PRESENT_IN_SELLER_LISTING":
    v===undefined||v===null||Array.isArray(v)?"NOT_OBSERVED_IN_SELLER_LISTING":"UNVERIFIED";
}
export async function auditExistingAmazonItGpsrPresence(
 raw:unknown,env:Env,deps:Deps={}
):Promise<Row>{
 const arg=obj(raw);
 const keys=Object.keys(arg);
 const skus=arg.skus;
 if(keys.length!==1||!Array.isArray(skus)||skus.length<1||skus.length>3||
    skus.some(s=>typeof s!=="string"||!SKU.test(s)||s!==s.trim())||
    new Set(skus).size!==skus.length)
   throw Error("amazon_it_gpsr_audit_invalid_request");
 const noMutation={read_only:true,provider_mutations:0,can_publish:false,
   no_inventory_price_or_storefront_writes:true,
   channable_writer_unchanged:true,manufacturer_verified:false,
   responsible_person_verified:false,gpsr_compliant_proven:false};
 const sellerId=env.AMAZON_SP_API_SELLER_ID;
 if(typeof sellerId!=="string"||!SELLER.test(sellerId))
   return {ok:false,status:"BLOCKED_SELLER_CONFIG",...noMutation};
 const listing=obj(await (deps.sellerRead??readAmazonSellerListingsDirect)(
   {marketplace:"IT",skus},env));
 if(listing.ok!==true||listing.marketplace!=="IT"||
    listing.provider_mutations!==0||listing.read_only!==true||
    !Array.isArray(listing.results)||listing.results.length!==skus.length)
   return {ok:false,status:"BLOCKED_SELLER_EVIDENCE",...noMutation};
 let token:string;
 try{token=await(deps.getAccessToken??getAmazonAccessToken)(env);}
 catch{return {ok:false,status:"BLOCKED_AUTH",...noMutation};}
 if(typeof token!=="string"||!token||token.length>16000||/[\u0000-\u0020\u007f]/.test(token))
   return {ok:false,status:"BLOCKED_AUTH",...noMutation};
 const out=[];
 for(let i=0;i<skus.length;i++){
   const sku=skus[i] as string, seller=obj(listing.results[i]);
   if(seller.sku!==sku||seller.state!=="PRESENT"||
      seller.identity_state!=="VERIFIED"||seller.fulfillment_state!=="VERIFIED"||
      !Number.isSafeInteger(seller.current_fbm_quantity)||
      (seller.current_fbm_quantity as number)<=0||
      typeof seller.asin!=="string"||!ASIN.test(seller.asin)){
     out.push({sku,state:"BLOCKED_EXISTING_SELLER_IDENTITY_OR_STOCK"});
     continue;
   }
   let stock:Row;
   try{
     const s=obj(await (deps.readShopify??shopifyGraphQL)(
       env,SHOPIFY_QUERY,{query:"sku:"+sku}));
     const nodes=obj(s.productVariants).nodes;
     if(!Array.isArray(nodes)||nodes.length!==1)throw Error("ambiguous_sku");
     stock=obj(nodes[0]);
   }catch{
     out.push({sku,state:"BLOCKED_SHOPIFY_STOCK_UNVERIFIED"});
     continue;
   }
   const p=obj(stock.product);
   if(stock.sku!==sku||!Number.isSafeInteger(stock.inventoryQuantity)||
      (stock.inventoryQuantity as number)<=0||p.status!=="ACTIVE"){
     out.push({sku,state:"BLOCKED_SHOPIFY_STOCK_UNVERIFIED"});
     continue;
   }
   const url=new URL("https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/"+
     encodeURIComponent(sellerId)+"/"+encodeURIComponent(sku));
   url.searchParams.set("marketplaceIds",MARKET);
   url.searchParams.set("includedData","summaries,attributes,issues");
   let body:Row;
   try{
     const resp=await(deps.fetch??fetch)(url.toString(),{
       method:"GET",headers:{"x-amz-access-token":token,Accept:"application/json"},
       redirect:"manual",signal:AbortSignal.timeout(20000)});
     if(resp.status!==200||!/^application\/json(?:\s*;|$)/i.test(resp.headers.get("content-type")??""))
       throw Error("status");
     const raw=await resp.text();
     if(raw.length>MAX_BYTES)throw Error("large");
     body=obj(JSON.parse(raw));
   }catch{
     out.push({sku,state:"BLOCKED_AMAZON_ATTRIBUTES_UNVERIFIED"});
     continue;
   }
   const summary=Array.isArray(body.summaries)?
     body.summaries.map(obj).filter(v=>v.marketplaceId===MARKET):[];
   if(body.sku!==sku||summary.length!==1||summary[0].asin!==seller.asin){
     out.push({sku,state:"BLOCKED_AMAZON_ASIN_CONFLICT"});
     continue;
   }
   const attrs=obj(body.attributes);
   const signals=Array.isArray(seller.issue_signals)?
     seller.issue_signals.map(obj).map(v=>v.code).filter(x=>typeof x==="string"&&
       /^[A-Za-z0-9_-]{1,72}$/.test(x)).slice(0,32):[];
   out.push({sku,state:"EXISTING_STOCK_POSITIVE_NEEDS_GPSR_REVIEW",
     asin:seller.asin,amazon_product_type:seller.product_type,
     shopify_vendor:p.vendor,shopify_quantity:stock.inventoryQuantity,
     amazon_quantity:seller.current_fbm_quantity,
     issue_codes:signals,
     gpsr_attribute_observations:{
       gpsr_manufacturer_reference:flag(attrs.gpsr_manufacturer_reference),
       dsa_responsible_party_address:flag(attrs.dsa_responsible_party_address),
       gpsr_safety_attestation:flag(attrs.gpsr_safety_attestation),
       compliance_media:flag(attrs.compliance_media)
     },
     missing_in_response_is_not_absence_from_account_health:true,
     sku_level_not_authorized_to_patch:true});
 }
 return {ok:true,status:"GPSR_PRESENCE_AUDIT_ONLY",marketplace:"IT",
   requested:skus.length,results:out,...noMutation};
}
