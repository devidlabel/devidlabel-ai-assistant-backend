import { shopifyGraphQL } from "./index.js";
import type { KlaviyoOperationsEnv } from "./mare-operations-klaviyo.js";
import { updateKlaviyoCampaignDraft } from "./mare-operations-klaviyo-update.js";

type JsonObject = Record<string, unknown>;
type Env = KlaviyoOperationsEnv & { [key: string]: unknown };
type Claims = { iss?: string; aud?: string | string[]; sub?: string; repository?: string; repository_owner?: string; ref?: string; event_name?: string; exp?: number; iat?: number; nbf?: number };

type Product = {
  id: string;
  legacyId: string;
  title: string;
  handle: string;
  vendor: string;
  createdAt: string;
  image: string;
  stock: number;
  availableVariants: number;
  price: number;
  compare: number | null;
  discountPct: number;
};

type ShopifyData = {
  collections?: { nodes?: Array<{ products?: { nodes?: Array<{
    id?: string;
    legacyResourceId?: string;
    title?: string;
    handle?: string;
    vendor?: string;
    createdAt?: string;
    featuredMedia?: { image?: { url?: string } } | null;
    variants?: { nodes?: Array<{ price?: string; compareAtPrice?: string | null; inventoryQuantity?: number; availableForSale?: boolean }> };
  }> } }> };
};

const PATH = "/internal/ops/sneakers-btw-2026-09-01";
const API = "https://a.klaviyo.com";
const REVISION = "2026-07-15";
const REPOSITORY = "devidlabel/devidlabel-ai-assistant-backend";
const EXECUTION_REF = "refs/heads/ops/execute-sneakers-btw-2026-09-01";
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const OIDC_AUDIENCE = "devidlabel-sneakers-btw-2026-09-01";
const OIDC_SUBJECT = `repo:${REPOSITORY}:ref:${EXECUTION_REF}`;
const APPROVAL = "EXECUTE SNEAKERS BTW SEP01";

const CLICKED_EMAIL = "Rbee4j";
const VIEWED_PRODUCT = "UejCPq";
const ADDED_TO_CART = "SXnBMm";
const SOURCE_CAMPAIGN = "01KZ61XC0M402Q4P1C8ZCEXFMW";
const COLLECTION_UOMO = "sneakers-uomo";
const COLLECTION_DONNA = "sneakers-donna";
const URL_UOMO = "https://devidlabel.com/collections/sneakers-uomo";
const URL_DONNA = "https://devidlabel.com/collections/sneakers-donna";
const LOGO = "https://d3k81ch9hvuctc.cloudfront.net/company/V6B2sR/images/1558f3d0-2cf5-4937-920f-7293a7950f98.png";
const SEND_DONNA = "2026-09-01T08:30:00+00:00";
const SEND_UOMO = "2026-09-01T08:45:00+00:00";
const NAME_DONNA = "DL | 2026-09-01 10:30 | Sneakers Donna | New Season + Last Sale | Click90D";
const NAME_UOMO = "DL | 2026-09-01 10:45 | Sneakers Uomo | New Season + Last Sale | Click90D";

function normalize(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }
function obj(v: unknown): JsonObject { return v && typeof v === "object" && !Array.isArray(v) ? v as JsonObject : {}; }
function clone<T>(v:T):T { return JSON.parse(JSON.stringify(v)) as T; }
function json(body: unknown, status=200):Response { return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"}}); }
function sleep(ms:number):Promise<void>{return new Promise((resolve)=>setTimeout(resolve,ms));}
function filterLiteral(v:string):string{return v.replace(/\\/g,"\\\\").replace(/'/g,"\\'");}
function b64(v:string):Uint8Array{const n=v.replace(/-/g,"+").replace(/_/g,"/");const p=n.padEnd(Math.ceil(n.length/4)*4,"=");const b=atob(p);const bytes=new Uint8Array(b.length);for(let i=0;i<b.length;i+=1)bytes[i]=b.charCodeAt(i);return bytes;}
function decode<T>(v:string):T{return JSON.parse(new TextDecoder().decode(b64(v))) as T;}

async function authorized(request:Request):Promise<boolean>{
  const authorization=request.headers.get("Authorization")||"";
  if(!authorization.startsWith("Bearer "))return false;
  const token=authorization.slice(7).trim(); const parts=token.split(".");
  if(parts.length!==3||token.length<100||token.length>12000)return false;
  try{
    const header=decode<{alg?:string;kid?:string}>(parts[0]); const claims=decode<Claims>(parts[1]);
    if(header.alg!=="RS256"||!header.kid)return false;
    const now=Math.floor(Date.now()/1000); const audience=Array.isArray(claims.aud)?claims.aud.includes(OIDC_AUDIENCE):claims.aud===OIDC_AUDIENCE;
    if(claims.iss!==OIDC_ISSUER||!audience||claims.repository!==REPOSITORY||claims.repository_owner!=="devidlabel"||claims.ref!==EXECUTION_REF||claims.sub!==OIDC_SUBJECT||claims.event_name!=="push"||typeof claims.exp!=="number"||claims.exp<now-30||claims.exp>now+900||typeof claims.iat!=="number"||claims.iat>now+30||claims.iat<now-900||(typeof claims.nbf==="number"&&claims.nbf>now+30))return false;
    const configResponse=await fetch(`${OIDC_ISSUER}/.well-known/openid-configuration`); if(!configResponse.ok)return false;
    const config=await configResponse.json() as {issuer?:string;jwks_uri?:string}; if(config.issuer!==OIDC_ISSUER||!config.jwks_uri)return false;
    const jwksUrl=new URL(config.jwks_uri); if(jwksUrl.protocol!=="https:"||jwksUrl.hostname!=="token.actions.githubusercontent.com")return false;
    const jwksResponse=await fetch(jwksUrl.toString(),{headers:{Accept:"application/json"}}); if(!jwksResponse.ok)return false;
    const jwks=await jwksResponse.json() as {keys?:Array<JsonWebKey&{kid?:string;alg?:string;use?:string}>};
    const jwk=(jwks.keys||[]).find((k)=>k.kid===header.kid&&(!k.alg||k.alg==="RS256")&&(!k.use||k.use==="sig")); if(!jwk)return false;
    const key=await crypto.subtle.importKey("jwk",jwk,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
    return crypto.subtle.verify({name:"RSASSA-PKCS1-v1_5"},key,Uint8Array.from(b64(parts[2])).buffer,Uint8Array.from(new TextEncoder().encode(`${parts[0]}.${parts[1]}`)).buffer);
  }catch{return false;}
}

async function kfetch(apiKey:string,path:string,init:RequestInit={}):Promise<{ok:boolean;status:number;body:JsonObject}>{
  let last={ok:false,status:0,body:{} as JsonObject};
  for(let attempt=0;attempt<8;attempt+=1){
    const r=await fetch(API+path,{...init,headers:{Accept:"application/vnd.api+json",Authorization:`Klaviyo-API-Key ${apiKey}`,revision:REVISION,...(init.body?{"Content-Type":"application/vnd.api+json"}:{}),...(init.headers||{})}});
    let body:JsonObject={}; try{body=await r.json() as JsonObject;}catch{}
    last={ok:r.ok,status:r.status,body}; if(r.ok||r.status!==429)return last;
    const retry=Number(r.headers.get("Retry-After")||"0"); await sleep(Math.min(retry>0?retry*1000:1800*(attempt+1),15000));
  }
  return last;
}
async function must(apiKey:string,path:string,init:RequestInit={}):Promise<JsonObject>{const r=await kfetch(apiKey,path,init);if(r.ok)return r.body;const errors=Array.isArray(r.body.errors)?r.body.errors:[];const first=errors.length?obj(errors[0]):{};throw new Error(`${path} :: ${r.status} :: ${normalize(first.code)||normalize(first.title)||normalize(first.detail)||"Klaviyo error"}`);}

const COLLECTION_QUERY=`query CollectionProducts($query:String!){collections(first:1,query:$query){nodes{products(first:100,sortKey:CREATED,reverse:true){nodes{id legacyResourceId title handle vendor createdAt featuredMedia{... on MediaImage{image{url}}} variants(first:50){nodes{price compareAtPrice inventoryQuantity availableForSale}}}}}}}`;

async function loadCollection(env:Env,handle:string):Promise<Product[]>{
  const data=await shopifyGraphQL<ShopifyData>(env as any,COLLECTION_QUERY,{query:`handle:${handle}`});
  const nodes=data.collections?.nodes?.[0]?.products?.nodes||[]; const out:Product[]=[];
  for(const p of nodes){
    const variants=p.variants?.nodes||[]; const available=variants.filter((v)=>v.availableForSale===true&&Number(v.inventoryQuantity||0)>0);
    const stock=available.reduce((s,v)=>s+Number(v.inventoryQuantity||0),0); const prices=available.map((v)=>Number(v.price||0)).filter((n)=>n>0); const compares=available.map((v)=>Number(v.compareAtPrice||0)).filter((n)=>n>0);
    const price=prices.length?Math.min(...prices):0; const compare=compares.length?Math.max(...compares):null; const discount=compare&&compare>price?Math.round((1-price/compare)*100):0;
    const legacy=normalize(p.legacyResourceId); const image=p.featuredMedia?.image?.url||"";
    if(!legacy||!p.title||!p.handle||!image||stock<=0||price<=0)continue;
    out.push({id:normalize(p.id),legacyId:legacy,title:p.title,handle:p.handle,vendor:p.vendor||"",createdAt:p.createdAt||"",image,stock,availableVariants:available.length,price,compare,discountPct:discount});
  }
  return out;
}

function metricCondition(metricId:string,productId:string,days:number):JsonObject{return{type:"profile-metric",metric_id:metricId,measurement:"count",measurement_filter:{type:"numeric",operator:"greater-than",value:0},timeframe_filter:{type:"date",operator:"in-the-last",unit:"day",quantity:days},metric_filters:[{property:"ProductID",filter:{type:"string",operator:"equals",value:productId}}]};}
function click90Condition():JsonObject{return{type:"profile-metric",metric_id:CLICKED_EMAIL,measurement:"count",measurement_filter:{type:"numeric",operator:"greater-than",value:0},timeframe_filter:{type:"date",operator:"in-the-last",unit:"day",quantity:90},metric_filters:null};}
function consentCondition():JsonObject{return{type:"profile-marketing-consent",consent:{channel:"email",can_receive_marketing:true,consent_status:{subscription:"any",filters:null}}};}
function segmentDefinition(productIds:string[]):JsonObject{
  const interest:JsonObject[]=[];
  for(const id of productIds){interest.push(metricCondition(VIEWED_PRODUCT,id,365));interest.push(metricCondition(ADDED_TO_CART,id,365));}
  return{condition_groups:[{conditions:[click90Condition()]},{conditions:interest},{conditions:[consentCondition()]}]};
}
function clickerDefinition():JsonObject{return{condition_groups:[{conditions:[click90Condition()]},{conditions:[consentCondition()]}]};}
async function getSegment(apiKey:string,id:string):Promise<JsonObject>{return obj((await must(apiKey,`/api/segments/${encodeURIComponent(id)}?additional-fields[segment]=profile_count&fields[segment]=name,definition,is_active,is_processing,profile_count,created,updated`)).data);}
async function findSegment(apiKey:string,name:string):Promise<JsonObject|null>{const q=new URLSearchParams();q.set("filter",`equals(name,'${filterLiteral(name)}')`);q.set("page[size]","10");const p=await must(apiKey,"/api/segments?"+q.toString());for(const item of Array.isArray(p.data)?p.data:[]){const row=obj(item);if(normalize(obj(row.attributes).name)===name)return row;}return null;}
async function createOrReuseSegment(apiKey:string,name:string,definition:JsonObject):Promise<JsonObject>{
  const existing=await findSegment(apiKey,name); if(existing){await sleep(1000);return getSegment(apiKey,normalize(existing.id));}
  const p=await must(apiKey,"/api/segments",{method:"POST",body:JSON.stringify({data:{type:"segment",attributes:{name,definition,is_starred:false}}})}); const id=normalize(obj(p.data).id); if(!id)throw new Error(`segment_created_without_id:${name}`); await sleep(3500); return getSegment(apiKey,id);
}

function campaignMessageId(row:JsonObject):string{const rel=obj(obj(row.relationships)["campaign-messages"]);const data=Array.isArray(rel.data)?rel.data:[];return data.length?normalize(obj(data[0]).id):"";}
async function senderIdentity(apiKey:string):Promise<{from_email:string;from_label:string;reply_to_email:string}>{const source=await must(apiKey,`/api/campaigns/${SOURCE_CAMPAIGN}?include=campaign-messages`);const row=obj(source.data);const mid=campaignMessageId(row);if(!mid)throw new Error("sender_source_message_missing");const msg=await must(apiKey,`/api/campaign-messages/${mid}`);const content=obj(obj(obj(msg.data).attributes).definition);const c=obj(content.content);const from_email=normalize(c.from_email),from_label=normalize(c.from_label),reply_to_email=normalize(c.reply_to_email)||from_email;if(!from_email||!from_label)return Promise.reject(new Error("sender_identity_missing"));return{from_email,from_label,reply_to_email};}
async function findCampaign(apiKey:string,name:string):Promise<JsonObject|null>{const q=new URLSearchParams();q.set("filter",`and(equals(messages.channel,'email'),contains(name,'${filterLiteral(name)}'))`);q.set("include","campaign-messages");q.set("page[size]","10");const p=await must(apiKey,"/api/campaigns?"+q.toString());for(const item of Array.isArray(p.data)?p.data:[]){const row=obj(item);if(normalize(obj(row.attributes).name)===name)return row;}return null;}
async function getCampaign(apiKey:string,id:string):Promise<JsonObject>{return obj((await must(apiKey,`/api/campaigns/${id}?include=campaign-messages`)).data);}
function campaignStatus(row:JsonObject):string{return normalize(obj(row.attributes).status);}
async function waitScheduled(apiKey:string,id:string):Promise<JsonObject>{for(let i=0;i<25;i+=1){const c=await getCampaign(apiKey,id);const s=campaignStatus(c).toLowerCase();if(s==="scheduled"||s.startsWith("queued"))return c;await sleep(1000);}throw new Error(`schedule_readback_timeout:${id}`);}
async function schedule(apiKey:string,id:string):Promise<JsonObject>{const r=await kfetch(apiKey,"/api/campaign-send-jobs",{method:"POST",body:JSON.stringify({data:{type:"campaign-send-job",id}})});if(!r.ok)throw new Error(`schedule_failed:${id}:${r.status}`);return waitScheduled(apiKey,id);}

function esc(v:string):string{return v.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function money(v:number):string{return new Intl.NumberFormat("it-IT",{style:"currency",currency:"EUR"}).format(v);}
function tracked(url:string,campaign:string,content:string):string{const sep=url.includes("?")?"&":"?";return `${url}${sep}utm_source=klaviyo&utm_medium=email&utm_campaign=${encodeURIComponent(campaign)}&utm_content=${encodeURIComponent(content)}`;}
function pickProducts(products:Product[]):{fresh:Product[];sale:Product[]}{
  const fresh=products.filter((p)=>p.discountPct===0&&p.availableVariants>=2&&p.stock>=3).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||b.stock-a.stock).slice(0,5);
  const sale=products.filter((p)=>p.discountPct>=20&&p.stock>=2).sort((a,b)=>b.discountPct-a.discountPct||b.stock-a.stock).slice(0,3);
  if(fresh.length<3||sale.length<2)throw new Error(`insufficient_merchandising:fresh=${fresh.length}:sale=${sale.length}`);
  return{fresh,sale};
}
function productCard(p:Product,campaign:string,content:string,sale=false):string{const link=esc(tracked(`https://devidlabel.com/products/${p.handle}`,campaign,content));const price=sale&&p.compare&&p.compare>p.price?`<span style="text-decoration:line-through;color:#777;font-weight:400">${money(p.compare)}</span> &nbsp; ${money(p.price)}`:money(p.price);return`<tr><td style="padding:0 28px 28px"><a href="${link}" style="text-decoration:none;color:#111"><img src="${esc(p.image)}" width="544" alt="${esc(p.title)}" style="display:block;width:100%;height:auto;border:0"><div style="padding-top:14px;font:700 11px/16px Arial,sans-serif;letter-spacing:1.6px;color:#666">${sale?`ULTIME OCCASIONI${p.discountPct?` · -${p.discountPct}%`:""}`:"NUOVA STAGIONE"}</div><div style="padding-top:5px;font:700 22px/28px Georgia,serif">${esc(p.title)}</div><div style="padding-top:7px;font:700 14px/20px Arial,sans-serif">${price}</div><div style="padding-top:9px;font:700 12px/18px Arial,sans-serif;letter-spacing:1.1px">SCOPRI →</div></a></td></tr>`;}
function emailHtml(kind:"uomo"|"donna",selection:{fresh:Product[];sale:Product[]}):string{
  const isDonna=kind==="donna";const campaign=isDonna?"sneakers_donna_btw_010926":"sneakers_uomo_btw_010926";const collection=isDonna?URL_DONNA:URL_UOMO;
  const title=isDonna?"LA NUOVA STAGIONE PARTE DALLE SNEAKERS.":"IL RIENTRO PARTE DALLE SNEAKERS.";
  const body=isDonna?"Settembre è il momento giusto per cambiare passo: scopri i nuovi arrivi sneakers donna e, più sotto, gli ultimi modelli della stagione precedente ancora in saldo.":"Il Back to Work comincia dalle scarpe: scopri i nuovi arrivi sneakers uomo e, più sotto, gli ultimi modelli della stagione precedente ancora in saldo.";
  const fresh=selection.fresh.map((p,i)=>productCard(p,campaign,`new_${i+1}`,false)).join("");const sale=selection.sale.map((p,i)=>productCard(p,campaign,`sale_${i+1}`,true)).join("");
  const hero=esc(tracked(collection,campaign,"hero"));const final=esc(tracked(collection,campaign,"final_cta"));
  return`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#eee}@media(max-width:620px){.wrap{width:100%!important}.hero{padding:38px 22px!important}.headline{font-size:42px!important;line-height:45px!important}}</style></head><body><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eee"><tr><td align="center"><table role="presentation" width="600" class="wrap" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#fff"><tr><td align="center" style="background:#080808;padding:22px"><img src="${LOGO}" width="220" alt="Devid Label" style="display:block;max-width:70%;height:auto;border:0"></td></tr><tr><td class="hero" align="center" style="padding:50px 34px 42px"><div style="font:700 11px/16px Arial,sans-serif;letter-spacing:2.2px">BACK TO WORK · SETTEMBRE</div><div class="headline" style="padding:14px 0 10px;font:700 54px/56px Georgia,serif">${title}</div><p style="max-width:485px;margin:10px auto 24px;font:16px/25px Arial,sans-serif;color:#333">${body}</p><a href="${hero}" style="display:inline-block;background:#080808;color:#fff;text-decoration:none;font:700 12px/18px Arial,sans-serif;letter-spacing:1.5px;padding:16px 23px">SCOPRI I NUOVI ARRIVI</a></td></tr><tr><td style="padding:10px 28px 30px"><div style="font:700 12px/18px Arial,sans-serif;letter-spacing:2px;color:#666">NUOVI ARRIVI</div><div style="padding-top:5px;font:700 34px/40px Georgia,serif">Il nuovo passo di settembre.</div></td></tr>${fresh}<tr><td style="background:#111;color:#fff;padding:34px 28px 30px"><div style="font:700 12px/18px Arial,sans-serif;letter-spacing:2px;color:#bbb">ULTIME OCCASIONI</div><div style="padding-top:6px;font:700 33px/39px Georgia,serif">Prima che finiscano davvero.</div><p style="margin:9px 0 0;font:15px/23px Arial,sans-serif;color:#ddd">Gli ultimi modelli in saldo ancora disponibili per affrontare il rientro.</p></td></tr>${sale}<tr><td align="center" style="padding:12px 28px 42px"><a href="${final}" style="display:inline-block;background:#080808;color:#fff;text-decoration:none;font:700 12px/18px Arial,sans-serif;letter-spacing:1.5px;padding:16px 23px">VEDI TUTTE LE SNEAKERS</a></td></tr><tr><td align="center" style="padding:25px;font:11px/18px Arial,sans-serif;color:#777">Devid Label · M.A.R.E. Srl<br>{% unsubscribe %}</td></tr></table></td></tr></table></body></html>`;
}

async function createOrReuseCampaign(apiKey:string,env:Env,args:{name:string;segmentId:string;sendAt:string;subject:string;preview:string;html:string}):Promise<JsonObject>{
  const existing=await findCampaign(apiKey,args.name); if(existing){const id=normalize(existing.id);const status=campaignStatus(existing);if(status==="Scheduled")return{campaign_id:id,status:"already_scheduled",readback:existing};if(status!=="Draft")throw new Error(`campaign_exists_bad_status:${args.name}:${status}`);const upd=await updateKlaviyoCampaignDraft({approval_confirmation:"UPDATE KLAVIYO DRAFT",campaign_id:id,subject:args.subject,preview_text:args.preview,html_body:args.html,use_smart_sending:true},env);const after=await schedule(apiKey,id);return{campaign_id:id,status:"scheduled_existing_draft",update:upd,readback:after};}
  const sender=await senderIdentity(apiKey);
  const created=await must(apiKey,"/api/campaigns",{method:"POST",body:JSON.stringify({data:{type:"campaign",attributes:{name:args.name,audiences:{included:[args.segmentId],excluded:[]},send_strategy:{method:"static",datetime:args.sendAt,options:{is_local:false}},send_options:{use_smart_sending:true},tracking_options:{add_tracking_params:true,custom_tracking_params:[],is_tracking_clicks:true,is_tracking_opens:true},"campaign-messages":{data:[{type:"campaign-message",attributes:{definition:{channel:"email",label:args.name,content:{subject:args.subject,preview_text:args.preview,from_email:sender.from_email,from_label:sender.from_label,reply_to_email:sender.reply_to_email}}}}]}}}})});
  const row=obj(created.data);const id=normalize(row.id);if(!id)throw new Error(`campaign_created_without_id:${args.name}`);await sleep(1200);const full=await getCampaign(apiKey,id);const mid=campaignMessageId(full);if(!mid)throw new Error(`campaign_message_missing:${id}`);
  const upd=await updateKlaviyoCampaignDraft({approval_confirmation:"UPDATE KLAVIYO DRAFT",campaign_id:id,subject:args.subject,preview_text:args.preview,html_body:args.html,use_smart_sending:true},env);const after=await schedule(apiKey,id);return{campaign_id:id,campaign_message_id:mid,status:"created_and_scheduled",update:upd,readback:after};
}
function campaignSummary(row:JsonObject):JsonObject{const a=obj(row.attributes);return{id:normalize(row.id),name:normalize(a.name),status:normalize(a.status),send_strategy:a.send_strategy??null,scheduled_at:a.scheduled_at??null,audiences:a.audiences??null,send_options:a.send_options??null,tracking_options:a.tracking_options??null};}

async function execute(env:Env):Promise<JsonObject>{
  const apiKey=normalize(env.KLAVIYO_OPERATIONS_API_KEY);if(!apiKey)throw new Error("klaviyo_operations_not_configured");
  const [uomoAll,donnaAll]=await Promise.all([loadCollection(env,COLLECTION_UOMO),loadCollection(env,COLLECTION_DONNA)]);
  const uomoSet=new Set(uomoAll.map((p)=>p.legacyId));const donnaSet=new Set(donnaAll.map((p)=>p.legacyId));
  const uomoUnique=[...uomoSet].filter((id)=>!donnaSet.has(id));const donnaUnique=[...donnaSet].filter((id)=>!uomoSet.has(id));
  if(uomoUnique.length<5||donnaUnique.length<5)throw new Error(`insufficient_unique_collection_ids:uomo=${uomoUnique.length}:donna=${donnaUnique.length}`);

  const clickers=await createOrReuseSegment(apiKey,"DL | CLICKED EMAIL | 90D | CONSENT",clickerDefinition());await sleep(1800);
  const uomoSegment=await createOrReuseSegment(apiKey,"DL | SNEAKERS UOMO INTEREST | CLICK90D | PRODUCT INTENT365D",segmentDefinition(uomoUnique));await sleep(1800);
  const donnaSegment=await createOrReuseSegment(apiKey,"DL | SNEAKERS DONNA INTEREST | CLICK90D | PRODUCT INTENT365D",segmentDefinition(donnaUnique));await sleep(1800);

  const uomoSelection=pickProducts(uomoAll);const donnaSelection=pickProducts(donnaAll);
  const donnaCampaign=await createOrReuseCampaign(apiKey,env,{name:NAME_DONNA,segmentId:normalize(donnaSegment.id),sendAt:SEND_DONNA,subject:"Settembre parte dalle sneakers: nuovi arrivi donna",preview:"Nuova stagione davanti. Ultimi modelli in saldo dietro: scegli il tuo passo per il rientro.",html:emailHtml("donna",donnaSelection)});
  await sleep(1500);
  const uomoCampaign=await createOrReuseCampaign(apiKey,env,{name:NAME_UOMO,segmentId:normalize(uomoSegment.id),sendAt:SEND_UOMO,subject:"Back to Work: le nuove sneakers uomo sono qui",preview:"Nuovi arrivi per settembre + gli ultimi modelli in saldo ancora disponibili.",html:emailHtml("uomo",uomoSelection)});

  const donnaRead=await getCampaign(apiKey,normalize(donnaCampaign.campaign_id));await sleep(700);const uomoRead=await getCampaign(apiKey,normalize(uomoCampaign.campaign_id));
  return{ok:true,operation:"sneakers_btw_sep01",mutation_performed:true,segments:{clickers90:{id:normalize(clickers.id),name:normalize(obj(clickers.attributes).name),profile_count:obj(clickers.attributes).profile_count??null},uomo_interest:{id:normalize(uomoSegment.id),name:normalize(obj(uomoSegment.attributes).name),profile_count:obj(uomoSegment.attributes).profile_count??null,unique_product_ids:uomoUnique.length},donna_interest:{id:normalize(donnaSegment.id),name:normalize(obj(donnaSegment.attributes).name),profile_count:obj(donnaSegment.attributes).profile_count??null,unique_product_ids:donnaUnique.length}},campaigns:{donna:campaignSummary(donnaRead),uomo:campaignSummary(uomoRead)},merchandising:{donna:{fresh:donnaSelection.fresh.map((p)=>({title:p.title,vendor:p.vendor,stock:p.stock,price:p.price})),sale:donnaSelection.sale.map((p)=>({title:p.title,vendor:p.vendor,stock:p.stock,price:p.price,compare:p.compare,discount_pct:p.discountPct}))},uomo:{fresh:uomoSelection.fresh.map((p)=>({title:p.title,vendor:p.vendor,stock:p.stock,price:p.price})),sale:uomoSelection.sale.map((p)=>({title:p.title,vendor:p.vendor,stock:p.stock,price:p.price,compare:p.compare,discount_pct:p.discountPct}))}},safety:{audience_gate:"Clicked Email > 0 in last 90 days + email marketing consent + collection-specific product intent",gender_inference_used:false,collection_overlap_removed_from_interest_ids:true,smart_sending:true,stagger_minutes:15}};
}

async function preflight(env:Env):Promise<JsonObject>{const [uomo, donna]=await Promise.all([loadCollection(env,COLLECTION_UOMO),loadCollection(env,COLLECTION_DONNA)]);const us=new Set(uomo.map((p)=>p.legacyId)),ds=new Set(donna.map((p)=>p.legacyId));const u=[...us].filter((id)=>!ds.has(id)),d=[...ds].filter((id)=>!us.has(id));return{ok:true,mutation_performed:false,collections:{uomo:{count:uomo.length,unique_interest_ids:u.length,selection:pickProducts(uomo)},donna:{count:donna.length,unique_interest_ids:d.length,selection:pickProducts(donna)}},schedule:{donna:SEND_DONNA,uomo:SEND_UOMO}};}

export async function handleSneakersBtw250826(request:Request,env:Env):Promise<Response|null>{const url=new URL(request.url);if(url.pathname!==PATH)return null;if(!await authorized(request))return json({ok:false,error:"unauthorized"},401);try{if(request.method==="GET")return json(await preflight(env));if(request.method!=="POST")return json({ok:false,error:"method_not_allowed"},405);let body:JsonObject={};try{body=await request.json() as JsonObject;}catch{return json({ok:false,error:"invalid_json"},400);}if(normalize(body.approval)!==APPROVAL)return json({ok:false,error:"approval_required"},409);return json(await execute(env));}catch(error){return json({ok:false,error:error instanceof Error?error.message:"sneakers_btw_failed"},500);}}
