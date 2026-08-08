import { shopifyGraphQL, type Env as ShopifyEnv } from "./index.js";

type JsonObject = Record<string, unknown>;
type Mc2Back40Env = ShopifyEnv & {
  SHOPIFY_TOKENS_KV?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  };
};
type Preflight = {
  currentAppInstallation: { accessScopes: Array<{ handle: string }> };
  collectionByHandle: { id: string; title: string; handle: string } | null;
  codeDiscountNodeByCode: { id: string } | null;
};
type GithubOidcClaims = {
  iss?: string; aud?: string | string[]; sub?: string; repository?: string;
  repository_owner?: string; ref?: string; event_name?: string; actor?: string;
  exp?: number; iat?: number; nbf?: number;
};

const PATH = "/internal/ops/mc2back40-2026-08-08";
const CODE = "MC2BACK40";
const COLLECTION_HANDLE = "mc2-saint-barth";
const LOCK_KEY = "ops:mc2back40:2026-08-08:created";
const GITHUB_REPOSITORY = "devidlabel/devidlabel-ai-assistant-backend";
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const OIDC_AUDIENCE = "devidlabel-mc2back40-2026-08-08";
const EXECUTION_REF = "refs/heads/ops/execute-mc2back40-discount-2026-08-08";
const EXECUTION_SUBJECT = `repo:${GITHUB_REPOSITORY}:ref:${EXECUTION_REF}`;

function json(body: JsonObject, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
function b64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded); const bytes = new Uint8Array(binary.length);
  for (let i=0;i<binary.length;i+=1) bytes[i]=binary.charCodeAt(i); return bytes;
}
function b64json<T>(value: string): T { return JSON.parse(new TextDecoder().decode(b64(value))) as T; }

async function loadPreflight(env: Mc2Back40Env): Promise<Preflight> {
  return shopifyGraphQL<Preflight>(env, `
    query Mc2Back40Preflight($handle: String!, $code: String!) {
      currentAppInstallation { accessScopes { handle } }
      collectionByHandle(handle: $handle) { id title handle }
      codeDiscountNodeByCode(code: $code) { id }
    }
  `, { handle: COLLECTION_HANDLE, code: CODE });
}
async function isOidc(token: string): Promise<boolean> {
  const parts=token.split("."); if(parts.length!==3 || token.length<100 || token.length>12000) return false;
  try {
    const header=b64json<{alg?:string;kid?:string}>(parts[0]); const c=b64json<GithubOidcClaims>(parts[1]);
    if(header.alg!=="RS256" || !header.kid) return false;
    const now=Math.floor(Date.now()/1000); const aud=Array.isArray(c.aud)?c.aud.includes(OIDC_AUDIENCE):c.aud===OIDC_AUDIENCE;
    if(c.iss!==OIDC_ISSUER || !aud || c.repository!==GITHUB_REPOSITORY || c.repository_owner!=="devidlabel" || c.ref!==EXECUTION_REF || c.sub!==EXECUTION_SUBJECT || c.event_name!=="push" || c.actor!=="devidlabel" || typeof c.exp!=="number" || c.exp<now-30 || c.exp>now+900 || typeof c.iat!=="number" || c.iat>now+30 || c.iat<now-900 || (typeof c.nbf==="number" && c.nbf>now+30)) return false;
    const cfgRes=await fetch(`${OIDC_ISSUER}/.well-known/openid-configuration`,{headers:{Accept:"application/json"}}); if(!cfgRes.ok) return false;
    const cfg=await cfgRes.json() as {issuer?:string;jwks_uri?:string}; if(cfg.issuer!==OIDC_ISSUER || !cfg.jwks_uri) return false;
    const u=new URL(cfg.jwks_uri); if(u.protocol!=="https:" || u.hostname!=="token.actions.githubusercontent.com") return false;
    const jwksRes=await fetch(u.toString(),{headers:{Accept:"application/json"}}); if(!jwksRes.ok) return false;
    const jwks=await jwksRes.json() as {keys?:Array<JsonWebKey & {kid?:string;alg?:string;use?:string}>};
    const jwk=(jwks.keys||[]).find(k=>k.kid===header.kid && (!k.alg||k.alg==="RS256") && (!k.use||k.use==="sig")); if(!jwk) return false;
    const key=await crypto.subtle.importKey("jwk",jwk,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
    const signed=new TextEncoder().encode(`${parts[0]}.${parts[1]}`); const sig=b64(parts[2]);
    return crypto.subtle.verify({name:"RSASSA-PKCS1-v1_5"},key,Uint8Array.from(sig).buffer,Uint8Array.from(signed).buffer);
  } catch { return false; }
}
async function authorized(request: Request): Promise<boolean> {
  const h=request.headers.get("Authorization")||""; return h.startsWith("Bearer ") && isOidc(h.slice(7).trim());
}

export async function handleMc2Back40Once(request: Request, env: Mc2Back40Env): Promise<Response | null> {
  const url=new URL(request.url); if(url.pathname!==PATH) return null;
  if(request.method==="GET") {
    try {
      const p=await loadPreflight(env); const scopes=p.currentAppInstallation.accessScopes.map(s=>s.handle);
      return json({ok:true,operation:"mc2back40",phase:"read_only_preflight",write_discounts:scopes.includes("write_discounts"),read_discounts:scopes.includes("read_discounts"),collection:p.collectionByHandle,code:CODE,code_exists:Boolean(p.codeDiscountNodeByCode),mutation_performed:false});
    } catch(e) { return json({ok:false,operation:"mc2back40",phase:"read_only_preflight",mutation_performed:false,reason:e instanceof Error?e.message.slice(0,240):"preflight_failed"},502); }
  }
  if(request.method!=="POST") return json({ok:false,operation:"mc2back40",reason:"method_not_allowed"},405);
  if(!(await authorized(request))) return json({ok:false,operation:"mc2back40",reason:"not_found"},404);
  const p=await loadPreflight(env); const scopes=p.currentAppInstallation.accessScopes.map(s=>s.handle);
  if(!scopes.includes("write_discounts")) return json({ok:false,operation:"mc2back40",reason:"write_discounts_not_granted"},412);
  if(!p.collectionByHandle) return json({ok:false,operation:"mc2back40",reason:"mc2_collection_not_found"},412);
  if(p.codeDiscountNodeByCode) return json({ok:true,operation:"mc2back40",phase:"existing",code:CODE,code_exists:true,created_now:false,discount_node_id:p.codeDiscountNodeByCode.id});
  if(env.SHOPIFY_TOKENS_KV && await env.SHOPIFY_TOKENS_KV.get(LOCK_KEY)) return json({ok:false,operation:"mc2back40",reason:"one_shot_lock_present"},409);

  const created=await shopifyGraphQL<{discountCodeBasicCreate:{codeDiscountNode:{id:string}|null;userErrors:Array<{field?:string[]|null;code?:string|null;message:string}>}}>(env,`
    mutation CreateMc2Back40($input: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $input) { codeDiscountNode { id } userErrors { field code message } }
    }
  `,{input:{
    title:"MC2 Saint Barth | MC2BACK40 | Customer Reactivation | Agosto 2026",
    code:CODE,
    startsAt:"2026-08-09T22:00:00Z",
    endsAt:"2026-08-16T21:59:59Z",
    context:{all:"ALL"},
    customerGets:{value:{percentage:0.40},items:{collections:{add:[p.collectionByHandle.id]}}},
    minimumRequirement:{quantity:{greaterThanOrEqualToQuantity:"1"}},
    appliesOncePerCustomer:true,
    combinesWith:{orderDiscounts:false,productDiscounts:false,shippingDiscounts:false},
  }});
  const errors=created.discountCodeBasicCreate.userErrors||[];
  if(errors.length || !created.discountCodeBasicCreate.codeDiscountNode) return json({ok:false,operation:"mc2back40",phase:"create",code:CODE,user_errors:errors,reason:"shopify_discount_create_failed"},422);
  const nodeId=created.discountCodeBasicCreate.codeDiscountNode.id;
  if(env.SHOPIFY_TOKENS_KV) await env.SHOPIFY_TOKENS_KV.put(LOCK_KEY,JSON.stringify({node_id:nodeId,created_at:new Date().toISOString()}),{expirationTtl:60*60*24*30});
  return json({ok:true,operation:"mc2back40",phase:"created",code:CODE,code_exists:true,created_now:true,discount_node_id:nodeId,collection:p.collectionByHandle,settings:{percentage_off:40,minimum_quantity:1,starts_at_rome:"2026-08-10 00:00",ends_at_rome:"2026-08-16 23:59:59",applies_once_per_customer:true,combines_with_other_discounts:false}});
}
