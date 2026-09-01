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

const PATH = "/internal/ops/sneakers-new-season-2026-09-01";
const API = "https://a.klaviyo.com";
const REVISION = "2026-07-15";
const REPOSITORY = "devidlabel/devidlabel-ai-assistant-backend";
const EXECUTION_REF = "refs/heads/ops/execute-sneakers-new-season-2026-09-01";
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const OIDC_AUDIENCE = "devidlabel-sneakers-new-season-2026-09-01";
const OIDC_SUBJECT = `repo:${REPOSITORY}:ref:${EXECUTION_REF}`;
const APPROVAL = "EXECUTE SNEAKERS NEW SEASON SEP01";
const SOURCE_CAMPAIGN = "01KZ61XC0M402Q4P1C8ZCEXFMW";
const CLICKER_SEGMENT_NAME = "DL | CLICKED EMAIL | 90D | CONSENT";
const MORNING_DONNA = "DL | 2026-09-01 10:30 | Sneakers Donna | New Season + Last Sale | Click90D";
const MORNING_UOMO = "DL | 2026-09-01 10:45 | Sneakers Uomo | New Season + Last Sale | Click90D";
const CAMPAIGN_NAME = "DL | 2026-09-01 18:30 | Sneakers New Season | -10 SNEAK10 | Click90D Excl AM";
const SEND_AT = "2026-09-01T16:30:00+00:00";
const SUBJECT = "Nuova stagione, nuove sneakers. Per te -10% 👟";
const PREVIEW = "4B12, Puraai e Flower Mountain: scopri i nuovi modelli Uomo e Donna. Codice SNEAK10.";
const CODE = "SNEAK10";
const COLLECTION_UOMO = "sneakers-uomo";
const COLLECTION_DONNA = "sneakers-donna";
const LOGO = "https://d3k81ch9hvuctc.cloudfront.net/company/V6B2sR/images/1558f3d0-2cf5-4937-920f-7293a7950f98.png";

function normalize(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }
function obj(v: unknown): JsonObject { return v && typeof v === "object" && !Array.isArray(v) ? v as JsonObject : {}; }
function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } }); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function filterLiteral(v: string): string { return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
function b64(v: string): Uint8Array { const n=v.replace(/-/g,"+").replace(/_/g,"/"); const p=n.padEnd(Math.ceil(n.length/4)*4,"="); const b=atob(p); const bytes=new Uint8Array(b.length); for(let i=0;i<b.length;i+=1) bytes[i]=b.charCodeAt(i); return bytes; }
function decode<T>(v: string): T { return JSON.parse(new TextDecoder().decode(b64(v))) as T; }

async function authorized(request: Request): Promise<boolean> {
  const authorization=request.headers.get("Authorization")||"";
  if(!authorization.startsWith("Bearer ")) return false;
  const token=authorization.slice(7).trim(); const parts=token.split(".");
  if(parts.length!==3||token.length<100||token.length>12000) return false;
  try {
    const header=decode<{alg?:string;kid?:string}>(parts[0]); const claims=decode<Claims>(parts[1]);
    if(header.alg!=="RS256"||!header.kid) return false;
    const now=Math.floor(Date.now()/1000); const audience=Array.isArray(claims.aud)?claims.aud.includes(OIDC_AUDIENCE):claims.aud===OIDC_AUDIENCE;
    if(claims.iss!==OIDC_ISSUER||!audience||claims.repository!==REPOSITORY||claims.repository_owner!=="devidlabel"||claims.ref!==EXECUTION_REF||claims.sub!==OIDC_SUBJECT||claims.event_name!=="push"||typeof claims.exp!=="number"||claims.exp<now-30||claims.exp>now+900||typeof claims.iat!=="number"||claims.iat>now+30||claims.iat<now-900||(typeof claims.nbf==="number"&&claims.nbf>now+30)) return false;
    const configResponse=await fetch(`${OIDC_ISSUER}/.well-known/openid-configuration`); if(!configResponse.ok) return false;
    const config=await configResponse.json() as {issuer?:string;jwks_uri?:string}; if(config.issuer!==OIDC_ISSUER||!config.jwks_uri) return false;
    const jwksUrl=new URL(config.jwks_uri); if(jwksUrl.protocol!=="https:"||jwksUrl.hostname!=="token.actions.githubusercontent.com") return false;
    const jwksResponse=await fetch(jwksUrl.toString(),{headers:{Accept:"application/json"}}); if(!jwksResponse.ok) return false;
    const jwks=await jwksResponse.json() as {keys?:Array<JsonWebKey&{kid?:string;alg?:string;use?:string}>};
    const jwk=(jwks.keys||[]).find((k)=>k.kid===header.kid&&(!k.alg||k.alg==="RS256")&&(!k.use||k.use==="sig")); if(!jwk) return false;
    const key=await crypto.subtle.importKey("jwk",jwk,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
    return crypto.subtle.verify({name:"RSASSA-PKCS1-v1_5"},key,Uint8Array.from(b64(parts[2])).buffer,Uint8Array.from(new TextEncoder().encode(`${parts[0]}.${parts[1]}`)).buffer);
  } catch { return false; }
}

async function kfetch(apiKey:string,path:string,init:RequestInit={}):Promise<{ok:boolean;status:number;body:JsonObject}>{
  let last={ok:false,status:0,body:{} as JsonObject};
  for(let attempt=0;attempt<8;attempt+=1){
    const r=await fetch(API+path,{...init,headers:{Accept:"application/vnd.api+json",Authorization:`Klaviyo-API-Key ${apiKey}`,revision:REVISION,...(init.body?{"Content-Type":"application/vnd.api+json"}:{}),...(init.headers||{})}});
    let body:JsonObject={}; try{body=await r.json() as JsonObject;}catch{}
    last={ok:r.ok,status:r.status,body}; if(r.ok||r.status!==429) return last;
    const retry=Number(r.headers.get("Retry-After")||"0"); await sleep(Math.min(retry>0?retry*1000:1800*(attempt+1),15000));
  }
  return last;
}
async function must(apiKey:string,path:string,init:RequestInit={}):Promise<JsonObject>{ const r=await kfetch(apiKey,path,init); if(r.ok) return r.body; const errors=Array.isArray(r.body.errors)?r.body.errors:[]; const first=errors.length?obj(errors[0]):{}; throw new Error(`${path} :: ${r.status} :: ${normalize(first.code)||normalize(first.title)||normalize(first.detail)||"Klaviyo error"}`); }

const COLLECTION_QUERY=`query CollectionProducts($query:String!){collections(first:1,query:$query){nodes{products(first:100,sortKey:CREATED,reverse:true){nodes{id legacyResourceId title handle vendor createdAt featuredMedia{... on MediaImage{image{url}}} variants(first:50){nodes{price compareAtPrice inventoryQuantity availableForSale}}}}}}}`;

async function loadCollection(env:Env,handle:string):Promise<Product[]> {
  const data=await shopifyGraphQL<ShopifyData>(env as any,COLLECTION_QUERY,{query:`handle:${handle}`});
  const nodes=data.collections?.nodes?.[0]?.products?.nodes||[]; const out:Product[]=[];
  for(const p of nodes){
    const variants=p.variants?.nodes||[]; const available=variants.filter((v)=>v.availableForSale===true&&Number(v.inventoryQuantity||0)>0);
    const stock=available.reduce((s,v)=>s+Number(v.inventoryQuantity||0),0); const prices=available.map((v)=>Number(v.price||0)).filter((n)=>n>0); const compares=available.map((v)=>Number(v.compareAtPrice||0)).filter((n)=>n>0);
    const price=prices.length?Math.min(...prices):0; const compare=compares.length?Math.max(...compares):null; const legacy=normalize(p.legacyResourceId); const image=p.featuredMedia?.image?.url||"";
    if(!legacy||!p.title||!p.handle||!image||stock<=0||price<=0) continue;
    out.push({id:normalize(p.id),legacyId:legacy,title:p.title,handle:p.handle,vendor:p.vendor||"",createdAt:p.createdAt||"",image,stock,availableVariants:available.length,price,compare});
  }
  return out;
}

function isFullPrice(p:Product):boolean { return !p.compare || p.compare<=p.price+0.001; }
function vendorKey(v:string):string { return v.toLowerCase().replace(/[^a-z0-9]/g,""); }
function choose(products:Product[],vendor:string,preferred:string[]):Product {
  const target=vendorKey(vendor);
  const eligible=products.filter((p)=>vendorKey(p.vendor).includes(target)&&isFullPrice(p)&&p.stock>0).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||b.stock-a.stock);
  if(!eligible.length) throw new Error(`no_full_price_stock_for_vendor:${vendor}`);
  for(const needle of preferred){ const hit=eligible.find((p)=>p.title.toLowerCase().includes(needle.toLowerCase())); if(hit) return hit; }
  return eligible[0];
}

async function findSegment(apiKey:string,name:string):Promise<JsonObject|null>{ const q=new URLSearchParams(); q.set("filter",`equals(name,'${filterLiteral(name)}')`); q.set("page[size]","10"); const p=await must(apiKey,"/api/segments?"+q.toString()); for(const item of Array.isArray(p.data)?p.data:[]){ const row=obj(item); if(normalize(obj(row.attributes).name)===name) return row; } return null; }
function campaignMessageId(row:JsonObject):string { const rel=obj(obj(row.relationships)["campaign-messages"]); const data=Array.isArray(rel.data)?rel.data:[]; return data.length?normalize(obj(data[0]).id):""; }
async function findCampaign(apiKey:string,name:string):Promise<JsonObject|null>{ const q=new URLSearchParams(); q.set("filter",`and(equals(messages.channel,'email'),contains(name,'${filterLiteral(name)}'))`); q.set("include","campaign-messages"); q.set("page[size]","10"); const p=await must(apiKey,"/api/campaigns?"+q.toString()); for(const item of Array.isArray(p.data)?p.data:[]){ const row=obj(item); if(normalize(obj(row.attributes).name)===name) return row; } return null; }
async function getCampaign(apiKey:string,id:string):Promise<JsonObject>{ return obj((await must(apiKey,`/api/campaigns/${encodeURIComponent(id)}?include=campaign-messages`)).data); }
function campaignStatus(row:JsonObject):string { return normalize(obj(row.attributes).status); }
function includedAudiences(row:JsonObject):string[]{ const a=obj(obj(row.attributes).audiences); return Array.isArray(a.included)?a.included.map(normalize).filter(Boolean):[]; }

async function senderIdentity(apiKey:string):Promise<{from_email:string;from_label:string;reply_to_email:string}>{ const source=await must(apiKey,`/api/campaigns/${SOURCE_CAMPAIGN}?include=campaign-messages`); const row=obj(source.data); const mid=campaignMessageId(row); if(!mid) throw new Error("sender_source_message_missing"); const msg=await must(apiKey,`/api/campaign-messages/${mid}`); const definition=obj(obj(obj(msg.data).attributes).definition); const c=obj(definition.content); const from_email=normalize(c.from_email),from_label=normalize(c.from_label),reply_to_email=normalize(c.reply_to_email)||from_email; if(!from_email||!from_label) throw new Error("sender_identity_missing"); return{from_email,from_label,reply_to_email}; }

async function waitScheduled(apiKey:string,id:string):Promise<JsonObject>{ for(let i=0;i<30;i+=1){ const c=await getCampaign(apiKey,id); const s=campaignStatus(c).toLowerCase(); if(s==="scheduled"||s.startsWith("queued")) return c; await sleep(1000); } throw new Error(`schedule_readback_timeout:${id}`); }
async function schedule(apiKey:string,id:string):Promise<JsonObject>{ const r=await kfetch(apiKey,"/api/campaign-send-jobs",{method:"POST",body:JSON.stringify({data:{type:"campaign-send-job",id}})}); if(!r.ok) throw new Error(`schedule_failed:${id}:${r.status}`); return waitScheduled(apiKey,id); }

function esc(v:string):string { return v.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function money(v:number):string { return new Intl.NumberFormat("it-IT",{style:"currency",currency:"EUR"}).format(v); }
function trackedPath(path:string,content:string):string { const sep=path.includes("?")?"&":"?"; return `${path}${sep}utm_source=klaviyo&utm_medium=email&utm_campaign=sneakers_new_season_010926&utm_content=${encodeURIComponent(content)}`; }
function discountLink(path:string,content:string):string { return `https://devidlabel.com/discount/${CODE}?redirect=${encodeURIComponent(trackedPath(path,content))}`; }
function productCard(p:Product,kind:"uomo"|"donna",copy:string,content:string):string {
  const link=esc(discountLink(`/products/${p.handle}`,content));
  return `<tr><td style="padding:0 28px 30px"><a href="${link}" style="text-decoration:none;color:#111"><img src="${esc(p.image)}" width="544" alt="${esc(p.title)}" style="display:block;width:100%;height:auto;border:0"><div style="padding-top:14px;font:700 11px/16px Arial,sans-serif;letter-spacing:1.7px;color:#666">${esc(p.vendor.toUpperCase())} · ${kind.toUpperCase()}</div><div style="padding-top:5px;font:700 23px/29px Georgia,serif">${esc(p.title)}</div><p style="margin:7px 0 0;font:14px/22px Arial,sans-serif;color:#444">${esc(copy)}</p><div style="padding-top:8px;font:700 14px/20px Arial,sans-serif">${money(p.price)}</div><div style="padding-top:10px;font:700 12px/18px Arial,sans-serif;letter-spacing:1.1px">SCOPRI · -10% CON ${CODE} →</div></a></td></tr>`;
}

function emailHtml(selection:{uomo:{fourb:Product;puraai:Product;flower:Product};donna:{fourb:Product;puraai:Product;flower:Product}}):string {
  const hero=esc(discountLink("/collections/nuovi-arrivi","hero")); const uomo=esc(discountLink("/collections/sneakers-uomo","cta_uomo")); const donna=esc(discountLink("/collections/sneakers-donna","cta_donna")); const final=esc(discountLink("/collections/nuovi-arrivi","final_cta"));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#eee}@media(max-width:620px){.wrap{width:100%!important}.hero{padding:36px 22px!important}.headline{font-size:40px!important;line-height:44px!important}.twocol td{display:block!important;width:100%!important;padding:5px 0!important}}</style></head><body><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eee"><tr><td align="center"><table role="presentation" width="600" class="wrap" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#fff"><tr><td align="center" style="background:#080808;padding:22px"><img src="${LOGO}" width="220" alt="Devid Label" style="display:block;max-width:70%;height:auto;border:0"></td></tr><tr><td class="hero" align="center" style="padding:48px 34px 34px"><div style="font:700 11px/16px Arial,sans-serif;letter-spacing:2.2px">NEW SEASON · SNEAKERS</div><div class="headline" style="padding:14px 0 8px;font:700 52px/55px Georgia,serif">NUOVA STAGIONE.<br>NUOVE SNEAKERS.</div><p style="max-width:490px;margin:10px auto 22px;font:16px/25px Arial,sans-serif;color:#333">La nuova stagione è iniziata. Abbiamo scelto alcune delle novità <b>4B12, Puraai e Flower Mountain</b> appena arrivate, tra modelli Uomo e Donna.</p><a href="${hero}" style="display:inline-block;background:#080808;color:#fff;text-decoration:none;font:700 12px/18px Arial,sans-serif;letter-spacing:1.3px;padding:16px 22px">USA ${CODE} E SCOPRI LE NOVITÀ</a></td></tr><tr><td align="center" style="padding:0 28px 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f1f1;border:1px solid #dedede"><tr><td align="center" style="padding:24px 18px"><div style="font:700 11px/16px Arial,sans-serif;letter-spacing:2px">INIZIO STAGIONE · -10%</div><div style="padding:8px 0 4px;font:700 34px/40px Georgia,serif">${CODE}</div><div style="font:14px/21px Arial,sans-serif;color:#444">Usalo sulla selezione New Season fino al <b>10/09</b>.</div></td></tr></table></td></tr><tr><td style="padding:0 28px 22px"><div style="font:700 12px/18px Arial,sans-serif;letter-spacing:2px;color:#666">LE NOSTRE SCELTE UOMO</div><div style="padding-top:5px;font:700 34px/40px Georgia,serif">Tre modi di iniziare settembre.</div></td></tr>${productCard(selection.uomo.fourb,"uomo","Pulita, decisa, facile da abbinare anche con i primi look autunnali.","uomo_4b12")}${productCard(selection.uomo.puraai,"uomo","Toni e dettagli pensati per entrare nella nuova stagione senza complicazioni.","uomo_puraai")}${productCard(selection.uomo.flower,"uomo","Materiali e carattere Flower Mountain per i primi look Autunno/Inverno.","uomo_flower")}<tr><td align="center" style="padding:0 28px 38px"><a href="${uomo}" style="display:inline-block;background:#080808;color:#fff;text-decoration:none;font:700 12px/18px Arial,sans-serif;letter-spacing:1.4px;padding:15px 22px">SHOP SNEAKERS UOMO · ${CODE}</a></td></tr><tr><td style="background:#111;color:#fff;padding:32px 28px 26px"><div style="font:700 12px/18px Arial,sans-serif;letter-spacing:2px;color:#bbb">LE NOSTRE SCELTE DONNA</div><div style="padding-top:6px;font:700 34px/40px Georgia,serif">Nuovi arrivi, stesso passo deciso.</div></td></tr><tr><td style="height:24px;background:#fff"></td></tr>${productCard(selection.donna.fourb,"donna","Una base facile da portare ora, con dettagli che fanno subito nuova stagione.","donna_4b12")}${productCard(selection.donna.puraai,"donna","Essenziale ma con abbastanza carattere da non passare inosservata.","donna_puraai")}${productCard(selection.donna.flower,"donna","Colori, costruzione tecnica e il mix di materiali che rende Flower Mountain riconoscibile.","donna_flower")}<tr><td align="center" style="padding:0 28px 38px"><a href="${donna}" style="display:inline-block;background:#080808;color:#fff;text-decoration:none;font:700 12px/18px Arial,sans-serif;letter-spacing:1.4px;padding:15px 22px">SHOP SNEAKERS DONNA · ${CODE}</a></td></tr><tr><td align="center" style="background:#f3f3f3;padding:36px 28px"><div style="font:700 11px/16px Arial,sans-serif;letter-spacing:2px">INIZIA LA NUOVA STAGIONE CON -10%</div><p style="max-width:450px;margin:10px auto 20px;font:15px/23px Arial,sans-serif;color:#444">Se stavi aspettando il momento giusto per scegliere le prossime sneakers, eccolo. Il codice <b>${CODE}</b> è valido fino al 10/09.</p><a href="${final}" style="display:inline-block;background:#080808;color:#fff;text-decoration:none;font:700 12px/18px Arial,sans-serif;letter-spacing:1.4px;padding:16px 22px">USA ${CODE} · SHOP NEW SEASON</a></td></tr><tr><td align="center" style="padding:25px;font:11px/18px Arial,sans-serif;color:#777">Devid Label · M.A.R.E. Srl<br>{% unsubscribe %}</td></tr></table></td></tr></table></body></html>`;
}

function campaignSummary(row:JsonObject):JsonObject { const a=obj(row.attributes); return { id:normalize(row.id), name:normalize(a.name), status:normalize(a.status), scheduled_at:a.scheduled_at??null, send_strategy:a.send_strategy??null, audiences:a.audiences??null, send_options:a.send_options??null, tracking_options:a.tracking_options??null }; }
function productSummary(p:Product):JsonObject { return { title:p.title,vendor:p.vendor,handle:p.handle,stock:p.stock,available_variants:p.availableVariants,price:p.price,compare_at:p.compare,full_price:isFullPrice(p) }; }

async function resolveInputs(env:Env,apiKey:string):Promise<{clickers:JsonObject;morningDonna:JsonObject;morningUomo:JsonObject;excludedIds:string[];selection:{uomo:{fourb:Product;puraai:Product;flower:Product};donna:{fourb:Product;puraai:Product;flower:Product}}}> {
  const [uomoAll,donnaAll,clickers,morningDonna,morningUomo]=await Promise.all([loadCollection(env,COLLECTION_UOMO),loadCollection(env,COLLECTION_DONNA),findSegment(apiKey,CLICKER_SEGMENT_NAME),findCampaign(apiKey,MORNING_DONNA),findCampaign(apiKey,MORNING_UOMO)]);
  if(!clickers) throw new Error("click90_segment_not_found"); if(!morningDonna||!morningUomo) throw new Error("morning_sneaker_campaign_not_found");
  const donnaStatus=campaignStatus(morningDonna).toLowerCase(),uomoStatus=campaignStatus(morningUomo).toLowerCase(); if(donnaStatus!=="sent"||uomoStatus!=="sent") throw new Error(`morning_campaign_status_unexpected:donna=${donnaStatus}:uomo=${uomoStatus}`);
  const excludedIds=[...new Set([...includedAudiences(morningDonna),...includedAudiences(morningUomo)])]; if(!excludedIds.length) throw new Error("morning_campaign_exclusion_audiences_missing");
  const selection={uomo:{fourb:choose(uomoAll,"4b12",["Hyper U-3027","Hyper"]),puraai:choose(uomoAll,"puraai",["1.01 Vintage Eclipse","Vintage Eclipse"]),flower:choose(uomoAll,"flower mountain",["Yamano 3 Man Cream/Brown/Taupe","Yamano 3 Man","Yamano"])},donna:{fourb:choose(donnaAll,"4b12",["PlayNew D-2045 White/Bronze","PlayNew D-2045","PlayNew"]),puraai:choose(donnaAll,"puraai",["6.01 XS Ice Skating","Ice Skating"]),flower:choose(donnaAll,"flower mountain",["Yamabushi Woman Cognac/Taupe/Pink","Yamabushi Woman","Yamabushi"])}};
  return {clickers,morningDonna,morningUomo,excludedIds,selection};
}

async function execute(env:Env):Promise<JsonObject> {
  const apiKey=normalize(env.KLAVIYO_OPERATIONS_API_KEY); if(!apiKey) throw new Error("klaviyo_operations_not_configured");
  const resolved=await resolveInputs(env,apiKey); const clickerId=normalize(resolved.clickers.id); if(!clickerId) throw new Error("click90_segment_id_missing");
  const existing=await findCampaign(apiKey,CAMPAIGN_NAME); if(existing){ const status=campaignStatus(existing).toLowerCase(); if(status==="scheduled"||status.startsWith("queued")||status==="sent") return {ok:true,operation:"sneakers_new_season_sep01",mutation_performed:false,idempotent_replay:true,campaign:campaignSummary(existing),note:"campaign_already_scheduled_or_sent"}; throw new Error(`campaign_exists_bad_status:${status}`); }
  const sender=await senderIdentity(apiKey); const html=emailHtml(resolved.selection);
  const created=await must(apiKey,"/api/campaigns",{method:"POST",body:JSON.stringify({data:{type:"campaign",attributes:{name:CAMPAIGN_NAME,audiences:{included:[clickerId],excluded:resolved.excludedIds},send_strategy:{method:"static",datetime:SEND_AT,options:{is_local:false}},send_options:{use_smart_sending:false},tracking_options:{add_tracking_params:true,custom_tracking_params:[],is_tracking_clicks:true,is_tracking_opens:true},"campaign-messages":{data:[{type:"campaign-message",attributes:{definition:{channel:"email",label:CAMPAIGN_NAME,content:{subject:SUBJECT,preview_text:PREVIEW,from_email:sender.from_email,from_label:sender.from_label,reply_to_email:sender.reply_to_email}}}}]}}}})});
  const row=obj(created.data); const id=normalize(row.id); if(!id) throw new Error("campaign_created_without_id"); await sleep(1200); const full=await getCampaign(apiKey,id); const mid=campaignMessageId(full); if(!mid) throw new Error("campaign_message_missing");
  const update=await updateKlaviyoCampaignDraft({approval_confirmation:"UPDATE KLAVIYO DRAFT",campaign_id:id,campaign_message_id:mid,subject:SUBJECT,preview_text:PREVIEW,html_body:html,use_smart_sending:false},env); const scheduled=await schedule(apiKey,id);
  return {ok:true,operation:"sneakers_new_season_sep01",mutation_performed:true,campaign:campaignSummary(scheduled),campaign_message_id:mid,update_status:normalize(update.status),audience:{included_segment:{id:clickerId,name:CLICKER_SEGMENT_NAME,profile_count:obj(resolved.clickers.attributes).profile_count??null},excluded_morning_audience_ids:resolved.excludedIds,morning_campaigns:[campaignSummary(resolved.morningDonna),campaignSummary(resolved.morningUomo)],smart_sending:false,marketing_consent_included_in_click90_segment:true},promotion:{code:CODE,discount_percent:10,valid_through:"2026-09-10",cta_auto_applies_code:true},merchandising:{uomo:Object.fromEntries(Object.entries(resolved.selection.uomo).map(([k,p])=>[k,productSummary(p)])),donna:Object.fromEntries(Object.entries(resolved.selection.donna).map(([k,p])=>[k,productSummary(p)]))},safety:{user_approved:true,send_at:SEND_AT,exclusion_strategy:"exclude the audience segments used by both Sep 1 morning sneaker sends",tracking:true,gender_inference_used:false,product_gender_source:"Shopify sneakers-uomo / sneakers-donna collections"}};
}

async function preflight(env:Env):Promise<JsonObject> { const apiKey=normalize(env.KLAVIYO_OPERATIONS_API_KEY); if(!apiKey) throw new Error("klaviyo_operations_not_configured"); const r=await resolveInputs(env,apiKey); return {ok:true,mutation_performed:false,send_at:SEND_AT,campaign_name:CAMPAIGN_NAME,subject:SUBJECT,preview:PREVIEW,audience:{included:{id:normalize(r.clickers.id),name:CLICKER_SEGMENT_NAME,profile_count:obj(r.clickers.attributes).profile_count??null},excluded_ids:r.excludedIds,morning_donna:campaignSummary(r.morningDonna),morning_uomo:campaignSummary(r.morningUomo)},promotion:{code:CODE,percent:10,valid_through:"2026-09-10"},merchandising:{uomo:Object.fromEntries(Object.entries(r.selection.uomo).map(([k,p])=>[k,productSummary(p)])),donna:Object.fromEntries(Object.entries(r.selection.donna).map(([k,p])=>[k,productSummary(p)]))}}; }

export async function handleSneakersNewSeason010926(request:Request,env:Env):Promise<Response|null> { const url=new URL(request.url); if(url.pathname!==PATH) return null; if(!await authorized(request)) return json({ok:false,error:"unauthorized"},401); try { if(request.method==="GET") return json(await preflight(env)); if(request.method!=="POST") return json({ok:false,error:"method_not_allowed"},405); let body:JsonObject={}; try{body=await request.json() as JsonObject;}catch{return json({ok:false,error:"invalid_json"},400);} if(normalize(body.approval)!==APPROVAL) return json({ok:false,error:"approval_required"},409); return json(await execute(env)); } catch(error){ return json({ok:false,error:error instanceof Error?error.message:"sneakers_new_season_failed"},500); } }
