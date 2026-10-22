import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Synthetic Miniflare with REAL SQLite-backed Durable Object and restart tests.
const fixture = [
 'import { MareAmazonOfferAttemptJournal, makeAmazonOfferJournalClient } from "./src/marketplace-amazon-offer-attempt-journal.ts";',
 'const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{"Content-Type":"application/json"}});',
 'export class FixtureJournal extends MareAmazonOfferAttemptJournal {}',
 'export default {async fetch(request,env){',
 ' const raw=await request.text();let body;try{body=JSON.parse(raw)}catch{body={}}',
 ' const path=new URL(request.url).pathname;',
 ' if(path==="/adapter"){',
 '  const client=makeAmazonOfferJournalClient({MARE_AMAZON_OFFER_JOURNAL:env.TEST_JOURNAL,MARE_BUSINESS_ACCESS_TOKEN:env.MARE_BUSINESS_ACCESS_TOKEN,AMAZON_SP_API_SELLER_ID:env.AMAZON_SP_API_SELLER_ID});',
 '  const claimed=await client.atomicClaim(body.scope,body.plan_reference);',
 '  if(!claimed.claimed)return json({claimed});',
 '  await client.storeAttemptResult(claimed.attempt_reference,body.status,{...body.evidence,attempt_reference:claimed.attempt_reference});',
 '  return json({claimed,after:await client.readClaim(body.scope)});',
 ' }',
 ' const scope=body.scope||"offer-only-v1:A123456789:IT:SYNTHETIC-SKU";',
 ' const target=env.TEST_JOURNAL.get(env.TEST_JOURNAL.idFromName(scope));',
 ' return target.fetch(new Request("https://offer-journal.internal"+path,{method:request.method,headers:request.headers,body:raw}));',
 '}};'
].join("\n");
const built=await build({stdin:{contents:fixture,resolveDir:process.cwd(),sourcefile:"offer-journal-fixture.ts",loader:"ts"},bundle:true,write:false,format:"esm",platform:"browser",external:["cloudflare:workers"],logLevel:"silent"});
const folder=await mkdtemp(join(tmpdir(),"mare-offer-journal-"));
const token="synthetic-long-internal-journal-secret";
const seller="A123456789",scope="offer-only-v1:"+seller+":IT:SYNTHETIC-SKU",de="offer-only-v1:"+seller+":DE:SYNTHETIC-SKU";
const options={name:"amazon-offer-journal-test",modules:true,script:built.outputFiles[0].text,compatibilityDate:"2026-06-25",durableObjects:{TEST_JOURNAL:{className:"FixtureJournal",useSQLite:true}},durableObjectsPersist:folder,bindings:{MARE_BUSINESS_ACCESS_TOKEN:token,AMAZON_SP_API_SELLER_ID:seller},log:new Log(LogLevel.ERROR)};
let mf;
const post=async(path,payload,auth=true)=>{
 const res=await mf.dispatchFetch("https://fixture"+path,{method:"POST",headers:{"Content-Type":"application/json",...(auth?{Authorization:"Bearer "+token}:{})},body:JSON.stringify(payload)});
 return {http:res.status,...await res.json()};
};
const evidence=(attempt,more={})=>({marketplace:"IT",sku:"SYNTHETIC-SKU",asin:"B0TEST0001",attempt_reference:attempt,provider_mutations_possible:1,quantity_requested:0,automatic_retry_allowed:false,...more});
try{
 mf=new Miniflare(options);
 assert.equal((await post("/claim",{scope,plan_reference:"APPROVAL-SYNTH-001"},false)).http,401);
 assert.equal((await post("/claim",{scope,plan_reference:"X"})).http,409);
 assert.equal((await post("/claim",{scope:"offer-only-v1:A987654321:IT:SYNTHETIC-SKU",plan_reference:"APPROVAL-SYNTH-001"})).http,409);
 assert.equal((await post("/read",{scope})).exists,false);
 const batch=await Promise.all(Array.from({length:16},(_,i)=>post("/claim",{scope,plan_reference:"APPROVAL-SYNTH-"+String(i).padStart(3,"0")})));
 assert.equal(batch.filter(x=>x.claimed===true).length,1);
 assert.equal(batch.filter(x=>x.claimed===false).length,15);
 const attempt=batch.find(x=>x.claimed===true).attempt_reference;
 assert.match(attempt,/^ATTEMPT-[0-9a-f-]{36}$/);
 assert.equal((await post("/read",{scope})).state.retry_allowed,false);
 assert.equal((await post("/claim",{scope,plan_reference:"APPROVAL-OTHER-001"})).claimed,false);
 await mf.dispose();mf=new Miniflare(options);
 assert.equal((await post("/read",{scope})).state.attempt_reference,attempt);
 assert.equal((await post("/claim",{scope,plan_reference:"APPROVAL-OTHER-001"})).claimed,false);
 assert.equal((await post("/record",{scope,attempt_reference:"ATTEMPT-FAKE-12345",status:"ACCEPTED_PENDING_READBACK",evidence:evidence(attempt,{submission_reference:"SUBMISSION-SYNTH-001"})})).http,409);
 assert.equal((await post("/record",{scope,attempt_reference:attempt,status:"ACCEPTED_PENDING_READBACK",evidence:evidence(attempt)})).http,409);
 assert.equal((await post("/record",{scope,attempt_reference:attempt,status:"OFFER_IDENTITY_QUANTITY_ZERO_VERIFIED",evidence:evidence(attempt,{submission_reference:"SUBMISSION-SYNTH-001",readback_verified:true})})).http,409);
 const leaked=await post("/record",{scope,attempt_reference:attempt,status:"ACCEPTED_PENDING_READBACK",evidence:evidence(attempt,{private_secret:"SYNTHETIC_PRIVATE_VALUE",submission_reference:"SUBMISSION-SYNTH-001"})});
 assert.equal(leaked.http,409);assert.equal(JSON.stringify(leaked).includes("SYNTHETIC_PRIVATE_VALUE"),false);
 assert.equal((await post("/record",{scope,attempt_reference:attempt,status:"ACCEPTED_PENDING_READBACK",evidence:evidence(attempt,{submission_reference:"SUBMISSION-SYNTH-001"})})).http,200);
 assert.equal((await post("/record",{scope,attempt_reference:attempt,status:"ACCEPTED_PENDING_READBACK",evidence:evidence(attempt,{submission_reference:"SUBMISSION-CHANGED-001"})})).http,409);
 assert.equal((await post("/record",{scope,attempt_reference:attempt,status:"OFFER_IDENTITY_QUANTITY_ZERO_VERIFIED",evidence:evidence(attempt,{readback_verified:false})})).http,409);
 const done=await post("/record",{scope,attempt_reference:attempt,status:"OFFER_IDENTITY_QUANTITY_ZERO_VERIFIED",evidence:evidence(attempt,{readback_verified:true})});
 assert.equal(done.http,200);assert.equal(done.readback_verified,true);
 assert.equal((await post("/record",{scope,attempt_reference:attempt,status:"ACCEPTED_PENDING_READBACK",evidence:evidence(attempt)})).http,409);
 assert.equal((await post("/read",{scope})).state.state,"OFFER_IDENTITY_QUANTITY_ZERO_VERIFIED");
 const next=await post("/claim",{scope:de,plan_reference:"APPROVAL-DE-SYNTH-001"});
 assert.equal(next.claimed,true);
 const uncertain=await post("/record",{scope:de,attempt_reference:next.attempt_reference,status:"HTTP_503_UNKNOWN_EFFECT",evidence:evidence(next.attempt_reference,{marketplace:"DE"})});
 assert.equal(uncertain.status,"HTTP_UNKNOWN_EFFECT");
 assert.equal((await post("/claim",{scope:de,plan_reference:"APPROVAL-DE-SYNTH-002"})).claimed,false);
 assert.equal((await post("/record",{scope:de,attempt_reference:next.attempt_reference,status:"OFFER_IDENTITY_QUANTITY_ZERO_VERIFIED",evidence:evidence(next.attempt_reference,{marketplace:"DE",submission_reference:"SUBMISSION-DE-SYNTH",readback_verified:true})})).http,409);
 await mf.dispose();mf=new Miniflare(options);
 assert.equal((await post("/read",{scope:de})).state.state,"HTTP_UNKNOWN_EFFECT");
 const third="offer-only-v1:"+seller+":IT:TEST-ADAPTER";
 const adapter=await post("/adapter",{scope:third,plan_reference:"APPROVAL-ADAPTER-001",status:"TRANSPORT_OR_RESPONSE_UNCERTAIN",evidence:evidence("ATTEMPT-FAKE-1234",{sku:"TEST-ADAPTER"})});
 assert.equal(adapter.claimed.claimed,true);
 assert.equal(adapter.after.state.state,"TRANSPORT_OR_RESPONSE_UNCERTAIN");
 assert.equal((await post("/adapter",{scope:third,plan_reference:"APPROVAL-ADAPTER-002",status:"TRANSPORT_OR_RESPONSE_UNCERTAIN",evidence:evidence("ATTEMPT-FAKE-1234",{sku:"TEST-ADAPTER"})})).claimed.claimed,false);
 console.log("PASS Amazon offer journal durable concurrency, restart, strict states and private adapter");
}finally{
 await mf?.dispose().catch(()=>{});
 await rm(folder,{recursive:true,force:true});
}
