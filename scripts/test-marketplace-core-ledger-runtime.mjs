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
      const ledger=new MarketplaceCoreLedger(this.ctx.storage,"synthetic-tenant");
      try {
        const p=new URL(req.url).pathname;
        if(p==="/event")return json(await ledger.recordEvent(body));
        if(p==="/reservation")return json(await ledger.upsertReservation(body));
        if(p==="/draft")return json(await ledger.registerDraft(body));
        if(p==="/draft/read")return json(await ledger.readDraft(String(body.command_id)));
        if(p==="/simulate")return json(simulateExposureBudget(body));
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
  return {status:response.status,...await response.json()};
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
  console.log("PASS R1 Durable Object local ledger: "+assertions+
    " checks; atomic inbox dedup, reservation versioning, immutable drafts, tenant isolation, restart persistence, worst-case exposure simulation");
}finally{
  await mf?.dispose();await rm(persist,{recursive:true,force:true});
}
