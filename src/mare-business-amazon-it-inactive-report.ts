import {getAmazonAccessToken,type AmazonCredentials} from "./amazon-auth.js";
type Row=Record<string,unknown>;
type Env=AmazonCredentials;
type Deps={getAccessToken?:typeof getAmazonAccessToken;fetch?:typeof fetch;clock?:()=>number};
const ROOT="https://sellingpartnerapi-eu.amazon.com";
const TYPE="GET_MERCHANT_LISTINGS_INACTIVE_DATA";
const IT="APJ6JRA9NG5V4";
const MAX=80000;
function obj(v:unknown):Row{return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};}
function validReportId(v:unknown):v is string{return typeof v==="string"&&/^[0-9]{3,32}$/.test(v);}
function checkRequest(input:unknown):void{
  if(input===null||typeof input!=="object"||Array.isArray(input)||
     Object.keys(input).length!==0)throw Error("amazon_it_inactive_report_invalid_request");
}
function sanitizedReport(raw:Row):Row|null{
 if(raw.reportType!==TYPE||!validReportId(raw.reportId)||
    typeof raw.createdTime!=="string"||!Number.isFinite(Date.parse(raw.createdTime))||
    !["IN_QUEUE","IN_PROGRESS","DONE","CANCELLED","FATAL"].includes(String(raw.processingStatus)))
   return null;
 return {report_id:raw.reportId,status:raw.processingStatus,
   created_at:raw.createdTime,document_available:typeof raw.reportDocumentId==="string"&&
     raw.reportDocumentId.length>0};
}
async function apiJson(url:string,token:string,method:"GET"|"POST",fetcher:typeof fetch,body?:Row):Promise<Row>{
 let res:Response;
 try{res=await fetcher(url,{method,redirect:"manual",signal:AbortSignal.timeout(18000),
   headers:{"x-amz-access-token":token,Accept:"application/json",
     ...(method==="POST"?{"Content-Type":"application/json"}:{})},
   ...(body?{body:JSON.stringify(body)}:{})});}
 catch{throw Error("amazon_inactive_report_transport_failed");}
 if(res.status!==(method==="GET"?200:202)&&!(method==="POST"&&res.status===200))
   throw Error("amazon_inactive_report_provider_http_"+res.status);
 if(!/^application\/json(?:\s*;|$)/i.test(res.headers.get("content-type")??""))
   throw Error("amazon_inactive_report_content_type");
 const bytes=Number(res.headers.get("content-length")||"0");
 if(!Number.isFinite(bytes)||bytes>MAX)throw Error("amazon_inactive_report_response_too_large");
 const text=await res.text();if(text.length>MAX)throw Error("amazon_inactive_report_response_too_large");
 try{return obj(JSON.parse(text));}catch{throw Error("amazon_inactive_report_response_invalid");}
}
async function reports(env:Env,deps:Deps):Promise<{latest:Row|null;token:string}>{
 const token=await(deps.getAccessToken??getAmazonAccessToken)(env);
 if(typeof token!=="string"||!token||token.length>16000||/[\u0000-\u0020\u007f]/.test(token))
   throw Error("amazon_inactive_report_auth_unverified");
 const url=new URL(ROOT+"/reports/2021-06-30/reports");
 url.searchParams.set("reportTypes",TYPE);
 url.searchParams.set("marketplaceIds",IT);
 url.searchParams.set("pageSize","20");
 const json=await apiJson(url.toString(),token,"GET",deps.fetch??fetch);
 if(!Array.isArray(json.reports)||json.reports.length>20)
   throw Error("amazon_inactive_report_list_unverified");
 const entries=json.reports.map(obj).map(sanitizedReport).filter((x):x is Row=>x!==null);
 entries.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
 return {latest:entries[0]??null,token};
}
const flags={marketplace:"IT",report_type:TYPE,listing_mutations:0,
  stock_writes:0,price_writes:0,frontend_unchanged:true,
  channable_writer_unchanged:true,can_publish:false};
export async function readAmazonItInactiveReportStatus(raw:unknown,env:Env,deps:Deps={}):Promise<Row>{
 checkRequest(raw);
 const {latest}=await reports(env,deps);
 return {ok:true,status:"READ_ONLY_AMAZON_REPORT_METADATA",
   latest_report:latest,report_available:latest?.status==="DONE"&&
     latest.document_available===true,...flags};
}
/**
 * Creates only a merchant-private Amazon *report job*, not a listing/feed.
 * Reuses any report under 6 hours old; no polling or feed submission.
 */
export async function requestAmazonItInactiveReport(raw:unknown,env:Env,deps:Deps={}):Promise<Row>{
 checkRequest(raw);
 const {latest,token}=await reports(env,deps);
 const now=(deps.clock??Date.now)();
 if(!Number.isFinite(now)||now<0)throw Error("amazon_inactive_report_clock_invalid");
 const age=latest?now-Date.parse(String(latest.created_at)):Infinity;
 if(latest&&age>=0&&age<6*3600000&&
   ["IN_QUEUE","IN_PROGRESS","DONE"].includes(String(latest.status)))
   return {ok:true,status:"REPORT_REUSED",report_request_created:false,
     report:latest,report_document_is_private:true,...flags};
 const json=await apiJson(ROOT+"/reports/2021-06-30/reports",token,"POST",
   deps.fetch??fetch,{reportType:TYPE,marketplaceIds:[IT],
     reportOptions:{preferredReportDocumentLocale:"en_US"}});
 if(!validReportId(json.reportId))
   throw Error("amazon_inactive_report_create_unverified");
 return {ok:true,status:"REPORT_REQUESTED",report_request_created:true,
   report:{report_id:json.reportId,status:"IN_QUEUE",document_available:false},
   report_document_is_private:true,...flags};
}
