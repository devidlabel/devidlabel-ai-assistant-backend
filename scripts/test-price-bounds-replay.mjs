import assert from "node:assert/strict";
import { build } from "esbuild";
const b=await build({entryPoints:["src/mare-business-mcp-final.ts"],bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent",
 plugins:[{name:"no-execution-delegation",setup(build){
  build.onResolve({filter:/mare-business-mcp-safe\.js|mare-business-shopify-complete\.js/},args=>({path:args.path,namespace:"stub"}));
  build.onLoad({filter:/.*/,namespace:"stub"},args=>({contents:args.path.includes("mcp-safe")
   ? 'export async function handleMareBusinessMcpSafeRequest(){globalThis.__repairReplayDelegations++;throw Error("Unexpected execution delegation");}'
   : 'export async function readShopifyCatalogComplete(){throw Error("Unexpected source access");}',loader:"js"}));
 }}]});
const {handleMareBusinessMcpFinalRequest:handle}=await import("data:text/javascript;base64,"+Buffer.from(b.outputFiles[0].text).toString("base64"));
globalThis.__repairReplayDelegations=0;let network=0,statusCalls=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{network++;throw Error("No Amazon read or PATCH permitted during replay");};
const id="mbp_12345678-1234-1234-1234-123456789012";
const plan={plan_id:id,capability_id:"amazon.eu.price_bounds.repair.batch",risk:"live_write",status:"prepared",
 expires_at:new Date(Date.now()+3600000).toISOString(),request:{items:[{marketplace:"IT",sku:"MC2_TEST_001_S",asin:"B0TEST0001",ean:"8057338520504"}]}};
const env={MARE_BUSINESS_ACCESS_TOKEN:"mock-key",SHOPIFY_TOKENS_KV:{get:async()=>JSON.stringify(plan)},
 MARE_PLAN_COORDINATOR:{idFromName:name=>{assert.equal(name,id);return name;},get:()=>({fetch:async(_url,init)=>{
  const body=JSON.parse(init.body);assert.equal(body.action,"status");statusCalls++;
  return new Response(JSON.stringify({ok:true,ledger:{status:"completed"}}),{status:200,headers:{"content-type":"application/json"}});
 }})}};
try{
 for(let attempt=0;attempt<2;attempt++){
  const r=await handle(new Request("https://example.test/mcp-business",{method:"POST",headers:{Authorization:"Bearer mock-key","Content-Type":"application/json"},
   body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"mare_execute",arguments:{plan_id:id,approval_confirmation:"EXECUTE MARE LIVE PLAN"}}})}),env);
  const body=await r.json();
  assert.equal(body.result.structuredContent.error,"price_bounds_repair_already_completed_no_reexecution");
  assert.equal(body.result.structuredContent.detail.idempotent_replay,true);
 }
 assert.equal(network,0);assert.equal(globalThis.__repairReplayDelegations,0);assert.equal(statusCalls,2);
}finally{globalThis.fetch=originalFetch;}
console.log("Price-bound replay: DO completed + stale KV prepared + old Amazon maximum => zero execution delegation or PATCH PASS");
