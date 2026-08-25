import { shopifyGraphQL } from "./index.js";
import { createKlaviyoCampaignDraft, type KlaviyoOperationsEnv } from "./mare-operations-klaviyo.js";
import { updateKlaviyoCampaignDraft } from "./mare-operations-klaviyo-update.js";

type JsonObject = Record<string, unknown>;
type Env = KlaviyoOperationsEnv & { [key: string]: unknown };
type Claims = { iss?: string; aud?: string | string[]; sub?: string; repository?: string; repository_owner?: string; ref?: string; event_name?: string; exp?: number; iat?: number; nbf?: number };

const PATH = "/internal/ops/sprayground-peak-2026-08-24";
const API = "https://a.klaviyo.com";
const REVISION = "2026-07-15";
const REPOSITORY = "devidlabel/devidlabel-ai-assistant-backend";
const EXECUTION_REF = "refs/heads/ops/execute-sprayground-peak-2026-08-24";
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const OIDC_AUDIENCE = "devidlabel-sprayground-peak-2026-08-24";
const OIDC_SUBJECT = `repo:${REPOSITORY}:ref:${EXECUTION_REF}`;
const APPROVAL = "EXECUTE SPRAYGROUND PEAK PLAN";

const HIGH_INTENT = "ShWyu9";
const CHECKOUT_SOURCE = "RpnuJf";
const BUYER_SOURCE = "WsPZgJ";
const CAMPAIGN_27 = "01KZ61XC0M402Q4P1C8ZCEXFMW";
const CAMPAIGN_03 = "01KZ61Y2BEV506ZGKXZKKD7PX2";
const CAMPAIGN_10 = "01KZ61Z03B1C67S1C809FZHDCT";
const COLLECTION_URL = "https://devidlabel.com/collections/bts-26-sprayground";
const HOME_URL = "https://devidlabel.com/";
const LOGO = "https://d3k81ch9hvuctc.cloudfront.net/company/V6B2sR/images/1558f3d0-2cf5-4937-920f-7293a7950f98.png";

function normalize(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function obj(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function response(body: JsonObject, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } }); }
function b64(value: string): Uint8Array { const normalized = value.replace(/-/g, "+").replace(/_/g, "/"); const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="); const binary = atob(padded); const bytes = new Uint8Array(binary.length); for (let i=0;i<binary.length;i+=1) bytes[i]=binary.charCodeAt(i); return bytes; }
function decode<T>(value: string): T { return JSON.parse(new TextDecoder().decode(b64(value))) as T; }
function sleep(ms:number):Promise<void>{return new Promise((resolve)=>setTimeout(resolve,ms));}

async function authorized(request: Request): Promise<boolean> {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return false;
  const token = authorization.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 3 || token.length < 100 || token.length > 12000) return false;
  try {
    const header = decode<{ alg?: string; kid?: string }>(parts[0]);
    const claims = decode<Claims>(parts[1]);
    if (header.alg !== "RS256" || !header.kid) return false;
    const now = Math.floor(Date.now()/1000);
    const audience = Array.isArray(claims.aud) ? claims.aud.includes(OIDC_AUDIENCE) : claims.aud === OIDC_AUDIENCE;
    if (claims.iss !== OIDC_ISSUER || !audience || claims.repository !== REPOSITORY || claims.repository_owner !== "devidlabel" || claims.ref !== EXECUTION_REF || claims.sub !== OIDC_SUBJECT || claims.event_name !== "push" || typeof claims.exp !== "number" || claims.exp < now-30 || claims.exp > now+900 || typeof claims.iat !== "number" || claims.iat > now+30 || claims.iat < now-900 || (typeof claims.nbf === "number" && claims.nbf > now+30)) return false;
    const configResponse = await fetch(`${OIDC_ISSUER}/.well-known/openid-configuration`);
    if (!configResponse.ok) return false;
    const config = await configResponse.json() as { issuer?: string; jwks_uri?: string };
    if (config.issuer !== OIDC_ISSUER || !config.jwks_uri) return false;
    const jwksUrl = new URL(config.jwks_uri);
    if (jwksUrl.protocol !== "https:" || jwksUrl.hostname !== "token.actions.githubusercontent.com") return false;
    const jwksResponse = await fetch(jwksUrl.toString(), { headers: { Accept: "application/json" } });
    if (!jwksResponse.ok) return false;
    const jwks = await jwksResponse.json() as { keys?: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }> };
    const jwk = (jwks.keys || []).find((item) => item.kid === header.kid && (!item.alg || item.alg === "RS256") && (!item.use || item.use === "sig"));
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk, { name:"RSASSA-PKCS1-v1_5", hash:"SHA-256" }, false, ["verify"]);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    return crypto.subtle.verify({ name:"RSASSA-PKCS1-v1_5" }, key, Uint8Array.from(b64(parts[2])).buffer, Uint8Array.from(signed).buffer);
  } catch { return false; }
}

async function kfetch(apiKey: string, path: string, init: RequestInit = {}): Promise<{ ok:boolean; status:number; body:JsonObject }> {
  let last = { ok:false, status:0, body:{} as JsonObject };
  for (let attempt=0; attempt<8; attempt+=1) {
    const result = await fetch(API + path, { ...init, headers: { Accept:"application/vnd.api+json", Authorization:`Klaviyo-API-Key ${apiKey}`, revision:REVISION, ...(init.body ? {"Content-Type":"application/vnd.api+json"}:{}), ...(init.headers||{}) } });
    let body:JsonObject={}; try { body=await result.json() as JsonObject; } catch {}
    last={ok:result.ok,status:result.status,body};
    if (result.ok || result.status !== 429) return last;
    const retryAfter=Number(result.headers.get("Retry-After")||"0");
    const delay=Math.min(retryAfter>0?retryAfter*1000:2000*(attempt+1),15000);
    await sleep(delay);
  }
  return last;
}
async function must(apiKey:string,path:string,init:RequestInit={}):Promise<JsonObject>{ const r=await kfetch(apiKey,path,init); if(r.ok)return r.body; const errors=Array.isArray(r.body.errors)?r.body.errors:[]; const first=errors.length?obj(errors[0]):{}; throw new Error(`${path} :: ${r.status} :: ${normalize(first.code)||normalize(first.title)||normalize(first.detail)||"Klaviyo error"}`); }

function definition(segment:JsonObject):JsonObject{return obj(obj(segment.attributes).definition);}
function groups(def:JsonObject):JsonObject[]{return Array.isArray(def.condition_groups)?def.condition_groups.map(obj):[];}
function conditions(group:JsonObject):JsonObject[]{return Array.isArray(group.conditions)?group.conditions.map(obj):[];}
async function getSegment(apiKey:string,id:string):Promise<JsonObject>{ return obj((await must(apiKey,`/api/segments/${encodeURIComponent(id)}?additional-fields[segment]=profile_count&fields[segment]=name,definition,is_active,is_processing,profile_count,created,updated`)).data); }
async function findSegment(apiKey:string,name:string):Promise<JsonObject|null>{ const q=new URLSearchParams(); q.set("filter",`equals(name,'${name.replace(/'/g,"\\'")}')`); q.set("page[size]","10"); q.set("fields[segment]","name,definition,is_active,is_processing,created,updated"); const p=await must(apiKey,"/api/segments?"+q.toString()); for(const item of Array.isArray(p.data)?p.data:[]){const row=obj(item); if(normalize(obj(row.attributes).name)===name)return row;} return null; }
async function createOrReuseSegment(apiKey:string,name:string,def:JsonObject):Promise<JsonObject>{ const existing=await findSegment(apiKey,name); if(existing){await sleep(1200); const full=await getSegment(apiKey,normalize(existing.id)); if(JSON.stringify(definition(full))!==JSON.stringify(def))throw new Error(`segment_definition_mismatch:${name}`); return full;} const p=await must(apiKey,"/api/segments",{method:"POST",body:JSON.stringify({data:{type:"segment",attributes:{name,definition:def,is_starred:false}}})}); const id=normalize(obj(p.data).id); if(!id)throw new Error(`segment_created_without_id:${name}`); await sleep(3500); return getSegment(apiKey,id); }
function metricId(condition:JsonObject):string{return normalize(condition.metric_id);}
function withWindow(condition:JsonObject,count:number,days:number|null):JsonObject{const c=clone(condition); c.measurement="count"; c.measurement_filter={type:"numeric",operator:count===0?"equals":"greater-than-or-equal",value:count}; c.timeframe_filter=days===null?{type:"date",operator:"alltime"}:{type:"date",operator:"in-the-last",unit:"day",quantity:days}; return c;}
function replaceBrand(value:unknown):unknown{ if(typeof value==="string")return value.replace(/K[\s-]?Way/gi,"Sprayground"); if(Array.isArray(value))return value.map(replaceBrand); if(value&&typeof value==="object"){const out:JsonObject={}; for(const [k,v] of Object.entries(value as JsonObject))out[k]=replaceBrand(v); return out;} return value; }

async function ensureSegments(apiKey:string):Promise<JsonObject>{
  const high=await getSegment(apiKey,HIGH_INTENT); const highGroups=groups(definition(high));
  await sleep(1200);
  const behavior=conditions(highGroups[0]); const viewed=behavior.find((c)=>metricId(c)==="UejCPq"); const atc=behavior.find((c)=>metricId(c)==="SXnBMm");
  const noOrder=highGroups[1]; const consent=highGroups[2]; if(!viewed||!atc||!noOrder||!consent)throw new Error("sprayground_high_intent_source_invalid");
  const checkoutSource=await getSegment(apiKey,CHECKOUT_SOURCE); const checkoutCondition=conditions(groups(definition(checkoutSource))[0]).find((c)=>metricId(c)==="TQUiiS"); if(!checkoutCondition)throw new Error("checkout_source_condition_missing");
  await sleep(1200);
  const buyerSource=await getSegment(apiKey,BUYER_SOURCE); const buyerGroups=groups(definition(buyerSource)).filter((g)=>/k[\s-]?way/i.test(JSON.stringify(g)) && conditions(g).length>0); if(!buyerGroups.length)throw new Error("buyer_source_brand_group_missing");
  const buyerGroupsSpray=buyerGroups.map((g)=>replaceBrand(g) as JsonObject);
  const viewerDef={condition_groups:[{conditions:[clone(viewed)]},clone(noOrder),clone(consent)]};
  const atcDef={condition_groups:[{conditions:[clone(atc)]},clone(noOrder),clone(consent)]};
  const checkoutDef={condition_groups:[{conditions:[withWindow(checkoutCondition,1,7)]},clone(highGroups[0]),clone(noOrder),clone(consent)]};
  const pastDef={condition_groups:[...buyerGroupsSpray.map((g)=>({conditions:conditions(g).map((c)=>withWindow(c,1,null))})),clone(consent)]};
  const recentDef={condition_groups:[...buyerGroupsSpray.map((g)=>({conditions:conditions(g).map((c)=>withWindow(c,1,30))})),clone(consent)]};
  const specs:Array<[string,JsonObject,string]>=[
    ["DL | SPRAYGROUND | VIEWER | 14D | NO ORDER 14D",viewerDef,"viewer"],
    ["DL | SPRAYGROUND | ATC | 14D | NO ORDER 14D",atcDef,"atc"],
    ["DL | SPRAYGROUND | CHECKOUT | 7D | BRAND INTENT | NO ORDER 14D",checkoutDef,"checkout"],
    ["DL | SPRAYGROUND | PAST BUYER | ALL TIME | CONSENT",pastDef,"past_buyer"],
    ["DL | SPRAYGROUND | RECENT BUYER | 30D | CONSENT",recentDef,"recent_buyer_exclusion"],
  ];
  const out:JsonObject={high_intent_existing:{id:HIGH_INTENT,name:normalize(obj(high.attributes).name),profile_count:obj(high.attributes).profile_count??null}};
  for(const [name,def,key] of specs){
    const row=await createOrReuseSegment(apiKey,name,def);
    out[key]={id:normalize(row.id),name:normalize(obj(row.attributes).name),profile_count:obj(row.attributes).profile_count??null};
    await sleep(1800);
  }
  return out;
}

type Product={title:string;handle:string;image:string;price:number;compare:number|null;stock:number};
type ShopifyData={collections?:{nodes?:Array<{products?:{nodes?:Array<{title?:string;handle?:string;featuredMedia?:{image?:{url?:string}}|null;variants?:{nodes?:Array<{price?:string;compareAtPrice?:string|null;inventoryQuantity?:number;availableForSale?:boolean}>}}>} }>}};
const PRODUCT_QUERY=`query($query:String!){collections(first:1,query:$query){nodes{products(first:50){nodes{title handle featuredMedia{... on MediaImage{image{url}}} variants(first:30){nodes{price compareAtPrice inventoryQuantity availableForSale}}}}}}}`;
function productScore(title:string):number{const t=title.toLowerCase(); const rules:[[string,number]]=[['stewie',100] as [string,number]]; const rest:Array<[string,number]>=[["taz",95],["gold tooth",92],["shark central",88],["ai pattern",84],["snoopy",80],["bubbly black",76],["bubble brown",74],["crossover clutch",70]]; for(const [k,s] of [...rules,...rest])if(t.includes(k))return s; return 20;}
async function liveProducts(env:Env):Promise<Product[]>{ const data=await shopifyGraphQL<ShopifyData>(env as any,PRODUCT_QUERY,{query:"handle:bts-26-sprayground"}); const nodes=data.collections?.nodes?.[0]?.products?.nodes||[]; const products:Product[]=[]; for(const p of nodes){const variants=p.variants?.nodes||[]; const available=variants.filter((v)=>v.availableForSale===true&&Number(v.inventoryQuantity||0)>0); const stock=available.reduce((s,v)=>s+Number(v.inventoryQuantity||0),0); const prices=available.map((v)=>Number(v.price||0)).filter((v)=>v>0); const compare=available.map((v)=>Number(v.compareAtPrice||0)).filter((v)=>v>0); const image=p.featuredMedia?.image?.url||""; if(!p.title||!p.handle||!image||!stock||!prices.length)continue; products.push({title:p.title,handle:p.handle,image,price:Math.min(...prices),compare:compare.length?Math.max(...compare):null,stock});} products.sort((a,b)=>(productScore(b.title)-productScore(a.title))||(b.stock-a.stock)); if(products.length<6)throw new Error(`insufficient_live_bts_products:${products.length}`); return products.slice(0,10); }
function esc(v:string):string{return v.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function money(v:number):string{return new Intl.NumberFormat("it-IT",{style:"currency",currency:"EUR"}).format(v);}
function tracked(url:string,campaign:string,content:string):string{const sep=url.includes("?")?"&":"?";return `${url}${sep}utm_source=klaviyo&utm_medium=email&utm_campaign=${encodeURIComponent(campaign)}&utm_content=${encodeURIComponent(content)}`;}
function emailHtml(kind:"intent"|"countdown"|"ranking",products:Product[]):string{
  const config=kind==="intent"?{campaign:"sprayground_intent_250826",eyebrow:"SPRAYGROUND · HOT INTENT",headline:"CI STAVI TORNANDO SOPRA?",body:"Hai già guardato Sprayground. Se il modello giusto è ancora disponibile, questo è il momento di ricontrollare.",cta:"TORNA SU SPRAYGROUND"}:kind==="countdown"?{campaign:"sprayground_bts_270826",eyebrow:"SPRAYGROUND · BACK TO SCHOOL",headline:"SETTEMBRE STA ARRIVANDO.",body:"Non ti serve vedere tutto. Ti servono quelli giusti: i modelli più forti del momento, ancora disponibili adesso.",cta:"SCOPRI I PIÙ SCELTI"}:{campaign:"sprayground_bestseller_030926",eyebrow:"SPRAYGROUND · BEST SELLER",headline:"LA CLASSIFICA DEL BACK TO SCHOOL",body:"Questi sono i modelli che stanno vincendo adesso. Una classifica live, costruita su disponibilità e segnali di vendita reali.",cta:"VEDI LA CLASSIFICA"};
  const cards=products.slice(0,kind==="ranking"?10:8).map((p,i)=>{const link=esc(tracked(`https://devidlabel.com/products/${p.handle}`,config.campaign,`rank_${String(i+1).padStart(2,"0")}`)); const low=p.stock<=3?` · SOLO ${p.stock} DISP.`:""; return `<tr><td style="padding:0 26px 28px"><a href="${link}" style="text-decoration:none;color:#111"><img src="${esc(p.image)}" width="548" alt="${esc(p.title)}" style="display:block;width:100%;height:auto;border:0"><div style="padding-top:15px;font:700 11px/16px Arial,sans-serif;letter-spacing:2px;color:#555">#${i+1}${low}</div><div style="padding-top:5px;font:700 23px/29px Georgia,serif;color:#111">${esc(p.title)}</div><div style="padding-top:7px;font:700 14px/20px Arial,sans-serif;color:#111">${money(p.price)}</div><div style="padding-top:10px;font:700 12px/18px Arial,sans-serif;letter-spacing:1.2px">SCOPRI →</div></a></td></tr>`;}).join("");
  const hero=esc(tracked(COLLECTION_URL,config.campaign,"hero")); const final=esc(tracked(COLLECTION_URL,config.campaign,"final_cta")); const home=esc(tracked(HOME_URL,config.campaign,"logo"));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#eee}@media(max-width:620px){.wrap{width:100%!important}.hero{padding:38px 22px!important}.headline{font-size:44px!important;line-height:46px!important}}</style></head><body><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eee"><tr><td align="center"><table role="presentation" width="600" class="wrap" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#fff"><tr><td align="center" style="background:#080808;padding:22px"><a href="${home}"><img src="${LOGO}" width="220" alt="Devid Label" style="display:block;max-width:70%;height:auto;border:0"></a></td></tr><tr><td class="hero" align="center" style="padding:52px 36px 42px"><div style="font:700 11px/16px Arial,sans-serif;letter-spacing:2.4px">${config.eyebrow}</div><div class="headline" style="padding:14px 0 10px;font:700 58px/58px Georgia,serif;letter-spacing:-1px">${config.headline}</div><p style="max-width:470px;margin:10px auto 24px;font:16px/25px Arial,sans-serif;color:#333">${config.body}</p><a href="${hero}" style="display:inline-block;background:#080808;color:#fff;text-decoration:none;font:700 12px/18px Arial,sans-serif;letter-spacing:1.6px;padding:16px 23px">${config.cta}</a></td></tr>${cards}<tr><td align="center" style="background:#080808;padding:38px 26px;color:#fff"><div style="font:700 29px/36px Georgia,serif">La disponibilità cambia più velocemente della classifica.</div><p style="margin:10px 0 22px;font:14px/22px Arial,sans-serif;color:#ddd">Controlla ora i modelli ancora disponibili.</p><a href="${final}" style="display:inline-block;background:#fff;color:#111;text-decoration:none;font:700 12px/18px Arial,sans-serif;letter-spacing:1.4px;padding:15px 22px">VEDI SPRAYGROUND</a></td></tr><tr><td align="center" style="padding:27px;font:11px/18px Arial,sans-serif;color:#777">Devid Label · M.A.R.E. Srl<br><a href="${final}" style="color:#111">Sprayground su Devid Label</a> · {% unsubscribe %}</td></tr></table></td></tr></table></body></html>`;
}

async function getCampaign(apiKey:string,id:string):Promise<JsonObject>{return obj((await must(apiKey,`/api/campaigns/${id}?include=campaign-messages`)).data);}
function campaignStatus(row:JsonObject):string{return normalize(obj(row.attributes).status);}
async function waitStatus(apiKey:string,id:string,status:string):Promise<JsonObject>{for(let i=0;i<20;i+=1){const c=await getCampaign(apiKey,id);if(campaignStatus(c).toLowerCase()===status.toLowerCase())return c;await sleep(1000);}throw new Error(`campaign_status_timeout:${id}:${status}`);}
async function revertScheduled(apiKey:string,id:string):Promise<void>{const r=await kfetch(apiKey,`/api/campaign-send-jobs/${id}`,{method:"PATCH",body:JSON.stringify({data:{type:"campaign-send-job",id,attributes:{action:"revert"}}})});if(!r.ok)throw new Error(`campaign_revert_failed:${id}:${r.status}`);await waitStatus(apiKey,id,"Draft");}
async function schedule(apiKey:string,id:string):Promise<void>{const r=await kfetch(apiKey,"/api/campaign-send-jobs",{method:"POST",body:JSON.stringify({data:{type:"campaign-send-job",id}})});if(!r.ok)throw new Error(`campaign_schedule_failed:${id}:${r.status}`);await waitStatus(apiKey,id,"Scheduled");}
function readbackCampaign(row:JsonObject):JsonObject{const a=obj(row.attributes);return{id:normalize(row.id),name:normalize(a.name),status:normalize(a.status),send_strategy:a.send_strategy??null,scheduled_at:a.scheduled_at??null,audiences:a.audiences??null,send_options:a.send_options??null,tracking_options:a.tracking_options??null};}

async function execute(env:Env):Promise<JsonObject>{
  const apiKey=normalize(env.KLAVIYO_OPERATIONS_API_KEY); if(!apiKey)throw new Error("klaviyo_operations_not_configured");
  const products=await liveProducts(env);
  const segments=await ensureSegments(apiKey);

  const micro=createKlaviyoCampaignDraft({approval_confirmation:"CREATE KLAVIYO DRAFT",idempotency_key:"sprayground-intent-250826-v1",campaign_name:"DL | 2026-08-25-26 | Sprayground | High Intent | Hot Window",audience_id:HIGH_INTENT,subject:"Lo Sprayground che stavi guardando è ancora qui",preview_text:"Se ci stai tornando sopra, controlla ora disponibilità e modelli più richiesti.",use_smart_sending:true},env);
  const microCreated=await micro; const microId=normalize(microCreated.campaign_id); if(!microId)throw new Error("micro_wave_campaign_id_missing");
  const microUpdate=await updateKlaviyoCampaignDraft({approval_confirmation:"UPDATE KLAVIYO DRAFT",campaign_id:microId,subject:"Lo Sprayground che stavi guardando è ancora qui",preview_text:"Se ci stai tornando sopra, controlla ora disponibilità e modelli più richiesti.",html_body:emailHtml("intent",products),use_smart_sending:true},env);

  const sep3=await updateKlaviyoCampaignDraft({approval_confirmation:"UPDATE KLAVIYO DRAFT",campaign_id:CAMPAIGN_03,campaign_name:"DL | 2026-09-03 18:30 | Sprayground BTS | Best Seller Ranking",subject:"La classifica Sprayground del Back to School",preview_text:"I modelli che stanno scegliendo di più adesso, in ordine.",html_body:emailHtml("ranking",products),use_smart_sending:true},env);

  const before27=await getCampaign(apiKey,CAMPAIGN_27); if(campaignStatus(before27)!=="Scheduled")throw new Error(`campaign_27_not_scheduled:${campaignStatus(before27)}`);
  await revertScheduled(apiKey,CAMPAIGN_27);
  const updated27=await updateKlaviyoCampaignDraft({approval_confirmation:"UPDATE KLAVIYO DRAFT",campaign_id:CAMPAIGN_27,subject:"Settembre si avvicina: scegli ora il tuo Sprayground",preview_text:"I modelli più forti sono disponibili adesso, ma non tutti resteranno.",html_body:emailHtml("countdown",products),use_smart_sending:true},env);
  await schedule(apiKey,CAMPAIGN_27);
  const after27=await getCampaign(apiKey,CAMPAIGN_27);
  const sep10=await getCampaign(apiKey,CAMPAIGN_10);

  return {ok:true,operation:"sprayground_peak_plan_2026_08_24",mutation_performed:true,segments,micro_wave:{create:microCreated,update:microUpdate},sep3_draft:sep3,aug27:{before:readbackCampaign(before27),update:updated27,after:readbackCampaign(after27)},sep10:{campaign:readbackCampaign(sep10),blueprint_path:"ops/klaviyo-blueprints/sprayground-most-chosen-2026-09-10.json",campaign_mutated:false},live_products:products.map((p,i)=>({rank:i+1,title:p.title,handle:p.handle,stock:p.stock,price:p.price})),safety:{aug27_original_campaign_id_preserved:true,aug27_rescheduled_after_readback:true,micro_wave_left_draft:true,sep3_left_draft:true,sep10_not_mutated:true}};
}

async function preflight(env:Env):Promise<JsonObject>{const apiKey=normalize(env.KLAVIYO_OPERATIONS_API_KEY);if(!apiKey)return{ok:false,error:"klaviyo_operations_not_configured"};const [c27,c03,c10,high,checkout,buyer,products]=await Promise.all([getCampaign(apiKey,CAMPAIGN_27),getCampaign(apiKey,CAMPAIGN_03),getCampaign(apiKey,CAMPAIGN_10),getSegment(apiKey,HIGH_INTENT),getSegment(apiKey,CHECKOUT_SOURCE),getSegment(apiKey,BUYER_SOURCE),liveProducts(env)]);return{ok:true,mutation_performed:false,campaigns:{aug27:readbackCampaign(c27),sep3:readbackCampaign(c03),sep10:readbackCampaign(c10)},sources:{high_intent:{id:HIGH_INTENT,name:normalize(obj(high.attributes).name)},checkout:{id:CHECKOUT_SOURCE,name:normalize(obj(checkout.attributes).name)},buyer:{id:BUYER_SOURCE,name:normalize(obj(buyer.attributes).name)}},live_products:products.map((p,i)=>({rank:i+1,title:p.title,stock:p.stock,price:p.price}))};}

export async function handleSpraygroundPeak240826(request:Request,env:Env):Promise<Response|null>{const url=new URL(request.url);if(url.pathname!==PATH)return null;if(!await authorized(request))return response({ok:false,error:"unauthorized"},401);try{if(request.method==="GET")return response(await preflight(env));if(request.method!=="POST")return response({ok:false,error:"method_not_allowed"},405);let body:JsonObject={};try{body=await request.json() as JsonObject;}catch{return response({ok:false,error:"invalid_json"},400);}if(normalize(body.approval)!==APPROVAL)return response({ok:false,error:"approval_required"},409);return response(await execute(env));}catch(error){return response({ok:false,error:error instanceof Error?error.message:"sprayground_peak_operation_failed"},500);}}
