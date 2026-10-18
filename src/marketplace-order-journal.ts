import { DurableObject } from "cloudflare:workers";
import { MarketplaceCoreLedger, validateOrderSnapshot, type MarketplaceLedgerStore } from "./marketplace-core-ledger.js";
import { prepareAmazonOrderObservations, stageAmazonOrdersReadOnly } from "./marketplace-order-shadow-intake.js";

type Row=Record<string,unknown>;
type Namespace={idFromName(name:string):unknown;get(id:unknown):{fetch(request:Request):Promise<Response>}};
export type OrderJournalEnv={
  MARE_ORDER_JOURNAL?:Namespace;
  MARE_ORDER_JOURNAL_ENABLED?:string;
  MARE_BUSINESS_ACCESS_TOKEN?:string;
  AMAZON_SP_API_SELLER_ID?:string;
  COMMERCE_TENANT_ID?:string;
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
  const {tenant,seller}=scope(env);
  const prepared=prepareAmazonOrderObservations(raw,seller);
  if(prepared.length>LIMIT)throw new Error("order_journal_batch_limit");
  const input=raw as Row;
  const snapshots=prepared.map(x=>x.snapshot).sort((a,b)=>a.order_id<b.order_id?-1:a.order_id>b.order_id?1:0);
  const fingerprint=await sha(JSON.stringify({
    schema:1,tenant,seller,
    marketplaces:[...(input.selected_marketplaces as string[])].sort(),
    after:new Date(input.last_updated_after as string).toISOString(),
    before:new Date(input.last_updated_before as string).toISOString(),snapshots
  }));
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
  const receiptKey="proof:v1:"+tenant+":"+fingerprint;
  const zeroLines=snapshots.reduce((n,s)=>n+s.items.filter(l=>l.quantity_ordered===0).length,0);
  const receipt={
    schema:1,fingerprint,order_count:snapshots.length,
    zero_quantity_line_count:zeroLines,
    review_required_order_count:prepared.filter(x=>x.needsReview).length,
    importer_enabled:false,can_advance_checkpoint:false,stock_effects:false,
    source:"AMAZON_OBSERVATIONS_ONLY"
  };
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
  if(!persisted||persisted.receipt.fingerprint!==fingerprint)
    throw new Error("order_journal_receipt_readback_failed");
  return {
    ok:true,status:replayed?"ALREADY_CAPTURED":"CAPTURED",
    receipt_id:fingerprint,order_count:snapshots.length,
    recorded:outcome.recorded,duplicate:outcome.duplicate,stale:outcome.stale,
    current_snapshot_readbacks:currentReadbacks,
    zero_quantity_line_count:zeroLines,review_required_order_count:receipt.review_required_order_count,
    local_persistence_verified:true,provider_mutations:0,
    import_state:"SHADOW_ONLY",source:"AMAZON_OBSERVATIONS_ONLY",
    shopify_reconciliation_not_persisted:true,
    reservations_unchanged:true,can_advance_checkpoint:false,
    can_create_order:false,can_publish_offer:false,can_send_tracking:false,
    scheduling_enabled:false
  };
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
    if(request.method!=="POST"||new URL(request.url).pathname!=="/capture")return json({error:"not_found"},404);
    try{
      const text=await request.text();
      if(new TextEncoder().encode(text).length>MAX_BYTES)return json({error:"journal_body_limit"},413);
      const raw:unknown=JSON.parse(text);
      return json(await captureAmazonOrderBatch(raw,this.store,this.env));
    }catch(error){
      const candidate=error instanceof Error?error.message:"";
      const code=/^(?:amazon_order_stage|ledger_order|order_journal)_[a-z_]{1,100}$/.test(candidate)?candidate:"order_journal_capture_failed";
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
  const id=env.MARE_ORDER_JOURNAL.idFromName(JSON.stringify(["orders-v1",tenant,seller]));
  const reply=await env.MARE_ORDER_JOURNAL.get(id).fetch(new Request("https://order-journal.internal/capture",{
    method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+env.MARE_BUSINESS_ACCESS_TOKEN},
    body:JSON.stringify(observation)
  }));
  if(!reply.ok)throw new Error("order_journal_capture_unverified");
  const proof:unknown=await reply.json();
  if(proof===null||typeof proof!=="object"||Array.isArray(proof))throw new Error("order_journal_response_invalid");
  const p=proof as Row;
  if(p.ok!==true||p.local_persistence_verified!==true||p.can_advance_checkpoint!==false||p.provider_mutations!==0)
    throw new Error("order_journal_response_invalid");
  return {...observation,local_journal:p};
}
