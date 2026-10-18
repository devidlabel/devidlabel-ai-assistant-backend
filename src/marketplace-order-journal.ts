import { DurableObject } from "cloudflare:workers";
import { MarketplaceCoreLedger, validateOrderSnapshot, type MarketplaceLedgerStore } from "./marketplace-core-ledger.js";
import { prepareAmazonOrderObservations, stageAmazonOrdersReadOnly } from "./marketplace-order-shadow-intake.js";
import { captureMarketplaceOrderEvidence, readMarketplaceOrderEvidence } from "./marketplace-order-evidence.js";
import { compareAmazonOrderWithChannableShopifyLines } from "./marketplace-shopify-channable-amazon-lines.js";

type Row=Record<string,unknown>;
type Namespace={idFromName(name:string):unknown;get(id:unknown):{fetch(request:Request):Promise<Response>}};
export type OrderJournalEnv={
  MARE_ORDER_JOURNAL?:Namespace;
  MARE_ORDER_JOURNAL_ENABLED?:string;
  MARE_BUSINESS_ACCESS_TOKEN?:string;
  AMAZON_SP_API_SELLER_ID?:string;
  COMMERCE_TENANT_ID?:string;
  SHOPIFY_SHOP_DOMAIN?:string;
};
const LIMIT=20;
const MAX_BYTES=1_000_000;
const SCOPE_RE=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const SELLER_RE=/^[A-Z0-9]{8,30}$/;
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{
  status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}
});
function scope(env:OrderJournalEnv):{tenant:string;seller:string}{
  const tenant=env.COMMERCE_TENANT_ID,seller=env.AMAZON_SP_API_SELLER_ID;
  if(typeof tenant!=="string"||!SCOPE_RE.test(tenant)||typeof seller!=="string"||!SELLER_RE.test(seller))
    throw new Error("order_journal_scope_not_configured");
  return {tenant,seller};
}
async function sha(value:string):Promise<string>{
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,"0")).join("");
}

/** One contract for capture and acceptance. Review state is canonical evidence:
 * identical order snapshots with different review requirements get different
 * receipts, while reordering the same observations remains an exact replay.
 */
async function prepareJournalBatch(raw:unknown,env:OrderJournalEnv){
  const {tenant,seller}=scope(env);
  const prepared=prepareAmazonOrderObservations(raw,seller);
  if(prepared.length>LIMIT)throw new Error("order_journal_batch_limit");
  const input=raw as Row;
  const observations=prepared.map(({snapshot,needsReview})=>({snapshot,needsReview}))
    .sort((a,b)=>a.snapshot.order_id<b.snapshot.order_id?-1:a.snapshot.order_id>b.snapshot.order_id?1:0);
  const context={
    schema:2,tenant_id:tenant,account_id:seller,
    selected_marketplaces:[...(input.selected_marketplaces as string[])].sort(),
    last_updated_after:new Date(input.last_updated_after as string).toISOString(),
    last_updated_before:new Date(input.last_updated_before as string).toISOString()
  };
  const fingerprint=await sha(JSON.stringify({...context,observations}));
  const snapshots=observations.map(x=>x.snapshot);
  const receipt={
    ...context,receipt_id:fingerprint,order_count:snapshots.length,
    zero_quantity_line_count:snapshots.reduce((n,s)=>n+s.items.filter(l=>l.quantity_ordered===0).length,0),
    review_required_order_count:observations.filter(x=>x.needsReview).length,
    local_persistence_verified:true,provider_mutations:0,
    import_state:"SHADOW_ONLY",source:"AMAZON_OBSERVATIONS_ONLY",
    shopify_reconciliation_not_persisted:true,
    importer_enabled:false,stock_effects:false,reservations_unchanged:true,
    can_advance_checkpoint:false,can_create_order:false,
    can_publish_offer:false,can_send_tracking:false,scheduling_enabled:false
  };
  return {tenant,seller,snapshots,receipt};
}

/** A receipt is accepted only for this exact validated batch and environment.
 * Dynamic counters describe this invocation, so they are bounded and conserved
 * rather than hashed. Concurrent identical captures may each record some rows:
 * ALREADY_CAPTURED means another invocation committed the receipt first.
 */
function validateJournalResponse(value:unknown,expected:Row):Row{
  const invalid=()=>new Error("order_journal_response_invalid");
  if(value===null||typeof value!=="object"||Array.isArray(value))throw invalid();
  const proof=value as Row;
  const dynamic=["status","recorded","duplicate","stale","current_snapshot_readbacks"];
  const allowed=[...Object.keys(expected),...dynamic];
  if(Object.keys(proof).length!==allowed.length||
     Object.keys(proof).some(key=>!allowed.includes(key)))throw invalid();
  for(const [key,want] of Object.entries(expected)){
    if(JSON.stringify(proof[key])!==JSON.stringify(want))throw invalid();
  }
  const count=expected.order_count as number;
  const counter=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0&&v<=count;
  if((proof.status!=="CAPTURED"&&proof.status!=="ALREADY_CAPTURED")||
     !counter(proof.recorded)||!counter(proof.duplicate)||!counter(proof.stale)||
     !counter(proof.current_snapshot_readbacks)||
     proof.recorded+proof.duplicate+proof.stale!==count||
     proof.current_snapshot_readbacks>count-proof.stale)throw invalid();
  return proof;
}
function authorized(request:Request,token:unknown):boolean{
  if(typeof token!=="string"||token.length<16)return false;
  const supplied=request.headers.get("Authorization")??"",expected="Bearer "+token;
  if(supplied.length!==expected.length)return false;
  let diff=0;for(let i=0;i<expected.length;i++)diff|=supplied.charCodeAt(i)^expected.charCodeAt(i);
  return diff===0;
}

/** Atomic per-order Core writes, then one durable receipt. A failure before the
 * receipt leaves no completed proof; replay deduplicates any already saved rows.
 * All records are SHADOW_ONLY. There is no reservation or cursor mutation.
 */
export async function captureAmazonOrderBatch(
  raw:unknown,store:MarketplaceLedgerStore,env:OrderJournalEnv
):Promise<Row>{
  const {tenant,seller,snapshots,receipt}=await prepareJournalBatch(raw,env);
  const ledger=new MarketplaceCoreLedger(store,tenant);
  const outcome=await stageAmazonOrdersReadOnly(raw,ledger,seller);
  let currentReadbacks=0;
  for(const snapshot of snapshots){
    const saved=await ledger.readMarketplaceOrder({provider:"amazon",account:seller,order_id:snapshot.order_id});
    if(!saved||saved.import_state!=="SHADOW_ONLY"||saved.revision<1)
      throw new Error("order_journal_readback_missing");
    // Only compare the validated canonical fields, not local observation times.
    const canonical=validateOrderSnapshot({
      provider:saved.provider,account:saved.account,order_id:saved.order_id,
      marketplace_id:saved.marketplace_id,source_updated_at:saved.source_updated_at,
      fulfillment_owner:saved.fulfillment_owner,fulfillment_status:saved.fulfillment_status,
      items:saved.items
    });
    if(JSON.stringify(canonical)===JSON.stringify(snapshot))currentReadbacks++;
    else if(Date.parse(saved.source_updated_at)<=Date.parse(snapshot.source_updated_at))
      throw new Error("order_journal_readback_conflict");
  }
  const receiptKey="proof:v2:"+tenant+":"+receipt.receipt_id;
  const replayed=await store.transaction(async tx=>{
    const previous=await tx.get<{receipt:typeof receipt;stored_at:number}>(receiptKey);
    if(previous){
      if(JSON.stringify(previous.receipt)!==JSON.stringify(receipt))
        throw new Error("order_journal_receipt_conflict");
      return true;
    }
    await tx.put(receiptKey,{receipt,stored_at:Date.now()});
    return false;
  });
  const persisted=await store.get<{receipt:typeof receipt}>(receiptKey);
  if(!persisted||JSON.stringify(persisted.receipt)!==JSON.stringify(receipt))
    throw new Error("order_journal_receipt_readback_failed");
  return validateJournalResponse({
    ok:true,...receipt,status:replayed?"ALREADY_CAPTURED":"CAPTURED",
    recorded:outcome.recorded,duplicate:outcome.duplicate,stale:outcome.stale,
    current_snapshot_readbacks:currentReadbacks
  },{ok:true,...receipt});
}

/** Private binding only. No route in the public Worker exposes this object.
 * HTTP inputs contain a complete already-normalized Amazon read, never a
 * client-provided SKU write or inventory delta. Account/tenant derive from env.
 */
export class MareMarketplaceOrderJournal extends DurableObject<OrderJournalEnv>{
  private store:MarketplaceLedgerStore;
  constructor(ctx:{storage:MarketplaceLedgerStore},env:OrderJournalEnv){
    super(ctx,env);this.store=ctx.storage;
  }
  async fetch(request:Request):Promise<Response>{
    if(!authorized(request,this.env.MARE_BUSINESS_ACCESS_TOKEN))return json({error:"unauthorized"},401);
    if(this.env.MARE_ORDER_JOURNAL_ENABLED!=="true")return json({error:"journal_disabled"},503);
    const path=new URL(request.url).pathname;
    if(request.method!=="POST"||!["/capture","/evidence/capture","/evidence/read"].includes(path))
      return json({error:"not_found"},404);
    try{
      const text=await request.text();
      if(new TextEncoder().encode(text).length>MAX_BYTES)return json({error:"journal_body_limit"},413);
      const raw:unknown=JSON.parse(text);
      if(path==="/evidence/capture")return json(await captureMarketplaceOrderEvidence(raw,this.store,this.env,{
        compareLines:compareAmazonOrderWithChannableShopifyLines,captureAmazonOrderBatch
      }));
      if(path==="/evidence/read"){
        if(!raw||typeof raw!=="object"||Array.isArray(raw)||Object.keys(raw).length!==1||
           typeof (raw as Row).receipt_id!=="string")
          throw new Error("marketplace_order_evidence_invalid_request");
        return json(await readMarketplaceOrderEvidence((raw as Row).receipt_id as string,this.store,this.env));
      }
      return json(await captureAmazonOrderBatch(raw,this.store,this.env));
    }catch(error){
      const candidate=error instanceof Error?error.message:"";
      const code=/^(?:amazon_order_stage|ledger_order|order_journal|marketplace_order_evidence|order_evidence)_[a-z_]{1,100}$/.test(candidate)?candidate:"order_journal_capture_failed";
      return json({ok:false,error:code,can_advance_checkpoint:false},409);
    }
  }
}

/** Invoked only AFTER successful complete Amazon read. This changes local
 * audit storage, not Amazon/Shopify/Channable. No arbitrary URL or account input.
 */
export async function journalAmazonRead(observation:Row,env:OrderJournalEnv):Promise<Row>{
  if(env.MARE_ORDER_JOURNAL_ENABLED!=="true")return observation;
  const {tenant,seller}=scope(env);
  if(!env.MARE_ORDER_JOURNAL||typeof env.MARE_BUSINESS_ACCESS_TOKEN!=="string")
    throw new Error("order_journal_binding_not_configured");
  if(!Array.isArray(observation.orders)||observation.orders.length>LIMIT){
    return {...observation,local_journal:{
      ok:false,status:"NOT_CAPTURED_BATCH_LIMIT",limit:LIMIT,
      local_persistence_verified:false,can_advance_checkpoint:false
    }};
  }
  const {receipt}=await prepareJournalBatch(observation,env);
  const id=env.MARE_ORDER_JOURNAL.idFromName(JSON.stringify(["orders-v1",tenant,seller]));
  const reply=await env.MARE_ORDER_JOURNAL.get(id).fetch(new Request("https://order-journal.internal/capture",{
    method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+env.MARE_BUSINESS_ACCESS_TOKEN},
    body:JSON.stringify(observation)
  }));
  if(!reply.ok)throw new Error("order_journal_capture_unverified");
  let proof:unknown;
  try{proof=await reply.json();}catch{throw new Error("order_journal_response_invalid");}
  return {...observation,local_journal:validateJournalResponse(proof,{ok:true,...receipt})};
}
