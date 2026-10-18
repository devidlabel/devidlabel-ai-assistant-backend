import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare,Log,LogLevel} from "miniflare";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

// Synthetic fixtures only. The actual Core, intake and journal are bundled.
// The additional inspect/fault paths belong to this test fixture, not production.
const fixture=`
 import {MareMarketplaceOrderJournal,captureAmazonOrderBatch,journalAmazonRead} from "./src/marketplace-order-journal.ts";
 import {MarketplaceCoreLedger} from "./src/marketplace-core-ledger.ts";
 const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{"Content-Type":"application/json"}});
 export class FixtureJournal extends MareMarketplaceOrderJournal {
  async fetch(req){
   const path=new URL(req.url).pathname;
   if(path==="/inspect"){
    const ledger=new MarketplaceCoreLedger(this.ctx.storage,this.env.COMMERCE_TENANT_ID);
    const body=await req.json(),rows=[];
    for(const id of body.ids)rows.push(await ledger.readMarketplaceOrder({
      provider:"amazon",account:this.env.AMAZON_SP_API_SELLER_ID,order_id:id}));
    const proofs=await this.ctx.storage.list({prefix:"proof:v2:",limit:100});
    const reservations=await this.ctx.storage.list({prefix:"core:v1:"+this.env.COMMERCE_TENANT_ID+":reservation:",limit:100});
    return json({rows,proof_count:proofs.size,reservation_count:reservations.size});
   }
   if(path==="/fault"){
    let transactions=0;const s=this.ctx.storage;
    const wrapper={get:(...a)=>s.get(...a),put:(...a)=>s.put(...a),
      delete:(...a)=>s.delete(...a),list:(...a)=>s.list(...a),
      transaction:async fn=>{if(++transactions===3)throw Error("SYNTHETIC_INTERRUPTION");return s.transaction(fn);}};
    try{return json(await captureAmazonOrderBatch(await req.json(),wrapper,this.env));}
    catch{return json({interrupted:true},503);}
   }
   return super.fetch(req);
  }
 }
 export default {async fetch(req,env){
  const object=req.headers.get("x-test-object")||"primary";
  const target=env.TEST_JOURNAL.get(env.TEST_JOURNAL.idFromName(object));
  if(new URL(req.url).pathname==="/client"){
   const mutation=req.headers.get("x-test-receipt-mutation")||"";
   const binding={idFromName:name=>name,get:id=>({fetch:async request=>{
    const response=await target.fetch(request);
    if(!response.ok)return response;
    if(mutation==="invalid_json")return new Response('{"SYNTHETIC_PRIVATE_VALUE":', {status:200});
    if(mutation==="null")return json(null);
    if(mutation==="array")return json([]);
    const proof=await response.json();
    const changes={
     receipt:p=>{p.receipt_id="f".repeat(64);},
     schema:p=>{p.schema=1;},
     tenant:p=>{p.tenant_id="OTHER_TENANT";},
     account:p=>{p.account_id="A987654321";},
     marketplaces:p=>{p.selected_marketplaces=["DE"];},
     after:p=>{p.last_updated_after="2026-10-18T06:00:00.000Z";},
     before:p=>{p.last_updated_before="2026-10-18T10:00:00.000Z";},
     order_count:p=>{p.order_count++;},
     zero_count:p=>{p.zero_quantity_line_count++;},
     review_count:p=>{p.review_required_order_count++;},
     status:p=>{p.status="PUBLISHED";},
     recorded_negative:p=>{p.recorded=-1;},
     duplicate_fraction:p=>{p.duplicate=0.5;},
     stale_string:p=>{p.stale="0";},
     sum:p=>{p.recorded=0;p.duplicate=0;p.stale=0;},
     readbacks_overflow:p=>{p.current_snapshot_readbacks=p.order_count+1;},
     readbacks_stale:p=>{p.recorded=0;p.duplicate=p.order_count-1;p.stale=1;p.current_snapshot_readbacks=p.order_count;},
     ok:p=>{p.ok=false;},
     persistence:p=>{p.local_persistence_verified=false;},
     mutations:p=>{p.provider_mutations=1;},
     import_state:p=>{p.import_state="READY";},
     source:p=>{p.source="OTHER_SOURCE";},
     shopify_evidence:p=>{p.shopify_reconciliation_not_persisted=false;},
     importer:p=>{p.importer_enabled=true;},
     stock:p=>{p.stock_effects=true;},
     reservations:p=>{p.reservations_unchanged=false;},
     checkpoint:p=>{p.can_advance_checkpoint=true;},
     create:p=>{p.can_create_order=true;},
     publish:p=>{p.can_publish_offer=true;},
     tracking:p=>{p.can_send_tracking=true;},
     scheduling:p=>{p.scheduling_enabled=true;},
     missing:p=>{delete p.receipt_id;},
     extra:p=>{p.unexpected="SYNTHETIC_PRIVATE_VALUE";}
    };
    if(mutation){
     if(!changes[mutation])throw Error("UNKNOWN_SYNTHETIC_MUTATION");
     changes[mutation](proof);
    }
    return json(proof);
   }})};
   try{return json(await journalAmazonRead(await req.json(),{...env,MARE_ORDER_JOURNAL:binding}));}
   catch(error){return json({ok:false,error:error.message,can_advance_checkpoint:false},409);}
  }
  return target.fetch(req);
 }};
`;
const built=await build({stdin:{contents:fixture,resolveDir:process.cwd(),sourcefile:"journal-fixture.ts",loader:"ts"},
 bundle:true,write:false,format:"esm",platform:"browser",external:["cloudflare:workers"],logLevel:"silent"});
const directory=await mkdtemp(join(tmpdir(),"mare-order-journal-"));
const token="synthetic-local-journal-token";
const account="A123456789",tenant="SYNTHETIC_TENANT";
const options={name:"order-journal-test",modules:true,script:built.outputFiles[0].text,
 compatibilityDate:"2026-06-25",durableObjects:{TEST_JOURNAL:{className:"FixtureJournal",useSQLite:true}},
 durableObjectsPersist:directory,bindings:{MARE_ORDER_JOURNAL_ENABLED:"true",
  MARE_BUSINESS_ACCESS_TOKEN:token,AMAZON_SP_API_SELLER_ID:account,COMMERCE_TENANT_ID:tenant},
 log:new Log(LogLevel.ERROR)};
const order=(id,zero=false)=>({
 account_id:account,order_id:id,order_key:"amazon:"+account+":"+id,
 created_at:"2026-10-15T10:00:00Z",last_updated_at:"2026-10-18T08:00:00Z",
 marketplace_id:"APJ6JRA9NG5V4",fulfillment_owner:"MERCHANT",
 fulfillment_status:zero?"CANCELLED":"SHIPPED",line_count:1,
 items:[{line_id:id+"_LINE",seller_sku:"00_SYNTHETIC SKU ",asin:"B0TEST0001",
  quantity_ordered:zero?0:1,quantity_fulfilled:zero?0:1,mapping_status:"UNRESOLVED_VARIANT"}],
 order_import_authorized:false,needs_enrichment:zero,contains_customer_data:false
});
const ids=["SYNTH_A","SYNTH_B","SYNTH_C","SYNTH_D","SYNTH_E"];
const batch={ok:true,read_only:true,source:"amazon_spapi_orders_2026_01_01",
 account_id:account,identity_scope:"SELLER_ACCOUNT_PLUS_ORDER_ID",selected_marketplaces:["IT"],
 fulfilled_by:"MERCHANT",last_updated_after:"2026-10-18T07:00:00Z",last_updated_before:"2026-10-18T09:00:00Z",
 pages_read:1,order_count:5,complete_pagination:true,orders:ids.map((id,i)=>order(id,i<2)),
 customer_personal_data_requested:false,importer_enabled:false,tracking_enabled:false,
 quantity_mutations_enabled:false,can_advance_checkpoint:false};
let mf;let checks=0;
async function call(path,body=batch,object="primary",withAuth=true,receiptMutation=""){
 const response=await mf.dispatchFetch("https://fixture"+path,{method:"POST",
  headers:{"Content-Type":"application/json","x-test-object":object,
   ...(receiptMutation?{"x-test-receipt-mutation":receiptMutation}:{}),
   ...(withAuth?{Authorization:"Bearer "+token}:{})},
  body:JSON.stringify(body)});
 return {http:response.status,...await response.json()};
}
try{
 mf=new Miniflare(options);
 assert.equal((await call("/capture",batch,"primary",false)).http,401);checks++;
 const first=await call("/capture");
 assert.equal(first.status,"CAPTURED");checks++;
 assert.equal(first.recorded,5);checks++;
 assert.equal(first.schema,2);checks++;
 assert.equal(first.tenant_id,tenant);checks++;
 assert.equal(first.account_id,account);checks++;
 assert.deepEqual(first.selected_marketplaces,["IT"]);checks++;
 assert.equal(first.last_updated_after,"2026-10-18T07:00:00.000Z");checks++;
 assert.equal(first.last_updated_before,"2026-10-18T09:00:00.000Z");checks++;
 assert.equal(first.zero_quantity_line_count,2);checks++;
 assert.equal(first.review_required_order_count,2);checks++;
 assert.equal(first.current_snapshot_readbacks,5);checks++;
 for(const flag of ["can_advance_checkpoint","can_create_order","can_publish_offer","can_send_tracking","scheduling_enabled"]){
  assert.equal(first[flag],false);checks++;
 }
 assert.equal(first.reservations_unchanged,true);checks++;
 assert.equal(first.source,"AMAZON_OBSERVATIONS_ONLY");checks++;
 const before=await call("/inspect",{ids});
 assert.equal(before.rows[0].items[0].quantity_ordered,0);checks++;
 assert.equal(before.rows[0].fulfillment_status,"CANCELLED");checks++;
 assert.equal(before.rows[0].items[0].seller_sku,"00_SYNTHETIC SKU ");checks++;
 assert.equal(before.rows.every(x=>x.revision===1&&x.import_state==="SHADOW_ONLY"),true);checks++;
 assert.equal(before.reservation_count,0);checks++;
 const repeated=await call("/capture");
 assert.equal(repeated.status,"ALREADY_CAPTURED");checks++;
 assert.equal(repeated.receipt_id,first.receipt_id);checks++;
 assert.equal(repeated.recorded,0);checks++;
 assert.equal(repeated.duplicate,5);checks++;
 await mf.dispose();mf=new Miniflare(options);
 const restarted=await call("/capture");
 assert.equal(restarted.status,"ALREADY_CAPTURED");checks++;
 assert.equal(restarted.receipt_id,first.receipt_id);checks++;
 assert.equal(restarted.duplicate,5);checks++;
 assert.equal((await call("/inspect",{ids})).proof_count,1);checks++;

 // An interruption after two committed orders cannot create a completed receipt.
 const broken=await call("/fault",batch,"interrupted");
 assert.equal(broken.http,503);checks++;
 const partial=await call("/inspect",{ids},"interrupted");
 assert.equal(partial.rows.filter(Boolean).length,2);checks++;
 assert.equal(partial.proof_count,0);checks++;
 await mf.dispose();mf=new Miniflare(options);
 const recovery=await call("/capture",batch,"interrupted");
 assert.equal(recovery.recorded,3);checks++;
 assert.equal(recovery.duplicate,2);checks++;
 assert.equal(recovery.order_count,5);checks++;
 assert.equal(recovery.can_advance_checkpoint,false);checks++;

 // Full input validation must happen before the first record is committed.
 for(const mutate of [
  x=>{x.orders[4].items[0].seller_sku="";},
  x=>{x.orders[4].items[0].quantity_ordered=-1;},
  x=>{x.orders[4].items[0].quantity_ordered=true;},
  x=>{x.orders[4].account_id="WRONG_ACCOUNT";},
  x=>{x.orders[4].created_at="2026-10-19T00:00:00Z";},
  x=>{x.orders[4].last_updated_at="2026-10-18T08:00:00.0001Z";},
  x=>{x.orders[4].buyer={name:"SYNTHETIC_PRIVATE_VALUE"};},
  x=>{x.orders[4]=structuredClone(x.orders[0]);},
  x=>{x.complete_pagination=false;}
 ]){
  const invalid=structuredClone(batch);mutate(invalid);
  const response=await call("/capture",invalid,"invalid");
  assert.equal(response.http,409);checks++;
  assert(!JSON.stringify(response).includes("SYNTHETIC_PRIVATE_VALUE"));checks++;
  assert.equal((await call("/inspect",{ids},"invalid")).rows.filter(Boolean).length,0);checks++;
 }
 const changed=structuredClone(batch);
 changed.orders[0].fulfillment_status="UNSHIPPED";
 const conflict=await call("/capture",changed);
 assert.equal(conflict.http,409);checks++;
 assert.equal(conflict.error,"ledger_order_same_version_conflict");checks++;
 const newer=structuredClone(batch);
 newer.orders[0].last_updated_at="2026-10-18T08:30:00Z";
 const newerResult=await call("/capture",newer);
 assert.equal(newerResult.recorded,1);checks++;
 const older=await call("/capture",batch);
 assert.equal(older.stale,1);checks++;
 assert.equal((await call("/inspect",{ids})).rows[0].revision,2);checks++;
 assert.equal((await call("/inspect",{ids})).reservation_count,0);checks++;
 const empty=await call("/capture",{...batch,orders:[],order_count:0},"empty");
 assert.equal(empty.order_count,0);checks++;
 assert.equal(empty.can_advance_checkpoint,false);checks++;
 const concurrent=await Promise.all([call("/capture",batch,"concurrent"),call("/capture",batch,"concurrent")]);
 assert.equal(concurrent.reduce((n,x)=>n+x.recorded,0),5);checks++;
 assert.equal(concurrent.filter(x=>x.status==="CAPTURED").length,1);checks++;
 assert.equal((await call("/inspect",{ids},"concurrent")).proof_count,1);checks++;

 // Review requirements are part of receipt identity, without rewriting orders.
 const enrichmentBaseline=await call("/capture",batch,"enrichment");
 const enriched=structuredClone(batch);
 enriched.orders[2].needs_enrichment=true;
 const enrichmentChange=await call("/capture",enriched,"enrichment");
 assert.equal(enrichmentChange.http,200);checks++;
 assert.equal(enrichmentChange.status,"CAPTURED");checks++;
 assert.notEqual(enrichmentChange.receipt_id,enrichmentBaseline.receipt_id);checks++;
 assert.equal(enrichmentChange.review_required_order_count,3);checks++;
 assert.equal(enrichmentChange.recorded,0);checks++;
 assert.equal(enrichmentChange.duplicate,5);checks++;
 const enrichmentReplay=await call("/capture",enriched,"enrichment");
 assert.equal(enrichmentReplay.status,"ALREADY_CAPTURED");checks++;
 assert.equal(enrichmentReplay.receipt_id,enrichmentChange.receipt_id);checks++;
 const reordered=structuredClone(enriched);reordered.orders.reverse();
 assert.equal((await call("/capture",reordered,"enrichment")).receipt_id,enrichmentChange.receipt_id);checks++;
 const impliedReview=structuredClone(batch);impliedReview.orders[0].needs_enrichment=false;
 assert.equal((await call("/capture",impliedReview,"enrichment")).receipt_id,enrichmentBaseline.receipt_id);checks++;
 const enrichmentState=await call("/inspect",{ids},"enrichment");
 assert.equal(enrichmentState.proof_count,2);checks++;
 assert.equal(enrichmentState.rows.every(x=>x.revision===1),true);checks++;
 assert.equal(enrichmentState.reservation_count,0);checks++;

 // Exercise the actual binding client in workerd, then falsify one receipt
 // dimension at a time. A successful actor HTTP response alone is insufficient.
 const clientFirst=await call("/client",batch,"client");
 assert.equal(clientFirst.http,200);checks++;
 assert.equal(clientFirst.local_journal.status,"CAPTURED");checks++;
 assert.equal(clientFirst.local_journal.receipt_id,first.receipt_id);checks++;
 const clientReplay=await call("/client",batch,"client");
 assert.equal(clientReplay.local_journal.status,"ALREADY_CAPTURED");checks++;
 assert.equal(clientReplay.local_journal.recorded,0);checks++;
 assert.equal(clientReplay.local_journal.duplicate,5);checks++;
 const clientEnriched=await call("/client",enriched,"client");
 assert.equal(clientEnriched.local_journal.receipt_id,enrichmentChange.receipt_id);checks++;
 for(const mutation of [
  "receipt","schema","tenant","account","marketplaces","after","before",
  "order_count","zero_count","review_count","status","recorded_negative",
  "duplicate_fraction","stale_string","sum","readbacks_overflow","readbacks_stale",
  "ok","persistence","mutations","import_state","source","shopify_evidence",
  "importer","stock","reservations","checkpoint","create","publish","tracking",
  "scheduling","missing","extra","null","array","invalid_json"
 ]){
  const rejected=await call("/client",batch,"client",true,mutation);
  assert.equal(rejected.http,409,"must reject forged receipt: "+mutation);checks++;
  assert.equal(rejected.error,"order_journal_response_invalid",mutation);checks++;
  assert.equal(rejected.can_advance_checkpoint,false,mutation);checks++;
  assert(!JSON.stringify(rejected).includes("SYNTHETIC_PRIVATE_VALUE"),mutation);checks++;
 }
 const concurrentClients=await Promise.all([
  call("/client",batch,"concurrent-clients"),call("/client",batch,"concurrent-clients")
 ]);
 assert.equal(concurrentClients.every(x=>x.http===200),true);checks++;
 assert.equal(concurrentClients.reduce((n,x)=>n+x.local_journal.recorded,0),5);checks++;
 assert.equal(concurrentClients.filter(x=>x.local_journal.status==="CAPTURED").length,1);checks++;
 await mf.dispose();mf=new Miniflare(options);
 const clientRestarted=await call("/client",enriched,"client");
 assert.equal(clientRestarted.http,200);checks++;
 assert.equal(clientRestarted.local_journal.status,"ALREADY_CAPTURED");checks++;
 assert.equal(clientRestarted.local_journal.receipt_id,enrichmentChange.receipt_id);checks++;
 assert.equal(clientRestarted.local_journal.duplicate,5);checks++;
 console.log("PASS order journal SQLite runtime: "+checks+" checks, zero-line retention, complete-input validation, restart/replay, partial-failure recovery, enrichment-bound fingerprints, exact request/receipt correlation, no provider writes or checkpoint advancement");
}finally{await mf?.dispose();await rm(directory,{recursive:true,force:true});}
