import { shopifyGraphQL, type Env as ShopifyEnv } from "./index.js";

type JsonObject = Record<string, unknown>;
type Env = ShopifyEnv & { [key: string]: unknown };
type Claims = { iss?: string; aud?: string | string[]; sub?: string; repository?: string; repository_owner?: string; ref?: string; event_name?: string; exp?: number; iat?: number; nbf?: number };
type ProductRow = { id?: string; title?: string; handle?: string; vendor?: string; status?: string; variants?: { nodes?: Array<{ price?: string; compareAtPrice?: string | null; inventoryQuantity?: number; availableForSale?: boolean }> } };

type ProductCheck = { id: string; title: string; handle: string; vendor: string; stock: number; price: number; compareAt: number | null; fullPrice: boolean };

const PATH = "/internal/ops/sneak10-discount-2026-09-01";
const CODE = "SNEAK10";
const TITLE = "SNEAK10 | Sneakers New Season | Settembre 2026";
const STARTS_AT = "2026-09-01T14:45:00Z";
const ENDS_AT = "2026-09-10T21:59:59Z";
const APPROVAL = "CREATE SNEAK10 SEP01";
const REPOSITORY = "devidlabel/devidlabel-ai-assistant-backend";
const EXECUTION_REF = "refs/heads/ops/execute-sneak10-discount-2026-09-01";
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const OIDC_AUDIENCE = "devidlabel-sneak10-discount-2026-09-01";
const OIDC_SUBJECT = `repo:${REPOSITORY}:ref:${EXECUTION_REF}`;

const PRODUCTS = [
  { handle: "4b12-hyper-u-3027-white-black-hyper-u3027", vendor: "4B12", gender: "uomo" },
  { handle: "puraai-sneaker-101-101-vintage-eclipse-pui101101-vintageeclipse", vendor: "Puraai", gender: "uomo" },
  { handle: "flower-mountain-sneaker-yamano-3-man-suede-nylon-cream-brown-taupe-2017816-01-1e98", vendor: "Flower Mountain", gender: "uomo" },
  { handle: "4b12-play-new-d-2045-white-bronze-playnew-d2045", vendor: "4B12", gender: "donna" },
  { handle: "puraai-sneaker-601-601-xs-ice-skating-pui601601-xsice-skating", vendor: "Puraai", gender: "donna" },
  { handle: "flower-mountain-sneaker-yamabushi-woman-suede-nylon-cognac-taupe-pink-2019510-03-1d26", vendor: "Flower Mountain", gender: "donna" },
] as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
}
function normalize(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }
function b64(v: string): Uint8Array { const n=v.replace(/-/g,"+").replace(/_/g,"/"); const p=n.padEnd(Math.ceil(n.length/4)*4,"="); const b=atob(p); const bytes=new Uint8Array(b.length); for(let i=0;i<b.length;i+=1) bytes[i]=b.charCodeAt(i); return bytes; }
function decode<T>(v: string): T { return JSON.parse(new TextDecoder().decode(b64(v))) as T; }
function vendorKey(v:string):string { return v.toLowerCase().replace(/[^a-z0-9]/g,""); }

async function authorized(request: Request): Promise<boolean> {
  const h=request.headers.get("Authorization")||""; if(!h.startsWith("Bearer ")) return false;
  const token=h.slice(7).trim(); const parts=token.split("."); if(parts.length!==3||token.length<100||token.length>12000) return false;
  try {
    const header=decode<{alg?:string;kid?:string}>(parts[0]); const c=decode<Claims>(parts[1]); if(header.alg!=="RS256"||!header.kid) return false;
    const now=Math.floor(Date.now()/1000); const aud=Array.isArray(c.aud)?c.aud.includes(OIDC_AUDIENCE):c.aud===OIDC_AUDIENCE;
    if(c.iss!==OIDC_ISSUER||!aud||c.repository!==REPOSITORY||c.repository_owner!=="devidlabel"||c.ref!==EXECUTION_REF||c.sub!==OIDC_SUBJECT||c.event_name!=="push"||typeof c.exp!=="number"||c.exp<now-30||c.exp>now+900||typeof c.iat!=="number"||c.iat>now+30||c.iat<now-900||(typeof c.nbf==="number"&&c.nbf>now+30)) return false;
    const cfgRes=await fetch(`${OIDC_ISSUER}/.well-known/openid-configuration`,{headers:{Accept:"application/json"}}); if(!cfgRes.ok) return false;
    const cfg=await cfgRes.json() as {issuer?:string;jwks_uri?:string}; if(cfg.issuer!==OIDC_ISSUER||!cfg.jwks_uri) return false;
    const u=new URL(cfg.jwks_uri); if(u.protocol!=="https:"||u.hostname!=="token.actions.githubusercontent.com") return false;
    const jwksRes=await fetch(u.toString(),{headers:{Accept:"application/json"}}); if(!jwksRes.ok) return false;
    const jwks=await jwksRes.json() as {keys?:Array<JsonWebKey&{kid?:string;alg?:string;use?:string}>};
    const jwk=(jwks.keys||[]).find((k)=>k.kid===header.kid&&(!k.alg||k.alg==="RS256")&&(!k.use||k.use==="sig")); if(!jwk) return false;
    const key=await crypto.subtle.importKey("jwk",jwk,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
    return crypto.subtle.verify({name:"RSASSA-PKCS1-v1_5"},key,Uint8Array.from(b64(parts[2])).buffer,Uint8Array.from(new TextEncoder().encode(`${parts[0]}.${parts[1]}`)).buffer);
  } catch { return false; }
}

async function loadProduct(env: Env, handle: string, expectedVendor: string): Promise<ProductCheck> {
  const data=await shopifyGraphQL<{products?:{nodes?:ProductRow[]}}>(env,`query Sneak10Product($query:String!){products(first:2,query:$query){nodes{id title handle vendor status variants(first:50){nodes{price compareAtPrice inventoryQuantity availableForSale}}}}}`,{query:`handle:${handle}`});
  const row=(data.products?.nodes||[]).find((p)=>normalize(p.handle)===handle); if(!row||!row.id) throw new Error(`product_not_found:${handle}`);
  if(vendorKey(normalize(row.vendor))!==vendorKey(expectedVendor)) throw new Error(`vendor_mismatch:${handle}`);
  if(normalize(row.status).toUpperCase()!=="ACTIVE") throw new Error(`product_not_active:${handle}`);
  const variants=row.variants?.nodes||[]; const available=variants.filter((v)=>v.availableForSale===true&&Number(v.inventoryQuantity||0)>0);
  const stock=available.reduce((sum,v)=>sum+Number(v.inventoryQuantity||0),0); const prices=available.map((v)=>Number(v.price||0)).filter((n)=>n>0); const compares=available.map((v)=>Number(v.compareAtPrice||0)).filter((n)=>n>0);
  const price=prices.length?Math.min(...prices):0; const compareAt=compares.length?Math.max(...compares):null; const fullPrice=!compareAt||compareAt<=price+0.001;
  if(stock<=0||price<=0) throw new Error(`product_not_in_stock:${handle}`); if(!fullPrice) throw new Error(`product_not_full_price:${handle}`);
  return {id:row.id,title:normalize(row.title),handle,vendor:normalize(row.vendor),stock,price,compareAt,fullPrice};
}

async function preflight(env: Env): Promise<JsonObject> {
  const base=await shopifyGraphQL<{currentAppInstallation:{accessScopes:Array<{handle:string}>};codeDiscountNodeByCode:{id:string}|null}>(env,`query Sneak10Preflight($code:String!){currentAppInstallation{accessScopes{handle}} codeDiscountNodeByCode(code:$code){id}}`,{code:CODE});
  const scopes=base.currentAppInstallation.accessScopes.map((s)=>s.handle); const products=await Promise.all(PRODUCTS.map((p)=>loadProduct(env,p.handle,p.vendor)));
  return {ok:true,mutation_performed:false,write_discounts:scopes.includes("write_discounts"),read_discounts:scopes.includes("read_discounts"),code:CODE,code_exists:Boolean(base.codeDiscountNodeByCode),discount_node_id:base.codeDiscountNodeByCode?.id||null,starts_at:STARTS_AT,ends_at:ENDS_AT,percentage_off:10,applies_once_per_customer:true,combines_with_other_discounts:false,products};
}

async function execute(env: Env): Promise<JsonObject> {
  const check=await preflight(env); if(check.write_discounts!==true) throw new Error("write_discounts_not_granted"); if(check.code_exists===true) return {...check,mutation_performed:false,idempotent_replay:true,status:"existing"};
  const products=check.products as ProductCheck[]; const ids=products.map((p)=>p.id); if(ids.length!==6) throw new Error("unexpected_product_count");
  const created=await shopifyGraphQL<{discountCodeBasicCreate:{codeDiscountNode:{id:string}|null;userErrors:Array<{field?:string[]|null;code?:string|null;message:string}>}}>(env,`mutation CreateSneak10($input:DiscountCodeBasicInput!){discountCodeBasicCreate(basicCodeDiscount:$input){codeDiscountNode{id} userErrors{field code message}}}`,{input:{
    title:TITLE,
    code:CODE,
    startsAt:STARTS_AT,
    endsAt:ENDS_AT,
    context:{all:"ALL"},
    customerGets:{value:{percentage:0.10},items:{products:{productsToAdd:ids}}},
    minimumRequirement:{quantity:{greaterThanOrEqualToQuantity:"1"}},
    appliesOncePerCustomer:true,
    combinesWith:{orderDiscounts:false,productDiscounts:false,shippingDiscounts:false},
  }});
  const errors=created.discountCodeBasicCreate.userErrors||[]; const node=created.discountCodeBasicCreate.codeDiscountNode; if(errors.length||!node) return {ok:false,mutation_performed:false,code:CODE,reason:"shopify_discount_create_failed",user_errors:errors};
  const readback=await preflight(env); if(readback.code_exists!==true) throw new Error("discount_readback_failed");
  return {...readback,mutation_performed:true,created_now:true,status:"created",discount_node_id:node.id};
}

export async function handleSneak10Discount010926(request:Request,env:Env):Promise<Response|null> {
  const url=new URL(request.url); if(url.pathname!==PATH) return null;
  if(!await authorized(request)) return json({ok:false,error:"unauthorized"},401);
  try {
    if(request.method==="GET") return json(await preflight(env));
    if(request.method!=="POST") return json({ok:false,error:"method_not_allowed"},405);
    let body:JsonObject={}; try{body=await request.json() as JsonObject;}catch{return json({ok:false,error:"invalid_json"},400);}
    if(normalize(body.approval)!==APPROVAL) return json({ok:false,error:"approval_required"},409);
    const result=await execute(env); return json(result,result.ok===false?422:200);
  } catch(error) { return json({ok:false,error:error instanceof Error?error.message:"sneak10_discount_failed"},500); }
}
