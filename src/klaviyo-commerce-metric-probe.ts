type JsonObject = Record<string, unknown>;

type Env = {
  KLAVIYO_OPERATIONS_API_KEY?: string;
  KLAVIYO_PRIVATE_API_KEY?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
  DAILY_PULSE_ACCESS_TOKEN?: string;
};

const API = "https://a.klaviyo.com";
const REVISION = "2026-07-15";
const METRICS = [
  { id: "Rbee4j", label: "Clicked Email" },
  { id: "UejCPq", label: "Viewed Product" },
  { id: "SXnBMm", label: "Added to Cart" },
  { id: "TQUiiS", label: "Checkout" },
  { id: "SFvtr2", label: "Historical Product Purchase A" },
  { id: "T4UMVy", label: "Historical Product Purchase B" }
];

function normalize(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }
function obj(v: unknown): JsonObject { return v && typeof v === "object" && !Array.isArray(v) ? v as JsonObject : {}; }
function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff" } }); }
function timingSafeEqualText(left:string,right:string):boolean{if(!left||!right||left.length!==right.length)return false;let diff=0;for(let i=0;i<left.length;i+=1)diff|=left.charCodeAt(i)^right.charCodeAt(i);return diff===0;}
function authorized(request:Request,env:Env):boolean{const h=request.headers.get("Authorization")||"";const supplied=h.startsWith("Bearer ")?h.slice(7).trim():"";const accepted=[normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN),normalize(env.DAILY_PULSE_ACCESS_TOKEN)].filter(Boolean);return accepted.some((e)=>timingSafeEqualText(supplied,e));}
async function get(apiKey:string,path:string):Promise<{status:number;body:JsonObject}>{const r=await fetch(API+path,{headers:{Accept:"application/vnd.api+json",Authorization:`Klaviyo-API-Key ${apiKey}`,revision:REVISION}});let body:JsonObject={};try{body=await r.json() as JsonObject;}catch{}return{status:r.status,body};}
function safeSamples(v:unknown):unknown[]{if(!Array.isArray(v))return[];return v.slice(0,12).map((x)=>typeof x==="string"?x.slice(0,180):(typeof x==="number"||typeof x==="boolean"?x:null)).filter((x)=>x!==null);}

export async function handleKlaviyoCommerceMetricProbeRequest(request:Request,env:Env):Promise<Response|null>{
  const url=new URL(request.url);
  if(url.pathname!=="/internal/klaviyo/commerce-metric-probe")return null;
  if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);
  if(!authorized(request,env))return json({ok:false,error:"unauthorized"},401);
  const apiKey=normalize(env.KLAVIYO_OPERATIONS_API_KEY)||normalize(env.KLAVIYO_PRIVATE_API_KEY);
  if(!apiKey)return json({ok:false,error:"klaviyo_api_key_missing"},503);
  const out:JsonObject[]=[];
  for(const metric of METRICS){
    const r=await get(apiKey,`/api/metrics/${metric.id}/metric-properties?additional-fields[metric-property]=sample_values`);
    const props=Array.isArray(r.body.data)?(r.body.data as JsonObject[]).map((row)=>{const a=obj(row.attributes);const name=normalize(a.property);return{property:name||null,label:a.label??null,inferred_type:a.inferred_type??null,sample_values:/email|phone|address|name|profile|customer/i.test(name)?[]:safeSamples(a.sample_values)};}):[];
    out.push({metric_id:metric.id,label:metric.label,status:r.status,properties:props});
    await new Promise((resolve)=>setTimeout(resolve,700));
  }
  return json({ok:true,generated_at:new Date().toISOString(),metrics:out,notes:["Read-only metric metadata. Personal/contact-like property samples are suppressed."]});
}
