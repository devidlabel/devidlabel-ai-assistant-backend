import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare, Log, LogLevel} from "miniflare";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

// Synthetic providers and credentials only. The fixture imports the actual
// Worker entry point, including its authentication and MCP wrapper chain, and
// uses the actual order journal implementation with persistent SQLite storage.
// Fixture-only headers/routes, provider mocks, and storage inspection are never
// copied into production. Unmocked network calls are denied at two boundaries.
const fixture = `
 import worker, {MareMarketplaceOrderJournal} from "./src/worker-v4.ts";
 const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}});
 const TARGET="123-1234567-1234567", CANCELLED="234-2345678-2345678";
 const GID="gid://shopify/Order/111", SKU="00_SYNTHETIC SKU ";
 const kv=new Map();
 let mode="", metrics;
 const reset=()=>metrics={provider_calls:[],journal_paths:[],journal_names:[],line_order_ids:[],kv_puts:0,unmocked_calls:0};
 const amazonOrder=(id,zero=false)=>({orderId:id,createdTime:"2026-10-15T10:00:00Z",
   lastUpdatedTime:"2026-10-18T08:00:00Z",salesChannel:{channelName:"AMAZON",marketplaceId:"APJ6JRA9NG5V4"},
   fulfillment:{fulfilledBy:"MERCHANT",fulfillmentStatus:zero?"CANCELLED":"SHIPPED"},
   orderItems:[{orderItemId:id+"_LINE",quantityOrdered:zero?0:1,product:{sellerSku:SKU,asin:"B0TEST0001"},
     fulfillment:{quantityFulfilled:zero?0:1}},
     ...(!zero?[{orderItemId:id+"_LINE_2",quantityOrdered:2,product:{sellerSku:SKU,asin:"B0TEST0001"},fulfillment:{quantityFulfilled:2}},
       {orderItemId:id+"_LINE_3",quantityOrdered:1,product:{sellerSku:"002_OTHER",asin:"B0TEST0002"},fulfillment:{quantityFulfilled:1}}]:[])]});
 const shopifyOrder=()=>({id:GID,createdAt:"2026-10-15T11:00:00.000Z",sourceName:"amazon",sourceIdentifier:null,
   app:{name:"Channable"},customAttributes:[{key:"Amazon Order ID",value:TARGET}]});
 const mockFetch=async(input,init)=>{
   const req=input instanceof Request?input:new Request(input,init),url=new URL(req.url);
   metrics.provider_calls.push({host:url.hostname,path:url.pathname,method:req.method});
   if(url.hostname==="api.amazon.com"&&url.pathname==="/auth/o2/token"&&req.method==="POST")
     return json({access_token:"SYNTHETIC_LWA_ACCESS"});
   if(url.hostname==="sellingpartnerapi-eu.amazon.com"&&url.pathname==="/orders/2026-01-01/orders"&&req.method==="GET"){
     if(url.searchParams.get("fulfilledBy")!=="MERCHANT"||url.searchParams.get("includedData")!=="FULFILLMENT"||
       url.searchParams.get("marketplaceIds")!=="APJ6JRA9NG5V4"||url.searchParams.get("maxResultsPerPage")!=="100")
       throw Error("FIXTURE_UNEXPECTED_AMAZON_REQUEST");
     if(mode==="amazon_http_error")return json({message:"SYNTHETIC_PRIVATE_VALUE"},403);
     if(mode==="amazon_incomplete")return json({orders:[amazonOrder(TARGET)],pagination:{nextToken:"SYNTHETIC_NEXT_PAGE"}});
     return json({orders:[amazonOrder(TARGET),amazonOrder(CANCELLED,true)]});
   }
   if(url.hostname==="synthetic.myshopify.com"&&/\\/admin\\/api\\/[^/]+\\/graphql.json$/.test(url.pathname)&&req.method==="POST"){
     const body=await req.json(),query=body.query||"";
     if(/\\bmutation\\b/i.test(query))throw Error("PROVIDER_MUTATION_FORBIDDEN");
     if(query.includes("MareChannableAmazonOrderIndex")){
       if(mode==="shopify_error")return json({errors:[{message:"SYNTHETIC_PRIVATE_VALUE buyer@example.invalid 999999"}]});
       if(!body.variables.query.includes("source_name:amazon"))throw Error("FIXTURE_MISSING_SOURCE_FILTER");
       const rows=mode==="missing_reference"?[]:[shopifyOrder()];
       return json({data:{orders:{nodes:rows,pageInfo:{hasNextPage:false,endCursor:null}}}});
     }
     if(query.includes("MareChannableImportedAmazonOrder")){
       metrics.line_order_ids.push(body.variables.id);
       if(body.variables.id!==GID)throw Error("FIXTURE_CLIENT_CONTROLLED_SHOPIFY_GID");
       const order=shopifyOrder();
       if(mode==="wrong_external_reference")order.customAttributes[0].value=CANCELLED;
       order.lineItems={pageInfo:{hasNextPage:false,endCursor:null},nodes:[
         {id:"gid://shopify/LineItem/444",sku:SKU,quantity:3,currentQuantity:3,variant:{id:"gid://shopify/ProductVariant/666"}},
         {id:"gid://shopify/LineItem/555",sku:"002_OTHER",quantity:1,currentQuantity:1,variant:{id:"gid://shopify/ProductVariant/777"}}
       ]};
       return json({data:{order}});
     }
   }
   metrics.unmocked_calls++;
   throw Error("UNMOCKED_NETWORK_FORBIDDEN");
 };
 globalThis.fetch=mockFetch;
 export class FixtureJournal extends MareMarketplaceOrderJournal {
   async fetch(req){
     if(new URL(req.url).pathname==="/__test/inspect"){
       const all=await this.ctx.storage.list({prefix:"",limit:100});
       const entries=[...all];
       return json({keys:entries.map(([key])=>key),
         rows:entries.filter(([key])=>key.includes(":order:")).map(([,value])=>value),
         evidence_count:entries.filter(([key])=>key.startsWith("order-evidence:")).length,
         amazon_receipt_count:entries.filter(([key])=>key.startsWith("proof:v2:")).length,
         reservation_count:entries.filter(([key])=>key.includes(":reservation:")).length});
     }
     return super.fetch(req);
   }
 }
 export default {async fetch(req,env,ctx){
   reset();mode=req.headers.get("x-test-mode")||"";
   const namespace=env.TEST_JOURNAL;
   const scopedName=JSON.stringify(["orders-v1",env.COMMERCE_TENANT_ID,env.AMAZON_SP_API_SELLER_ID]);
   if(new URL(req.url).pathname==="/__test/inspect")
     return namespace.get(namespace.idFromName(scopedName)).fetch(new Request("https://fixture/__test/inspect"));
   const journal={idFromName:name=>{metrics.journal_names.push(name);return namespace.idFromName(name);},get:id=>({fetch:async request=>{
     const path=new URL(request.url).pathname;metrics.journal_paths.push(path);
     if((mode==="capture_transport_error"&&path==="/evidence/capture")||
       (mode==="read_transport_error"&&path==="/evidence/read"))throw Error("SYNTHETIC_PRIVATE_VALUE");
     const response=await namespace.get(id).fetch(request);
     if(!response.ok)return response;
     if(mode==="capture_bad_json"&&path==="/evidence/capture")return new Response('{"SYNTHETIC_PRIVATE_VALUE":');
     if(mode==="capture_http_error"&&path==="/evidence/capture")return json({error:"SYNTHETIC_PRIVATE_VALUE"},409);
     const proof=await response.json();
     if(mode==="capture_wrong_receipt"&&path==="/evidence/capture")proof.receipt_id="f".repeat(64);
     if(mode==="capture_wrong_shop"&&path==="/evidence/capture"){
       proof.shop_domain="other.myshopify.com";proof.manifest.shop_domain="other.myshopify.com";
     }
     if(mode==="capture_wrong_account"&&path==="/evidence/capture"){
       proof.account_id="A987654321";proof.manifest.account_id="A987654321";
     }
     if(mode==="capture_authority"&&path==="/evidence/capture")proof.can_send_tracking=true;
     if(mode==="capture_extra_field"&&path==="/evidence/capture")proof.unexpected="SYNTHETIC_PRIVATE_VALUE";
     if(mode==="read_wrong_receipt"&&path==="/evidence/read")proof.receipt_id="0".repeat(64);
     if(mode==="read_wrong_manifest"&&path==="/evidence/read")proof.manifest.target.shopify_lines[0].sku="DIFFERENT_SKU";
     return json(proof);
   }})};
   const runtimeEnv={...env,MARE_ORDER_JOURNAL:journal,SHOPIFY_TOKENS_KV:{
     get:async key=>kv.get(key)??null,put:async(key,value)=>{metrics.kv_puts++;kv.set(key,value);},
     delete:async key=>kv.delete(key),list:async()=>({keys:[],list_complete:true})
   }};
   if(mode==="disabled")runtimeEnv.MARE_ORDER_JOURNAL_ENABLED="false";
   if(mode==="unbound")delete runtimeEnv.MARE_ORDER_JOURNAL;
   if(mode==="other_tenant")runtimeEnv.COMMERCE_TENANT_ID="OTHER_SYNTHETIC_TENANT";
   const response=await worker.fetch(req,runtimeEnv,ctx);
   let result;try{result=await response.json();}catch{result={non_json:true};}
   return json({result,metrics},response.status);
 }};
`;

let checks = 0;
const equal = (actual, expected, label) => {assert.equal(actual, expected, label); checks++;};
const deep = (actual, expected, label) => {assert.deepEqual(actual, expected, label); checks++;};
const truth = (value, label) => {assert(value, label); checks++;};
const token = "synthetic-local-evidence-token";
const target = "123-1234567-1234567";
const request = {
  marketplaces: ["IT"], amazon_order_id: target,
  last_updated_after: "2026-10-18T07:00:00Z", last_updated_before: "2026-10-18T09:00:00Z",
  shopify_created_after: "2026-10-14T00:00:00Z", shopify_created_before: "2026-10-18T10:00:00Z",
};

// Client compatibility matters: Node-bundled MCP tests must not accidentally
// load cloudflare:workers merely by importing the new server-side gateway.
const neutral = await build({entryPoints:["src/marketplace-order-evidence-client.ts"],bundle:true,write:false,
  platform:"node",format:"esm",metafile:true,logLevel:"silent"});
truth(!Object.keys(neutral.metafile.inputs).some(path=>/order-journal\.ts$|worker-v[234]\.ts$|cloudflare:/.test(path)));
const client = await import("data:text/javascript;base64," + Buffer.from(neutral.outputFiles[0].text).toString("base64"));
equal(client.validateOrderEvidenceCaptureRequest(request).last_updated_after, "2026-10-18T07:00:00.000Z");
let attemptedReaderCalls = 0;
const neverRead = async () => {attemptedReaderCalls++;throw new Error("TEST_READER_MUST_NOT_RUN");};
await assert.rejects(()=>client.captureLiveMarketplaceOrderEvidence(request, {}, {
  amazon:neverRead,shopifyIndex:neverRead,shopifyLines:neverRead,
}), /marketplace_order_evidence_not_configured/);checks++;
equal(attemptedReaderCalls, 0);

const bundled = await build({stdin:{contents:fixture,sourcefile:"evidence-client-fixture.ts",resolveDir:process.cwd(),loader:"ts"},
  bundle:true,write:false,format:"esm",platform:"browser",external:["cloudflare:workers"],logLevel:"silent"});
const directory = await mkdtemp(join(tmpdir(), "mare-order-evidence-client-"));
let networkEscapes = 0;
const options = {name:"order-evidence-client-test",modules:true,script:bundled.outputFiles[0].text,
  compatibilityDate:"2026-06-25",durableObjects:{TEST_JOURNAL:{className:"FixtureJournal",useSQLite:true}},
  durableObjectsPersist:directory,bindings:{MARE_ORDER_JOURNAL_ENABLED:"true",MARE_BUSINESS_ACCESS_TOKEN:token,
    COMMERCE_TENANT_ID:"SYNTHETIC_TENANT",AMAZON_SP_API_SELLER_ID:"A123456789",SHOPIFY_SHOP_DOMAIN:"synthetic.myshopify.com",
    SHOPIFY_API_VERSION:"2026-10",SHOPIFY_ADMIN_ACCESS_TOKEN:"SYNTHETIC_SHOPIFY_TOKEN",
    AMAZON_SP_API_CLIENT_ID:"SYNTHETIC_CLIENT",AMAZON_SP_API_CLIENT_SECRET:"SYNTHETIC_SECRET",
    AMAZON_SP_API_REFRESH_TOKEN:"SYNTHETIC_REFRESH"},
  outboundService:async()=>{networkEscapes++;return new Response("NETWORK_FORBIDDEN",{status:503});},
  log:new Log(LogLevel.ERROR)};
let mf;
async function rpc(name, capability, payload, {mode="",auth=true}={}) {
  const response=await mf.dispatchFetch("https://fixture/mcp-business",{method:"POST",headers:{
    "Content-Type":"application/json","MCP-Protocol-Version":"2025-06-18","x-test-mode":mode,
    ...(auth?{Authorization:"Bearer "+token}:{})},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:{capability_id:capability,request:payload}}})});
  const body=await response.json();
  return {http:response.status,rpc:body.result,tool:body.result?.result,data:body.result?.result?.structuredContent,metrics:body.metrics};
}
const capture=(payload=request,extra={})=>rpc("mare_prepare","marketplace.order.evidence.capture",payload,extra);
const read=(id,extra={})=>rpc("mare_read","marketplace.order.evidence.read",{receipt_id:id},extra);
const inspect=async()=>await (await mf.dispatchFetch("https://fixture/__test/inspect")).json();
function noEffects(result,label) {
  equal(result.metrics.kv_puts,0,label+": no plan writes");
  equal(result.metrics.provider_calls.length,0,label+": no provider requests");
  equal(result.metrics.journal_paths.length,0,label+": no actor requests");
  equal(result.metrics.unmocked_calls,0,label+": no unmocked requests");
}
function failed(result,label) {
  truth(result.tool?.isError===true,label+": must fail");
  truth(!JSON.stringify(result.rpc).includes("SYNTHETIC_PRIVATE_VALUE"),label+": no raw upstream data");
  truth(!result.data?.independent_readback_verified,label+": no false verified result");
}

try {
  mf = new Miniflare(options);
  const unauthorized = await capture(request,{auth:false});
  equal(unauthorized.http,401);noEffects(unauthorized,"authentication");
  for (const field of ["amazon","shopify_index","shopify_lines","shopify_order_gid","account_id","tenant_id","shop_domain","url"]) {
    const invalid=await capture({...request,[field]:field==="shopify_order_gid"?"gid://shopify/Order/999":{untrusted:true}});
    failed(invalid,field);noEffects(invalid,field);
    equal(invalid.data.error,"marketplace_order_evidence_invalid_request",field);
  }
  for (const mode of ["disabled","unbound"]) {
    const disabled=await capture(request,{mode});failed(disabled,mode);noEffects(disabled,mode);
  }
  const readCapture=await rpc("mare_read","marketplace.order.evidence.capture",request);
  failed(readCapture,"capture cannot run through mare_read");noEffects(readCapture,"capture via read");

  const first=await capture();
  equal(first.http,200);equal(first.tool.isError,false);equal(first.data.plan.status,"completed");
  const proof=first.data.result;
  equal(proof.status,"CAPTURED");equal(proof.independent_readback_verified,true);
  equal(proof.amazon_order_id,target);equal(proof.shopify_order_gid,"gid://shopify/Order/111");
  equal(proof.shop_domain,"synthetic.myshopify.com");equal(proof.amazon_orders_in_batch,2);
  equal(proof.amazon_order_line_count,3);equal(proof.shopify_order_line_count,2);equal(proof.matched_unique_sku_count,2);
  equal(proof.import_state,"SHADOW_ONLY");equal(proof.provider_mutations,0);
  equal(proof.current_provider_state_reverified,false);equal(proof.does_not_prove_variant_mapping,true);
  for(const flag of ["can_create_order","can_publish_offer","can_activate_offer_stock","can_adjust_inventory","can_send_tracking",
    "can_confirm_shipment","can_advance_checkpoint","importer_enabled","scheduling_enabled","stock_effects"])
    equal(proof[flag],false,flag);
  equal(proof.reservations_unchanged,true);
  deep(first.metrics.line_order_ids,["gid://shopify/Order/111"],"GID derives from server index");
  deep(first.metrics.journal_paths,["/evidence/capture","/evidence/read"]);
  truth(first.metrics.journal_names.every(name=>name===JSON.stringify(["orders-v1","SYNTHETIC_TENANT","A123456789"])));
  equal(first.metrics.provider_calls.length,4);equal(first.metrics.kv_puts,2);equal(first.metrics.unmocked_calls,0);
  const saved=await inspect();
  equal(saved.evidence_count,1);equal(saved.amazon_receipt_count,1);equal(saved.reservation_count,0);equal(saved.rows.length,2);
  truth(saved.rows.every(row=>row.revision===1&&row.import_state==="SHADOW_ONLY"));
  equal(saved.rows.find(row=>row.order_id!==target).items[0].quantity_ordered,0,"cancelled zero observation retained");
  truth(saved.keys.every(key=>key.includes(":order:")||key.includes(":order_version:")||key.startsWith("proof:v2:")||key.startsWith("order-evidence:")),
    "no cursor/reservation/outbox records");

  const stored=await read(proof.receipt_id);
  equal(stored.tool.isError,false);equal(stored.data.status,"STORED_VERIFIED");equal(stored.data.receipt_id,proof.receipt_id);
  equal(stored.metrics.provider_calls.length,0);equal(stored.metrics.kv_puts,0);deep(stored.metrics.journal_paths,["/evidence/read"]);
  const replay=await capture();
  equal(replay.tool.isError,false);equal(replay.data.result.status,"ALREADY_CAPTURED");equal(replay.data.result.receipt_id,proof.receipt_id);
  deep((await inspect()).rows,saved.rows,"replay creates no order revision");

  const unknownReceipt=await read("a".repeat(64));failed(unknownReceipt,"unknown receipt");
  equal(unknownReceipt.metrics.provider_calls.length,0);equal(unknownReceipt.metrics.kv_puts,0);
  const extraRead=await rpc("mare_read","marketplace.order.evidence.read",{receipt_id:proof.receipt_id,amazon:{orders:[]}});
  failed(extraRead,"read extras");noEffects(extraRead,"read extras");
  const crossTenant=await read(proof.receipt_id,{mode:"other_tenant"});failed(crossTenant,"cross-tenant receipt");
  equal(crossTenant.metrics.provider_calls.length,0);equal(crossTenant.metrics.kv_puts,0);

  for(const mode of ["capture_wrong_receipt","capture_wrong_shop","capture_wrong_account","capture_authority","capture_extra_field",
    "capture_bad_json","capture_http_error","capture_transport_error","read_transport_error","read_wrong_receipt","read_wrong_manifest"]) {
    const result=await capture(request,{mode});failed(result,mode);
    equal(result.metrics.journal_paths.length,mode.startsWith("read_")?2:1,mode+": required response verification");
    equal(result.metrics.unmocked_calls,0);
  }
  for(const mode of ["shopify_error","amazon_http_error","missing_reference","wrong_external_reference","amazon_incomplete"]) {
    const payload=mode==="amazon_incomplete"?{...request,amazon_max_pages:1}:request;
    const result=await capture(payload,{mode});failed(result,mode);
    equal(result.metrics.journal_paths.length,0,mode+": failed read never reaches persistence");
    equal(result.metrics.unmocked_calls,0);
    if(mode==="shopify_error"||mode==="amazon_http_error")
      equal(result.data.error,"marketplace_order_evidence_provider_read_failed",mode+": stable safe error");
  }
  deep((await inspect()).rows,saved.rows,"rejected proofs preserve original order observations");

  await mf.dispose();mf=new Miniflare(options);
  const afterRestart=await read(proof.receipt_id);
  equal(afterRestart.tool.isError,false);equal(afterRestart.data.status,"STORED_VERIFIED");
  equal(afterRestart.data.receipt_id,proof.receipt_id);equal(afterRestart.metrics.provider_calls.length,0);equal(afterRestart.metrics.kv_puts,0);
  deep(afterRestart.data.manifest,proof.manifest,"same durable manifest after runtime restart");
  const restartedReplay=await capture();
  equal(restartedReplay.tool.isError,false);equal(restartedReplay.data.result.status,"ALREADY_CAPTURED");
  equal(restartedReplay.data.result.receipt_id,proof.receipt_id);
  const final=await inspect();deep(final.rows,saved.rows);equal(final.evidence_count,1);equal(final.reservation_count,0);
  equal(networkEscapes,0,"no external network escaped mocks");
  console.log("PASS order evidence client/Worker: "+checks+" checks; real authenticated MCP prepare/read, strict fields before KV/provider/DO, server-derived Shopify GID, proof tamper rejection, safe upstream errors, SQLite restart/replay, zero provider mutations");
} finally {
  if(mf)await mf.dispose();
  await rm(directory,{recursive:true,force:true});
}
