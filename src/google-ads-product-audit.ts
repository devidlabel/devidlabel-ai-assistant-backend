import { shopifyGraphQL } from "./index";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ADS_BASE = "https://googleads.googleapis.com";
const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
const DEFAULT_GOOGLE_ADS_API_VERSION = "v25";

type JsonObject = Record<string, unknown>;
type ServiceAccountCredentials = { client_email: string; private_key: string; private_key_id?: string; token_uri?: string };
type ProductAuditEnv = {
  GOOGLE_ADS_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
  GOOGLE_ADS_REFRESH_TOKEN?: string;
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  GOOGLE_ADS_CUSTOMER_ID?: string;
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;
  GOOGLE_ADS_API_VERSION?: string;
  GOOGLE_ADS_REPORT_ACCESS_TOKEN?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
  DAILY_PULSE_ACCESS_TOKEN?: string;
  SHOPIFY_SHOP_DOMAIN?: string;
  SHOPIFY_API_VERSION?: string;
  SHOPIFY_ADMIN_ACCESS_TOKEN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_TOKENS_KV?: unknown;
};

type ProductAccumulator = {
  product_item_id: string;
  google_title: string;
  google_brand: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversion_value: number;
  all_conversions: number;
  all_conversion_value: number;
  campaigns: Set<string>;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
function normalize(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function digits(value: unknown): string { return normalize(value).replace(/-/g, "").replace(/\s/g, ""); }
function numberValue(value: unknown): number { if (typeof value === "number" && Number.isFinite(value)) return value; const n = Number(value); return Number.isFinite(n) ? n : 0; }
function micros(value: unknown): number { return numberValue(value) / 1_000_000; }
function roundMoney(value: number): number { return Math.round((value + Number.EPSILON) * 100) / 100; }
function timingSafeEqualText(left: string, right: string): boolean { if (!left || !right || left.length !== right.length) return false; let diff = 0; for (let i=0;i<left.length;i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i); return diff === 0; }
function reportTokens(env: ProductAuditEnv): string[] { return [env.GOOGLE_ADS_REPORT_ACCESS_TOKEN, env.KLAVIYO_REPORT_ACCESS_TOKEN, env.DAILY_PULSE_ACCESS_TOKEN].map(normalize).filter(Boolean); }
function isAuthorized(request: Request, env: ProductAuditEnv): boolean { const header = request.headers.get("Authorization") || ""; const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : ""; return reportTokens(env).some(token => timingSafeEqualText(supplied, token)); }
function apiVersion(env: ProductAuditEnv): string { const configured = normalize(env.GOOGLE_ADS_API_VERSION); return /^v\d+$/.test(configured) ? configured : DEFAULT_GOOGLE_ADS_API_VERSION; }
function validDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T12:00:00Z`).getTime()); }
function daysInclusive(start: string, end: string): number { return Math.floor((new Date(`${end}T12:00:00Z`).getTime() - new Date(`${start}T12:00:00Z`).getTime()) / 86_400_000) + 1; }
function base64Url(bytes: Uint8Array): string { let binary=""; for (const b of bytes) binary += String.fromCharCode(b); return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }
function base64UrlJson(value: JsonObject): string { return base64Url(new TextEncoder().encode(JSON.stringify(value))); }
function pemPkcs8Buffer(pem: string): ArrayBuffer { const b64=pem.replace(/-----BEGIN PRIVATE KEY-----/g,"").replace(/-----END PRIVATE KEY-----/g,"").replace(/\s+/g,""); if(!b64) throw new Error("empty_google_private_key"); const bin=atob(b64); const buffer=new ArrayBuffer(bin.length); const bytes=new Uint8Array(buffer); for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i); return buffer; }
function serviceAccountCredentials(env: ProductAuditEnv): ServiceAccountCredentials | null { const raw=normalize(env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON); if(!raw) return null; try { const p=JSON.parse(raw) as JsonObject; const email=normalize(p.client_email); const key=normalize(p.private_key); if(!email||!key) return null; const kid=normalize(p.private_key_id); const token=normalize(p.token_uri); return {client_email:email,private_key:key,...(kid?{private_key_id:kid}:{}),...(token?{token_uri:token}:{})}; } catch { return null; } }
async function serviceAccountAccessToken(credentials: ServiceAccountCredentials): Promise<string> { const now=Math.floor(Date.now()/1000); const header:JsonObject={alg:"RS256",typ:"JWT",...(credentials.private_key_id?{kid:credentials.private_key_id}:{})}; const claims:JsonObject={iss:credentials.client_email,scope:GOOGLE_ADS_SCOPE,aud:credentials.token_uri||GOOGLE_OAUTH_TOKEN_URL,iat:now,exp:now+3600}; const unsigned=`${base64UrlJson(header)}.${base64UrlJson(claims)}`; const key=await crypto.subtle.importKey("pkcs8",pemPkcs8Buffer(credentials.private_key),{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]); const sig=await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,new TextEncoder().encode(unsigned)); const assertion=`${unsigned}.${base64Url(new Uint8Array(sig))}`; const response=await fetch(credentials.token_uri||GOOGLE_OAUTH_TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion})}); const payload=await response.json() as JsonObject; if(!response.ok||typeof payload.access_token!=="string") throw Object.assign(new Error(`google_service_account_oauth_${response.status}`),{status:response.status}); return payload.access_token; }
async function userOauthAccessToken(env: ProductAuditEnv): Promise<string> { const response=await fetch(GOOGLE_OAUTH_TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:normalize(env.GOOGLE_ADS_CLIENT_ID),client_secret:normalize(env.GOOGLE_ADS_CLIENT_SECRET),refresh_token:normalize(env.GOOGLE_ADS_REFRESH_TOKEN),grant_type:"refresh_token"})}); const payload=await response.json() as JsonObject; if(!response.ok||typeof payload.access_token!=="string") throw Object.assign(new Error(`google_oauth_${response.status}`),{status:response.status}); return payload.access_token; }
async function oauthAccessToken(env: ProductAuditEnv): Promise<string> { const credentials=serviceAccountCredentials(env); return credentials ? serviceAccountAccessToken(credentials) : userOauthAccessToken(env); }
async function googleAdsSearchStream(env: ProductAuditEnv, query: string): Promise<JsonObject[]> { const customerId=digits(env.GOOGLE_ADS_CUSTOMER_ID); const accessToken=await oauthAccessToken(env); const headers:Record<string,string>={Authorization:`Bearer ${accessToken}`,"developer-token":normalize(env.GOOGLE_ADS_DEVELOPER_TOKEN),"Content-Type":"application/json",Accept:"application/json"}; const login=digits(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID); if(login) headers["login-customer-id"]=login; const response=await fetch(`${GOOGLE_ADS_BASE}/${apiVersion(env)}/customers/${customerId}/googleAds:searchStream`,{method:"POST",headers,body:JSON.stringify({query})}); const payload=await response.json() as unknown; if(!response.ok) { const detail=JSON.stringify(payload).slice(0,1000); throw Object.assign(new Error(`google_ads_api_${response.status}:${detail}`),{status:response.status}); } const batches=Array.isArray(payload)?payload:[payload]; const rows:JsonObject[]=[]; for(const batch of batches){ if(!batch||typeof batch!=="object"||Array.isArray(batch)) continue; const results=(batch as JsonObject).results; if(Array.isArray(results)) for(const row of results) if(row&&typeof row==="object"&&!Array.isArray(row)) rows.push(row as JsonObject); } return rows; }
function parseShopifyVariantId(itemId: string): string | null { const match=itemId.match(/shopify_(?:[a-z]{2,3})_(\d+)_(\d+)$/i); return match ? match[2] : null; }
async function fetchShopifyVariants(env: ProductAuditEnv, variantIds: string[]): Promise<Map<string,{sku:string|null,title:string|null,product_title:string|null,vendor:string|null,handle:string|null}>> { const result=new Map<string,{sku:string|null,title:string|null,product_title:string|null,vendor:string|null,handle:string|null}>(); const unique=[...new Set(variantIds.filter(Boolean))]; for(let i=0;i<unique.length;i+=100){ const ids=unique.slice(i,i+100).map(id=>`gid://shopify/ProductVariant/${id}`); const data=await shopifyGraphQL<{nodes:Array<{id?:string;sku?:string|null;title?:string|null;product?:{title?:string|null;vendor?:string|null;handle?:string|null}|null}|null>}>(env as any,`query GoogleAdsProductSkuMap($ids:[ID!]!){nodes(ids:$ids){... on ProductVariant{id sku title product{title vendor handle}}}}`,{ids}); for(const node of data.nodes||[]){ if(!node?.id) continue; const id=node.id.split("/").pop()||""; result.set(id,{sku:node.sku||null,title:node.title||null,product_title:node.product?.title||null,vendor:node.product?.vendor||null,handle:node.product?.handle||null}); } } return result; }

export async function handleGoogleAdsProductAuditRequest(request: Request, env: ProductAuditEnv): Promise<Response | null> {
  const url=new URL(request.url);
  if(url.pathname!=="/internal/google-ads/products") return null;
  if(request.method!=="GET") return jsonResponse({ok:false,error:"method_not_allowed"},405);
  if(!isAuthorized(request,env)) return jsonResponse({ok:false,error:"unauthorized"},401);
  const start=(url.searchParams.get("start")||"").trim(); const end=(url.searchParams.get("end")||"").trim();
  if(!validDate(start)||!validDate(end)||start>end||daysInclusive(start,end)>31) return jsonResponse({ok:false,error:"invalid_date_range"},400);
  const minSpend=Math.max(0,Number(url.searchParams.get("min_spend")||"0")||0);
  try {
    const query=`SELECT segments.product_item_id, segments.product_title, segments.product_brand, campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.all_conversions, metrics.all_conversions_value FROM shopping_performance_view WHERE segments.date BETWEEN '${start}' AND '${end}' ORDER BY metrics.cost_micros DESC`;
    const rows=await googleAdsSearchStream(env,query);
    const map=new Map<string,ProductAccumulator>();
    for(const row of rows){ const segments=row.segments&&typeof row.segments==="object"?row.segments as JsonObject:{}; const metrics=row.metrics&&typeof row.metrics==="object"?row.metrics as JsonObject:{}; const campaign=row.campaign&&typeof row.campaign==="object"?row.campaign as JsonObject:{}; const itemId=normalize(segments.productItemId); if(!itemId) continue; let acc=map.get(itemId); if(!acc){ acc={product_item_id:itemId,google_title:normalize(segments.productTitle),google_brand:normalize(segments.productBrand),spend:0,impressions:0,clicks:0,conversions:0,conversion_value:0,all_conversions:0,all_conversion_value:0,campaigns:new Set<string>()}; map.set(itemId,acc); } acc.spend+=micros(metrics.costMicros); acc.impressions+=numberValue(metrics.impressions); acc.clicks+=numberValue(metrics.clicks); acc.conversions+=numberValue(metrics.conversions); acc.conversion_value+=numberValue(metrics.conversionsValue); acc.all_conversions+=numberValue(metrics.allConversions); acc.all_conversion_value+=numberValue(metrics.allConversionsValue); const name=normalize(campaign.name); if(name) acc.campaigns.add(name); }
    const variantIds=[...map.keys()].map(parseShopifyVariantId).filter((v):v is string=>Boolean(v)); let skuMap=new Map<string,{sku:string|null,title:string|null,product_title:string|null,vendor:string|null,handle:string|null}>(); let skuWarning:string|null=null; try{ skuMap=await fetchShopifyVariants(env,variantIds); }catch(error){ skuWarning=error instanceof Error?error.message:"shopify_sku_mapping_failed"; }
    const products=[...map.values()].map(acc=>{ const variantId=parseShopifyVariantId(acc.product_item_id); const shopify=variantId?skuMap.get(variantId):undefined; const spend=roundMoney(acc.spend); return {sku:shopify?.sku||null,product_item_id:acc.product_item_id,shopify_variant_id:variantId,product_title:shopify?.product_title||acc.google_title||null,variant_title:shopify?.title||null,brand:shopify?.vendor||acc.google_brand||null,handle:shopify?.handle||null,spend,impressions:acc.impressions,clicks:acc.clicks,cpc:acc.clicks?roundMoney(acc.spend/acc.clicks):0,conversions:acc.conversions,conversion_value:roundMoney(acc.conversion_value),roas:acc.spend?acc.conversion_value/acc.spend:0,all_conversions:acc.all_conversions,all_conversion_value:roundMoney(acc.all_conversion_value),campaigns:[...acc.campaigns].sort()}; }).filter(row=>row.spend>=minSpend).sort((a,b)=>b.spend-a.spend);
    const burners=products.filter(row=>row.spend>0&&Math.abs(row.conversions)<1e-9&&Math.abs(row.conversion_value)<0.005);
    return jsonResponse({ok:true,service:"google_ads_product_audit",generated_at:new Date().toISOString(),range:{start,end,days:daysInclusive(start,end)},definition:"burner = spend > 0, primary conversions = 0, primary conversion value = 0",sku_mapping_warning:skuWarning,summary:{products_with_spend:products.filter(p=>p.spend>0).length,total_product_spend:roundMoney(products.reduce((s,p)=>s+p.spend,0)),burner_count:burners.length,burner_spend:roundMoney(burners.reduce((s,p)=>s+p.spend,0)),burner_spend_ge_10:roundMoney(burners.filter(p=>p.spend>=10).reduce((s,p)=>s+p.spend,0)),burner_count_ge_10:burners.filter(p=>p.spend>=10).length},burners,products});
  } catch(error){ const candidate=error as Error&{status?:number}; return jsonResponse({ok:false,error:"google_ads_product_audit_failed",message:candidate.message,status:candidate.status||null},candidate.status&&candidate.status>=400&&candidate.status<600?candidate.status:502); }
}
