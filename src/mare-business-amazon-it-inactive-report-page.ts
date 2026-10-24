import {getAmazonAccessToken,type AmazonCredentials} from "./amazon-auth.js";
type Row=Record<string,unknown>;
type Deps={getAccessToken?:typeof getAmazonAccessToken;fetch?:typeof fetch;clock?:()=>number};
const ROOT="https://sellingpartnerapi-eu.amazon.com",MARKET="APJ6JRA9NG5V4";
const TYPE="GET_MERCHANT_LISTINGS_INACTIVE_DATA";
const MAX_BYTES=8*1024*1024,MAX_UNZIP=24*1024*1024;
const SKU=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/,ASIN=/^[A-Z0-9]{10}$/;
function obj(v:unknown):Row{return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};}
async function limited(stream:ReadableStream<Uint8Array>,max:number):Promise<Uint8Array>{
 const reader=stream.getReader();const parts:Uint8Array[]=[];let len=0;
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;
   len+=chunk.value.byteLength;if(len>max)throw Error("report_too_large");
   parts.push(chunk.value);
 }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const output=new Uint8Array(len);let n=0;for(const p of parts){output.set(p,n);n+=p.length;}
 return output;
}
async function readJson(url:string,token:string,fetcher:typeof fetch):Promise<Row>{
 const res=await fetcher(url,{method:"GET",redirect:"manual",signal:AbortSignal.timeout(20000),
   headers:{"x-amz-access-token":token,Accept:"application/json"}});
 if(res.status!==200||!res.body||
    !/^application\/json(?:\s*;|$)/i.test(res.headers.get("content-type")??""))
   throw Error("amazon_report_metadata_unverified");
 const bytes=await limited(res.body,160000);
 return obj(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)));
}
function headerIndex(a:string[],names:string[]):number{
 const p=a.map((x,i)=>names.includes(x)?i:-1).filter(x=>x>=0);
 return p.length===1?p[0]:-1;
}
export async function readAmazonItInactiveReportPage(raw:unknown,env:AmazonCredentials,deps:Deps={}):Promise<Row>{
 const input=obj(raw),keys=Object.keys(input);
 if(keys.some(k=>!["after","limit"].includes(k))||raw===null||typeof raw!=="object"||
    Array.isArray(raw)||keys.length>2)throw Error("amazon_inactive_report_page_invalid_request");
 const after=input.after??0,limit=input.limit??30;
 if(!Number.isSafeInteger(after)||after<0||after>100000||
    !Number.isSafeInteger(limit)||limit<1||limit>50)
   throw Error("amazon_inactive_report_page_invalid_request");
 const token=await(deps.getAccessToken??getAmazonAccessToken)(env);
 if(typeof token!=="string"||!token||token.length>16000||/[\u0000-\u0020\u007f]/.test(token))
   throw Error("amazon_report_auth_unverified");
 const fetcher=deps.fetch??fetch;
 const url=new URL(ROOT+"/reports/2021-06-30/reports");
 url.searchParams.set("reportTypes",TYPE);
 url.searchParams.set("marketplaceIds",MARKET);
 url.searchParams.set("pageSize","20");
 const list=await readJson(url.toString(),token,fetcher);
 if(!Array.isArray(list.reports)||list.reports.length>20)throw Error("amazon_report_list_invalid");
 const done=list.reports.map(obj).filter(r=>r.reportType===TYPE&&r.processingStatus==="DONE"&&
    typeof r.reportDocumentId==="string"&&r.reportDocumentId.length<=100&&
    /^[A-Za-z0-9_-]+$/.test(r.reportDocumentId));
 done.sort((a,b)=>String(b.createdTime??"").localeCompare(String(a.createdTime??"")));
 if(!done.length)return {ok:false,status:"NO_COMPLETED_REPORT",marketplace:"IT",read_only:true,
   listing_mutations:0,can_publish:false};
 const report=done[0];
 const now=(deps.clock??Date.now)(),created=Date.parse(String(report.createdTime));
 if(!Number.isFinite(created)||!Number.isFinite(now)||now-created<0||now-created>24*3600000)
   return {ok:false,status:"REPORT_TOO_OLD",marketplace:"IT",read_only:true,
     listing_mutations:0,can_publish:false};
 const doc=await readJson(ROOT+"/reports/2021-06-30/documents/"+
   encodeURIComponent(String(report.reportDocumentId)),token,fetcher);
 if(typeof doc.url!=="string"||doc.url.length>4096)throw Error("amazon_report_document_invalid");
 const signed=new URL(doc.url);
 if(signed.protocol!=="https:"||signed.port||signed.username||signed.password||
    !signed.hostname.endsWith(".amazonaws.com"))
   throw Error("amazon_report_document_host_invalid");
 let download:Response;
 try{download=await fetcher(signed.toString(),{method:"GET",redirect:"error",signal:AbortSignal.timeout(22000)});}
 catch{throw Error("amazon_report_signed_download_unavailable");}
 if(download.status!==200||!download.body)throw Error("amazon_report_download_failed");
 let bytes=await limited(download.body,MAX_BYTES);
 if(doc.compressionAlgorithm==="GZIP"){
   bytes=await limited(new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(
     new DecompressionStream("gzip")),MAX_UNZIP);
 }else if(doc.compressionAlgorithm!==undefined&&doc.compressionAlgorithm!==null){
   throw Error("amazon_report_compression_unsupported");
 }
 let content:string;
 if(bytes[0]===255&&bytes[1]===254)content=new TextDecoder("utf-16le",{fatal:true}).decode(bytes);
 else if(bytes[0]===254&&bytes[1]===255)content=new TextDecoder("utf-16be",{fatal:true}).decode(bytes);
 else content=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
 const lines=content.replace(/^\uFEFF/,"").split(/\r?\n/).filter(x=>x.length>0);
 if(lines.length<2||lines.length>300000)throw Error("amazon_report_rows_invalid");
 const headings=lines[0].split("\t").map(x=>x.trim().toLowerCase());
 const skuCol=headerIndex(headings,["sku","seller-sku","seller_sku"]);
 const asinCol=headerIndex(headings,["asin","asin 1","asin1"]);
 const statusCol=headerIndex(headings,["status","stato"]);
 const reasonCol=headerIndex(headings,["reason","motivo"]);
 const issueCol=headerIndex(headings,["issue description","descrizione del problema"]);
 // This is already the Amazon INACTIVE report type: some official templates
 // have no status or reason columns. Never turn their absence into ACTIVE.
 if(skuCol<0||asinCol<0)throw Error("amazon_report_headers_unverified");
 const entries:Row[]=[],seen=new Set<string>();
 let malformed=0,duplicate=0,missingAsin=0,deleted=0;
 const codes:Record<string,number>={};
 for(const line of lines.slice(1)){
   const cells=line.split("\t");
   if(cells.length!==headings.length){malformed++;continue;}
   const sku=cells[skuCol]?.trim(),asin=cells[asinCol]?.trim(),
     status=statusCol<0?"INACTIVE":cells[statusCol]?.trim();
   if(!SKU.test(sku??"")){malformed++;continue;}
   if(seen.has(sku)){duplicate++;continue;}seen.add(sku);
   if(/delet|eliminat|cancel/i.test(status??"")){deleted++;continue;}
   if(!ASIN.test(asin??"")){missingAsin++;continue;}
   const detail=(String(reasonCol<0?"":cells[reasonCol])+" "+
     String(issueCol<0?"":cells[issueCol])).slice(0,3000);
   const category=/\b8541\b|conflitto di corrispondenza|matching conflict/i.test(detail)?
     "IDENTITY_8541":/\bgpsr\b|sicurezza dei prodotti|product safety|responsible person|persona responsabile/i.test(detail)?
     "GPSR_INDICATION":/\b100632\b/.test(detail)?"QUALIFICATION_100632_INDICATION":
     "UNCLASSIFIED_INACTIVE";
   codes[category]=(codes[category]||0)+1;
   entries.push({sku,asin,classification:category,shopify_stock:"NOT_VERIFIED",
     direct_seller_identity:"NOT_RECHECKED",gpsr_contact_approval:"NOT_VERIFIED"});
 }
 return {ok:true,status:"REPORT_INACTIVE_ASIN_CANDIDATES_READONLY",
   marketplace:"IT",report_id:report.reportId,report_created_at:report.createdTime,
   report_rows:lines.length-1,asin_candidate_rows:entries.length,
   malformed_rows:malformed,duplicate_skus:duplicate,
   deleted_rows_excluded:deleted,missing_asin_excluded:missingAsin,
   classification_counts:codes,after,limit,
   rows:entries.slice(after,after+limit),
   has_more:after+limit<entries.length,
   next_after:after+limit<entries.length?after+limit:null,
   all_candidates_require_live_shopify_stock_check:true,
   report_is_not_listing_buyability_proof:true,read_only:true,
   listing_mutations:0,can_publish:false,channable_writer_unchanged:true,
   raw_issue_descriptions_exposed:false,document_url_exposed:false};
}
