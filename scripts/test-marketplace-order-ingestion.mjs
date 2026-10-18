import assert from 'node:assert/strict';
import {build} from 'esbuild';

const paths=['src/marketplace-amazon-orders-readonly.ts','src/marketplace-order-shadow-intake.ts','src/marketplace-core-ledger.ts'];
const modules=await Promise.all(paths.map(async p=>{const b=await build({entryPoints:[p],bundle:true,format:'esm',platform:'neutral',write:false,logLevel:'silent'});return import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));}));
const {readAmazonOrdersPilot}=modules[0];
const {stageAmazonOrdersReadOnly}=modules[1];
const {MarketplaceCoreLedger}=modules[2];
const capabilityModule=await build({
  entryPoints:["src/mare-business-capabilities.ts"],
  bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"
});
const {buildMareBusinessCapabilities}=await import("data:text/javascript;base64,"+
  Buffer.from(capabilityModule.outputFiles[0].text).toString("base64"));
const capConfig={
  MARE_BUSINESS_ACCESS_TOKEN:"synthetic-business-key",
  AMAZON_SP_API_CLIENT_ID:"synthetic-client",
  AMAZON_SP_API_CLIENT_SECRET:"synthetic-secret",
  AMAZON_SP_API_REFRESH_TOKEN:"synthetic-refresh",
  AMAZON_SP_API_SELLER_ID:"A123456789"
};
const findOrders=(e)=>buildMareBusinessCapabilities(e).find(x=>x.id==="amazon.orders.observe.readonly");
assert.equal(findOrders(capConfig).available,true);
assert.equal(findOrders({...capConfig,AMAZON_SP_API_SELLER_ID:""}).available,false);
assert(findOrders({...capConfig,AMAZON_SP_API_SELLER_ID:""}).missing.includes("AMAZON_SP_API_SELLER_ID"));
assert.equal(findOrders({...capConfig,AMAZON_SP_API_REFRESH_TOKEN:""}).available,false);
assert.equal(findOrders(capConfig).risk,"read_only");

const ids={IT:"APJ6JRA9NG5V4",FR:"A13V1IB3VIYZZH"},seller="A123456789";
const env={AMAZON_SP_API_CLIENT_ID:"synthetic-client",AMAZON_SP_API_CLIENT_SECRET:"synthetic-secret",
  AMAZON_SP_API_REFRESH_TOKEN:"synthetic-refresh",AMAZON_SP_API_SELLER_ID:seller};
const input={marketplaces:["IT","FR"],last_updated_after:"2026-10-18T08:00:00Z",
  last_updated_before:"2026-10-18T10:30:00Z",max_pages:3};
const now=()=>Date.parse("2026-10-18T11:00:00Z");
const order=(key,market)=>({
  orderId:key,createdTime:"2026-10-18T08:30:00Z",lastUpdatedTime:"2026-10-18T09:00:00Z",
  salesChannel:{channelName:"AMAZON",marketplaceId:market},
  fulfillment:{fulfilledBy:"MERCHANT",fulfillmentStatus:"UNSHIPPED"},
  buyer:{buyerName:"PII_CANARY_DO_NOT_STORE"},
  recipient:{deliveryAddress:{addressLine1:"ADDRESS_CANARY"}},
  orderItems:[
    {orderItemId:key+"_1",quantityOrdered:1,product:{sellerSku:"00_SYNTH SKU ",asin:"B0TEST0001"}},
    {orderItemId:key+"_2",quantityOrdered:2,product:{sellerSku:"TEST_B",asin:"B0TEST0002"}}
  ]
});
const a=order("SYNTH_A",ids.IT),b=order("SYNTH_B",ids.FR);
let mode="base";
const original=globalThis.fetch;
const reply=o=>new Response(JSON.stringify(o),{status:200,headers:{"content-type":"application/json"}});
globalThis.fetch=async(url,init={})=>{
 const u=new URL(String(url));
 if(u.hostname==="api.amazon.com")return reply({access_token:"token"});
 assert.equal(init.method,"GET");assert.equal(u.pathname,"/orders/2026-01-01/orders");
 const token=u.searchParams.get("paginationToken");
 if(token){assert.equal(token,"next");return reply({orders:[b]});}
 return reply({orders:[mode==="updated"?{...a,lastUpdatedTime:"2026-10-18T09:40:00Z",
    fulfillment:{fulfilledBy:"MERCHANT",fulfillmentStatus:"PARTIALLY_SHIPPED"}}:a],
    pagination:{nextToken:"next"}});
};
class MemStore {
 rows=new Map();
 async get(k){return this.rows.get(k)}
 async put(k,v){this.rows.set(k,structuredClone(v))}
 async delete(k){return this.rows.delete(k)}
 async list({prefix,limit,startAfter}){
  return new Map([...this.rows].filter(([k])=>k.startsWith(prefix)&&(!startAfter||k>startAfter)).sort().slice(0,limit));
 }
 async transaction(fn){
  const before=this.rows;
  this.rows=new Map([...this.rows].map(([k,v])=>[k,structuredClone(v)]));
  try{return await fn(this)}catch(e){this.rows=before;throw e}
 }
}
try {
 const store=new MemStore(),ledger=new MarketplaceCoreLedger(store,"SYNTH_TENANT");
 const result=await readAmazonOrdersPilot(input,env,now);
 assert.equal(result.order_count,2);assert.equal(result.complete_pagination,true);
 assert.equal(result.orders[0].items[0].seller_sku,"00_SYNTH SKU ");
 assert(!JSON.stringify(result).includes("PII_CANARY"));
 let outcome=await stageAmazonOrdersReadOnly(result,ledger,seller);
 assert.deepEqual({recorded:outcome.recorded,duplicate:outcome.duplicate,stale:outcome.stale},
  {recorded:2,duplicate:0,stale:0});
 assert.equal(outcome.can_advance_checkpoint,false);
 assert.equal(outcome.shopify_adoption_reconciliation_required,true);
 assert(!JSON.stringify([...store.rows]).includes("PII_CANARY"));
 const snapshot=await ledger.readMarketplaceOrder({provider:"amazon",account:seller,order_id:"SYNTH_A"});
 assert.equal(snapshot.import_state,"SHADOW_ONLY");
 assert.equal(snapshot.items[0].seller_sku,"00_SYNTH SKU ");
 assert.equal(snapshot.items.length,2);
 outcome=await stageAmazonOrdersReadOnly(result,ledger,seller);
 assert.equal(outcome.recorded,0);assert.equal(outcome.duplicate,2);
 mode="updated";
 const updated=await readAmazonOrdersPilot(input,env,now);
 outcome=await stageAmazonOrdersReadOnly(updated,ledger,seller);
 assert.equal(outcome.recorded,1);assert.equal(outcome.duplicate,1);
 assert.equal((await ledger.readMarketplaceOrder({provider:"amazon",account:seller,order_id:"SYNTH_A"})).revision,2);
 assert.equal((await stageAmazonOrdersReadOnly(result,ledger,seller)).stale,1);
 const conflicting=structuredClone(updated);conflicting.orders[0].fulfillment_status="CANCELLED";
 await assert.rejects(()=>stageAmazonOrdersReadOnly(conflicting,ledger,seller),/ledger_order_same_version_conflict/);
 const before=JSON.stringify([...store.rows]);
 for(const malformed of [
  (()=>{const x=structuredClone(result);x.orders[1].account_id="WRONG";return x})(),
  (()=>{const x=structuredClone(result);x.orders[1].buyer={name:"PII"};return x})(),
  (()=>{const x=structuredClone(result);x.orders[1].items[0].quantity_ordered=true;return x})(),
  (()=>{const x=structuredClone(result);x.complete_pagination=false;return x})(),
  (()=>{const x=structuredClone(result);x.order_count=3;return x})()
 ])await assert.rejects(()=>stageAmazonOrdersReadOnly(malformed,ledger,seller));
 assert.equal(JSON.stringify([...store.rows]),before);
 const secondStore=new MemStore(),secondLedger=new MarketplaceCoreLedger(secondStore,"SECOND_TENANT");
 let n=0;
 const failSecond={observeMarketplaceOrder:async order=>{
  if(++n===2)throw new Error("injected_storage_error");
  return secondLedger.observeMarketplaceOrder(order);
 }};
 await assert.rejects(()=>stageAmazonOrdersReadOnly(result,failSecond,seller),/injected_storage_error/);
 const recovered=await stageAmazonOrdersReadOnly(result,secondLedger,seller);
 assert.equal(recovered.recorded,1);assert.equal(recovered.duplicate,1);
 assert.equal(recovered.can_advance_checkpoint,false);
 console.log("PASS R2.1 Amazon Orders reader to persistent-safe Core intake: replay, stale protection, unknown importer, no PII, no external writes");
}finally{
 globalThis.fetch=original;
}
