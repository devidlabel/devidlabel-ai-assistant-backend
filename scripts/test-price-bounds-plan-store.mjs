import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
const b=await build({entryPoints:["src/mare-business-price-bounds-plan-store.ts"],bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {createPriceBoundsPlanStore}=await import("data:text/javascript;base64,"+Buffer.from(b.outputFiles[0].text).toString("base64"));
let now=0,last=-Infinity,attempts=0,failed=false;
const records=[],waits=[];
const persist=createPriceBoundsPlanStore({now:()=>now,wait:async ms=>{waits.push(ms);now+=ms;}});
const fakeKV=async value=>{
 attempts++;assert(now-last>=1000,"mock KV rejects same-key writes inside 1 second");last=now;
 if(value==="ACK"&&!failed){failed=true;throw Error("KV PUT failed: 429");}
 records.push(value);
};
// Initial executing, pre-PATCH checkpoint, immediate ACK, immediate readback,
// final plan and catch persistence all use the same paced store function.
for(const value of ["EXECUTING","WRITE_ATTEMPT_STARTED","ACK","READBACK","COMPLETED","CATCH"])
 await persist("mbp_test",()=>fakeKV(value));
assert.deepEqual(records,["EXECUTING","WRITE_ATTEMPT_STARTED","ACK","READBACK","COMPLETED","CATCH"]);
assert.equal(attempts,7);assert(waits.every(ms=>ms>=1000));
let active=0,maxActive=0;
await Promise.all([1,2,3].map(n=>persist("mbp_test",async()=>{active++;maxActive=Math.max(active,maxActive);await fakeKV("concurrent"+n);active--;})));
assert.equal(maxActive,1);assert.deepEqual(records.slice(-3),["concurrent1","concurrent2","concurrent3"]);
let failures=0;
await assert.rejects(()=>persist("mbp_test",async()=>{failures++;throw Error("sensitive provider text");}),/price_bounds_plan_store_failed/);
assert.equal(failures,3,"bounded persistence retries only");
await persist("mbp_test",()=>fakeKV("RECOVERY"));assert.equal(records.at(-1),"RECOVERY");
const router=await readFile("src/mare-business-mcp.ts","utf8");
assert(router.includes('if (plan.capability_id === "amazon.eu.price_bounds.repair.batch") {\n    const kv = env.SHOPIFY_TOKENS_KV;'));
assert(router.includes('await persistPriceBoundsRepairPlan(planKey(plan.plan_id)'));
console.log("Price-bound plan store: same-key pacing, initial/ACK/final/catch, serialization and bounded KV-only retries PASS");
