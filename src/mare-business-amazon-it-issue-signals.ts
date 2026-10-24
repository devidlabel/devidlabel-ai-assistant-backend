import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";

/** Merchant-private bounded read-only issue wording signals for already existing
 * Amazon IT seller SKUs. Never exposes raw provider messages, account contacts,
 * issue URLs, listing attributes, signed documents or arbitrary text. Wording
 * categories are clues for Seller Support, NOT proof of approval or compliance. */
type Row=Record<string,unknown>;
type Env=AmazonCredentials&{AMAZON_SP_API_SELLER_ID?:string};
type Deps={
 sellerRead?:typeof readAmazonSellerListingsDirect;
 getAccessToken?:typeof getAmazonAccessToken;
 fetch?:typeof fetch;
};
const SKU=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const SELLER=/^[A-Z0-9]{8,30}$/;
const ASIN=/^[A-Z0-9]{10}$/;
const MARKET="APJ6JRA9NG5V4";
const MAX_BYTES=256000;
const CODE=/^[A-Z0-9_]{1,72}$/;
const ATTR=/^[A-Za-z][A-Za-z0-9_]{0,119}$/;
const FLAGS={read_only:true,provider_mutations:0,can_publish:false,
 manufacturer_verified:false,responsible_person_verified:false,
 price_ceiling_verified:false,brand_approval_proven:false,
 channable_writer_unchanged:true} as const;
function obj(x:unknown):Row{return x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Row:{};}
function categorySignals(x:unknown):string[]{
 if(typeof x!=="string")return [];
 // Do NOT return x: it can contain account data or personal information.
 const words:Array<[string,RegExp]>=[
  ["APPROVAL_WORDING",/(?:approv(?:al|e|azione)|authori[sz]|autorizza|permission|permesso|genehmigung|autorisation)/i],
  ["GPSR_WORDING",/(?:\bgpsr\b|general product safety|sicurezza generale dei prodotti)/i],
  ["RESPONSIBLE_PERSON_WORDING",/(?:responsible person|responsabile|verantwortliche person|personne responsable)/i],
  ["MANUFACTURER_WORDING",/(?:manufacturer|fabbricante|produttore|hersteller|fabricant)/i],
  ["PRICE_BOUND_WORDING",/(?:maximum price|minimum price|prezzo massimo|prezzo minimo|maximalpreis|prix maximal)/i],
  ["MEDIA_WORDING",/(?:\bimage\b|\bimages\b|immagine|immagini|media_locator|image url|image link)/i],
  ["CATALOG_IDENTITY_WORDING",/(?:\be?an\b|\basin\b|\bupc\b|identifi(?:er|cat)|\bbrand\b|\bmarca\b)/i]
 ];
 return words.filter(([,re])=>re.test(x)).map(([name])=>name);
}
async function readJsonBounded(response:Response):Promise<Row|null>{
 if(response.status!==200||!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type")||""))return null;
 const len=response.headers.get("content-length");
 if(len&&(!/^\d+$/.test(len)||Number(len)>MAX_BYTES))return null;
 const reader=response.body?.getReader();if(!reader)return null;
 const decoder=new TextDecoder("utf-8",{fatal:true});
 let size=0,text="";
 try{
  while(true){
   const chunk=await reader.read();
   if(chunk.done)break;
   size+=chunk.value.byteLength;
   if(size>MAX_BYTES){void reader.cancel().catch(()=>{});return null;}
   text+=decoder.decode(chunk.value,{stream:true});
  }
  text+=decoder.decode();
  const parsed=JSON.parse(text);return Object.keys(obj(parsed)).length?obj(parsed):null;
 }catch{return null;}finally{reader.releaseLock();}
}
export async function readAmazonItExistingIssueSignals(raw:unknown,env:Env,deps:Deps={}):Promise<Row>{
 const x=obj(raw),ks=Object.keys(x),skus=x.skus;
 if(ks.length!==1||!Array.isArray(skus)||skus.length<1||skus.length>3||
    skus.some(z=>typeof z!=="string"||z!==z.trim()||!SKU.test(z))||
    new Set(skus).size!==skus.length)
   throw Error("amazon_it_issue_signals_invalid_request");
 const seller=env.AMAZON_SP_API_SELLER_ID;
 if(typeof seller!=="string"||!SELLER.test(seller))
  return {ok:false,status:"SELLER_CONFIG_UNVERIFIED",results:[],...FLAGS};
 let existing:Row;
 try{existing=obj(await(deps.sellerRead??readAmazonSellerListingsDirect)({marketplace:"IT",skus},env));}
 catch{return {ok:false,status:"SELLER_READ_FAILED",results:[],...FLAGS};}
 if(existing.ok!==true||existing.read_only!==true||existing.provider_mutations!==0||
    existing.marketplace!=="IT"||!Array.isArray(existing.results)||
    existing.results.length!==skus.length)
  return {ok:false,status:"SELLER_EVIDENCE_INCOMPLETE",results:[],...FLAGS};
 const bySku=new Map<string,Row>();
 for(const rawItem of existing.results){
  const a=obj(rawItem);
  if(typeof a.sku!=="string"||!skus.includes(a.sku)||bySku.has(a.sku))
    return {ok:false,status:"SELLER_IDENTITY_AMBIGUOUS",results:[],...FLAGS};
  bySku.set(a.sku,a);
 }
 const eligible=skus.filter((sku:string)=>{
  const a=bySku.get(sku)!;
  return a.state==="PRESENT"&&a.identity_state==="VERIFIED"&&
   typeof a.asin==="string"&&ASIN.test(a.asin)&&
   Array.isArray(a.statuses)&&!a.statuses.includes("BUYABLE");
 });
 if(!eligible.length)return {ok:true,status:"NO_CONFIRMED_EXISTING_INACTIVE_TARGETS",
  results:skus.map((sku:string)=>({sku,state:"SKIPPED_UNVERIFIED_OR_BUYABLE"})),...FLAGS};
 let token:string;
 try{token=await(deps.getAccessToken??getAmazonAccessToken)(env);}
 catch{return {ok:false,status:"AMAZON_AUTH_UNAVAILABLE",results:[],...FLAGS};}
 if(typeof token!=="string"||!token||token.length>16384||/[\u0000-\u0020\u007f]/.test(token))
  return {ok:false,status:"AMAZON_AUTH_UNAVAILABLE",results:[],...FLAGS};
 const results:Row[]=[];
 for(const sku of skus){
  const a=bySku.get(sku)!;
  if(!eligible.includes(sku)){results.push({sku,state:"SKIPPED_UNVERIFIED_OR_BUYABLE"});continue;}
  const url=new URL("https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/"+encodeURIComponent(seller)+"/"+encodeURIComponent(sku));
  url.searchParams.set("marketplaceIds",MARKET);
  url.searchParams.set("includedData","summaries,issues");
  url.searchParams.set("issueLocale","en_US");
  let body:Row|null=null;
  try{
   const resp=await(deps.fetch??fetch)(url.toString(),{method:"GET",
    headers:{"x-amz-access-token":token,Accept:"application/json"},
    redirect:"manual",signal:AbortSignal.timeout(20000)});
   body=await readJsonBounded(resp);
  }catch{/* fail closed, do not include provider response or URL in errors */}
  if(!body){results.push({sku,state:"AMAZON_ISSUE_READ_UNVERIFIED"});continue;}
  const summaries=Array.isArray(body.summaries)?body.summaries.map(obj).filter(z=>z.marketplaceId===MARKET):[];
  if(body.sku!==sku||summaries.length!==1||summaries[0].asin!==a.asin||
    !Array.isArray(body.issues)||body.issues.length>80){
   results.push({sku,state:"IDENTITY_OR_ISSUES_UNVERIFIED"});continue;
  }
  const codes=Array.isArray(a.issue_signals)?a.issue_signals.map(obj)
    .filter(z=>z.severity==="ERROR").map(z=>z.code):[];
  const issues=body.issues.map(obj).filter(z=>!z.marketplaceId||z.marketplaceId===MARKET)
   .filter(z=>z.severity==="ERROR"&&typeof z.code==="string"&&
     CODE.test(z.code)&&codes.includes(z.code)).slice(0,32)
   .map(z=>({
     code:z.code,
     wording_signals:categorySignals(z.message),
     attributes:Array.isArray(z.attributeNames)?z.attributeNames.filter(v=>typeof v==="string"&&ATTR.test(v)).slice(0,6):[],
     enforcement_actions:Array.isArray(z.enforcements?.value)?[]:[]
   }));
  results.push({sku,asin:a.asin,state:"EXISTING_NONBUYABLE_ISSUE_WORDING_SIGNALS",
    error_count:issues.length,issues,raw_messages_exposed:false,
    wording_is_not_root_cause_or_approval_proof:true});
 }
 return {ok:true,status:"ISSUE_WORDING_SIGNALS_ONLY",marketplace:"IT",
  requested:skus.length,results,...FLAGS};
}
