import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** R1 local workerd test; no Shopify/Amazon/Spartoo network or customer data. */
const fixture = String.raw`
  import {DurableObject} from "cloudflare:workers";
  import {MarketplaceCoreLedger,simulateExposureBudget} from "./src/marketplace-core-ledger.ts";
  function json(o,status=200){return new Response(JSON.stringify(o),{
    status,headers:{"content-type":"application/json"}});}
  export class LedgerFixture extends DurableObject{
    async fetch(req){
      if(req.headers.get("authorization")!=="Bearer local-fixture-token")
        return json({error:"unauthorized"},401);
      const body=req.method==="POST"?await req.json():{};
      const syntheticClock=req.headers.get("x-test-clock");
      const ledger=new MarketplaceCoreLedger(this.ctx.storage,"synthetic-tenant",
        () => syntheticClock?Number(syntheticClock):Date.now());
      try {
        const p=new URL(req.url).pathname;
        if(p==="/event")return json(await ledger.recordEvent(body));
        if(p==="/reservation")return json(await ledger.upsertReservation(body));
        if(p==="/draft")return json(await ledger.registerDraft(body));
        if(p==="/draft/read")return json(await ledger.readDraft(String(body.command_id)));
        if(p==="/simulate")return json(simulateExposureBudget(body));
        if(p==="/ingest")return json(await ledger.recordInboxAndDraft(body));
        if(p==="/pending")return json(await ledger.listPendingDrafts(body));
        if(p==="/lease")return json(await ledger.leaseDraftForReview(body.command_id));
        if(p==="/review")return json(await ledger.finishLocalReview(
          body.command_id,body.lease_token,body.reason));
        if(p==="/ambiguous")return json(await ledger.simulateAmbiguousDispatchBoundary(
          body.command_id,body.lease_token));
        if(p==="/unknown")return json(await ledger.flagUnknown(
          body.command_id,body.lease_token,body.reason));
        if(p==="/recover")return json(await ledger.recoverExpiredLease(body.command_id));
        if(p==="/scan")return json(await ledger.scanExpiredLeases(body));
        if(p==="/note")return json(await ledger.recordReconciliationNote(body));
        if(p==="/ingest-fault"){
          const storage=this.ctx.storage;
          const injected={
            get:(...args)=>storage.get(...args),
            put:(...args)=>storage.put(...args),
            delete:(...args)=>storage.delete(...args),
            list:(...args)=>storage.list(...args),
            transaction:async(fn)=>storage.transaction(async tx=>{
              let writes=0;
              const view={
                get:(...a)=>tx.get(...a),
                put:(...a)=>{if(++writes===3)throw new Error("injected_transaction_failure");
                  return tx.put(...a);},
                delete:(...a)=>tx.delete(...a),
                list:(...a)=>tx.list(...a)
              };
              return fn(view);
            })
          };
          return json(await new MarketplaceCoreLedger(injected,"synthetic-tenant")
            .recordInboxAndDraft(body));
        }

        return json({error:"unsupported_operation"},404);
      }catch(err){return json({error:err.message || "unknown"},409);}
    }
  }
  export default{
    async fetch(req,env){
      const tenant=req.headers.get("x-synthetic-tenant") || "tenant-one";
      const id=env.MARE_CORE_LEDGER.idFromName(tenant);
      return env.MARE_CORE_LEDGER.get(id).fetch(req);
    }
  };
`;

const built=await build({stdin:{
  contents:fixture,resolveDir:process.cwd(),sourcefile:"ledger-fixture.ts",loader:"ts"
},bundle:true,write:false,format:"esm",platform:"browser",
  external:["cloudflare:workers"],logLevel:"silent"});
const persist=await mkdtemp(join(tmpdir(),"mare-core-ledger-r1-"));
const options={
  name:"mare-core-ledger-fixture",modules:true,script:built.outputFiles[0].text,
  compatibilityDate:"2026-06-25",
  durableObjects:{MARE_CORE_LEDGER:{className:"LedgerFixture",useSQLite:true}},
  durableObjectsPersist:persist,log:new Log(LogLevel.ERROR)
};
let mf;
const auth={Authorization:"Bearer local-fixture-token"};
let assertions=0;
async function call(path,body,extraHeaders={}){
  const response=await mf.dispatchFetch("https://fixture"+path,{method:"POST",
    headers:{"content-type":"application/json",...auth,...extraHeaders},
    body:JSON.stringify(body)});
  const data=await response.json();
  return data===null ? null : {status:response.status,...data};
}
const hash="a".repeat(64);
const event={provider:"amazon",account:"ACCOUNT_DEMO",event_id:"EVENT_001",payload_hash:hash};
const reserve={provider:"amazon",account:"ACCOUNT_DEMO",order_id:"ORDER_001",line_id:"LINE_001",variant_id:"VARIANT_001",quantity:2,version:1};
const draft={command_id:"CMD_001",surface:"amazon:account:it",flow:"inventory",payload_hash:hash,policy_ref:"POLICY_001",owner_epoch:0};
try{
  mf=new Miniflare(options);
  const unauthorized=await mf.dispatchFetch("https://fixture/event",{method:"POST",
    headers:{"content-type":"application/json"},body:JSON.stringify(event)});
  assert.equal(unauthorized.status,401);assertions++;
  const incoming=await Promise.all([call("/event",event),call("/event",event)]);
  assert.deepEqual(incoming.map(x=>x.status).sort(),["DUPLICATE","RECORDED"]);assertions++;
  const conflict=await call("/event",{...event,payload_hash:"b".repeat(64)});
  assert.equal(conflict.error,"ledger_event_payload_conflict");assertions++;
  const separate=await call("/event",event,{"x-synthetic-tenant":"tenant-two"});
  assert.equal(separate.status,"RECORDED");assertions++;
  assert.equal((await call("/event",{...event,event_id:"EVENT_002"})).status,"RECORDED");assertions++;

  assert.equal((await call("/reservation",reserve)).status,"RECORDED");assertions++;
  assert.equal((await call("/reservation",reserve)).status,"DUPLICATE");assertions++;
  assert.equal((await call("/reservation",{...reserve,version:0})).status,"STALE");assertions++;
  assert.equal((await call("/reservation",{...reserve,quantity:4,version:1})).error,"ledger_reservation_version_conflict");assertions++;
  assert.equal((await call("/reservation",{...reserve,variant_id:"OTHER_VAR",version:2})).error,"ledger_reservation_variant_changed");assertions++;
  assert.equal((await call("/reservation",{...reserve,quantity:1,version:2})).status,"RECORDED");assertions++;
  assert.equal((await call("/reservation",{...reserve,quantity:1,version:2})).reflected,false);assertions++;
  assert.equal((await call("/reservation",{...reserve,quantity:true,version:3})).error,"ledger_reservation_invalid");assertions++;

  const concurrency=await Promise.all([call("/draft",draft),call("/draft",draft),call("/draft",draft)]);
  assert.deepEqual(concurrency.map(x=>x.status).sort(),["DRAFT","EXISTS","EXISTS"]);assertions++;
  assert.equal((await call("/draft",{...draft,payload_hash:"b".repeat(64)})).error,"ledger_draft_conflict");assertions++;
  const persisted=await call("/draft/read",{command_id:draft.command_id});
  assert.equal(persisted.state,"DRAFT");assertions++;
  assert.equal(persisted.owner_epoch,0);assertions++;
  assert.equal((await call("/draft/read",{command_id:"UNKNOWN"})),null);assertions++;

  const onePiece=await call("/simulate",{
    shopify_available:1,unreflected_reservations:0,buffer:0,
    surfaces:[{id:"IT",confirmed:1,unresolved_increase:0}]
  });
  assert.deepEqual({status:onePiece.status,budget:onePiece.budget,max:onePiece.maximum_exposure},
    {status:"SIMULATION_ONLY",budget:1,max:1});assertions++;
  assert.equal((await call("/simulate",{
    shopify_available:1,unreflected_reservations:0,buffer:0,
    surfaces:[{id:"IT",confirmed:1,unresolved_increase:0},{id:"DE",confirmed:0,unresolved_increase:1}]
  })).status,"CAPACITY_DEFICIT");assertions++;
  assert.equal((await call("/simulate",{
    shopify_available:3,unreflected_reservations:null,buffer:0,surfaces:[]
  })).status,"BLOCKED_UNKNOWN");assertions++;
  assert.equal((await call("/simulate",{
    shopify_available:3,unreflected_reservations:0,buffer:0,
    surfaces:[{id:"IT",confirmed:0,unresolved_increase:2},{id:"IT",confirmed:0,unresolved_increase:1}]
  })).status,"BLOCKED_UNKNOWN");assertions++;

  await mf.dispose();mf=new Miniflare(options);
  assert.equal((await call("/event",event)).status,"DUPLICATE");assertions++;
  assert.equal((await call("/draft/read",{command_id:draft.command_id})).state,"DRAFT");assertions++;
  assert.equal((await call("/reservation",reserve)).status,"STALE");assertions++;
  // R1.2: Durable, atomic inbox/event dedup + outbox draft enqueue.
  const workOf=(id)=>({
    event:{...event,event_id:"R12_EVENT_"+id},
    intent:{...draft,command_id:"R12_CMD_"+id}
  });
  const primary=workOf("A");
  const duplicateWork=await Promise.all([
    call("/ingest",primary),call("/ingest",primary),call("/ingest",primary)
  ]);
  assert.deepEqual(duplicateWork.map(x=>x.status).sort(),
    ["DUPLICATE","DUPLICATE","RECORDED"]);assertions++;
  assert.equal((await call("/pending",{})).command_ids.includes(primary.intent.command_id),true);assertions++;
  assert.equal((await call("/ingest",primary)).status,"DUPLICATE");assertions++;
  assert.equal((await call("/ingest",{...primary,event:{...primary.event,payload_hash:"b".repeat(64)}})).error,
    "ledger_event_payload_conflict");assertions++;
  assert.equal((await call("/ingest",{...primary,intent:{...primary.intent,command_id:"R12_TAMPER"}})).error,
    "ledger_event_replay_conflict");assertions++;
  assert.equal((await call("/ingest",{...primary,event:{...primary.event,event_id:"R12_EVENT_OTHER"}})).error,
    "ledger_command_reused_by_different_event");assertions++;
  assert.equal((await call("/ingest",primary,{"x-synthetic-tenant":"tenant-two"})).status,
    "RECORDED");assertions++;

  const faultWork=workOf("FAULT");
  assert.equal((await call("/ingest-fault",faultWork)).error,
    "injected_transaction_failure");assertions++;
  assert.equal((await call("/ingest",faultWork)).status,"RECORDED");assertions++;

  const leases=await Promise.all([
    call("/lease",{command_id:primary.intent.command_id}),
    call("/lease",{command_id:primary.intent.command_id}),
    call("/lease",{command_id:primary.intent.command_id})
  ]);
  assert.equal(leases.filter(x=>x.state==="REVIEW_LEASED").length,1);assertions++;
  assert.equal(leases.filter(x=>x.error==="ledger_review_lease_held").length,2);assertions++;
  const primaryLease=leases.find(x=>x.state==="REVIEW_LEASED");
  assert(!((await call("/pending",{})).command_ids.includes(primary.intent.command_id)));assertions++;
  assert.equal((await call("/review",{command_id:primary.intent.command_id,
    lease_token:"incorrect",reason:"NEEDS_REVIEW"})).error,
    "ledger_review_lease_stale_or_invalid");assertions++;
  assert.equal((await call("/review",{command_id:primary.intent.command_id,
    lease_token:primaryLease.lease_token,reason:"NEEDS_REVIEW"})).state,
    "REVIEW_REQUIRED");assertions++;
  assert.equal((await call("/lease",{command_id:primary.intent.command_id})).error,
    "ledger_work_not_replayable");assertions++;

  // A local review lease can be recovered when it never approached dispatch.
  const safeWork=workOf("SAFE");
  assert.equal((await call("/ingest",safeWork)).status,"RECORDED");assertions++;
  const safeLease=await call("/lease",{command_id:safeWork.intent.command_id});
  assert.equal(safeLease.state,"REVIEW_LEASED");assertions++;
  const beforeExpiry=await call("/recover",{command_id:safeWork.intent.command_id});
  assert.equal(beforeExpiry.recovered,false);assertions++;
  const recovered=await call("/recover",{command_id:safeWork.intent.command_id},
    {"x-test-clock":String(safeLease.lease_until+1)});
  assert.deepEqual({state:recovered.state,recovered:recovered.recovered},
    {state:"DRAFT",recovered:true});assertions++;
  assert.equal((await call("/pending",{})).command_ids.includes(safeWork.intent.command_id),
    true);assertions++;
  assert.equal((await call("/review",{command_id:safeWork.intent.command_id,
    lease_token:safeLease.lease_token,reason:"WRONG"})).error,
    "ledger_review_lease_stale_or_invalid");assertions++;
  const leaseAgain=await call("/lease",{command_id:safeWork.intent.command_id});
  assert.notEqual(leaseAgain.lease_token,safeLease.lease_token);assertions++;

  // A simulated boundary represents a potentially executed provider call.
  // Timeout/crash must quarantine rather than requeue or repeat the intent.
  const unknownWork=workOf("UNKNOWN");
  assert.equal((await call("/ingest",unknownWork)).status,"RECORDED");assertions++;
  const unknownLease=await call("/lease",{command_id:unknownWork.intent.command_id});
  assert.equal((await call("/ambiguous",{command_id:unknownWork.intent.command_id,
    lease_token:unknownLease.lease_token})).state,"SIMULATED_DISPATCHING");assertions++;
  const sweep=await call("/scan",{},{"x-test-clock":String(unknownLease.lease_until+1)});
  assert.equal(sweep.recovered>=1,true);assertions++;
  const unknownDraft=await call("/draft/read",{command_id:unknownWork.intent.command_id});
  assert.equal(unknownDraft.state,"RECONCILIATION_REQUIRED");assertions++;
  assert.equal((await call("/lease",{command_id:unknownWork.intent.command_id})).error,
    "ledger_work_not_replayable");assertions++;
  assert(!((await call("/pending",{})).command_ids.includes(unknownWork.intent.command_id)));assertions++;
  const note={command_id:unknownWork.intent.command_id,evidence_ref:"PROBE_001",
    observation:"NOT_FOUND",observation_hash:"c".repeat(64)};
  assert.equal((await call("/note",note)).still_blocked,true);assertions++;
  assert.equal((await call("/note",note)).status,"DUPLICATE");assertions++;
  assert.equal((await call("/note",{...note,observation:"FOUND"})).error,
    "ledger_reconciliation_evidence_conflict");assertions++;
  assert.equal((await call("/draft/read",{command_id:unknownWork.intent.command_id})).state,
    "RECONCILIATION_REQUIRED");assertions++;

  const directUnknown=workOf("DIRECT_UNKNOWN");
  assert.equal((await call("/ingest",directUnknown)).status,"RECORDED");assertions++;
  const directLease=await call("/lease",{command_id:directUnknown.intent.command_id});
  assert.equal((await call("/unknown",{command_id:directUnknown.intent.command_id,
    lease_token:directLease.lease_token,reason:"NETWORK_INTERRUPTED"})).state,
    "RECONCILIATION_REQUIRED");assertions++;

  // Cursor-bounded pending scan, using multiple independent drafts.
  for(const id of ["PAGE_1","PAGE_2","PAGE_3"])
    assert.equal((await call("/ingest",workOf(id))).status,"RECORDED");
  assertions++;
  const firstPage=await call("/pending",{limit:1});
  assert.equal(firstPage.command_ids.length,1);assertions++;
  assert.equal(typeof firstPage.next_cursor,"string");assertions++;
  const secondPage=await call("/pending",{limit:1,cursor:firstPage.next_cursor});
  assert.equal(secondPage.command_ids.length,1);assertions++;
  assert.notEqual(secondPage.command_ids[0],firstPage.command_ids[0]);assertions++;
  assert.equal((await call("/pending",{limit:100})).error,"ledger_queue_page_invalid");assertions++;

  await mf.dispose();mf=new Miniflare(options);
  assert.equal((await call("/ingest",primary)).status,"DUPLICATE");assertions++;
  assert.equal((await call("/draft/read",{command_id:unknownWork.intent.command_id})).state,
    "RECONCILIATION_REQUIRED");assertions++;
  assert.equal((await call("/draft/read",{command_id:primary.intent.command_id})).state,
    "REVIEW_REQUIRED");assertions++;
  assert.equal((await call("/note",note)).status,"DUPLICATE");assertions++;
  console.log("PASS R1.2 atomic inbox/outbox and uncertain outcomes: "+assertions+
    " checks, no marketplace writes");

  console.log("PASS R1 Durable Object local ledger: "+assertions+
    " checks; atomic inbox dedup, reservation versioning, immutable drafts, tenant isolation, restart persistence, worst-case exposure simulation");
}finally{
  await mf?.dispose();await rm(persist,{recursive:true,force:true});
}
