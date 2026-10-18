/**
 * M.A.R.E. marketplace core R1: persistent, read/write *local ledger only*.
 *
 * Never connects to Shopify, Amazon or Spartoo, never exposes live dispatch and
 * never treats caller supplied evidence as remote confirmation. A single
 * SQLite-backed Durable Object must own transactions for each tenant/pool.
 * Production routing, authenticated adapters and the handoff protocol are
 * deliberately absent in this increment.
 */
type Json = Record<string, unknown>;
type Store = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: {prefix:string;limit:number;startAfter?:string}): Promise<Map<string,T>>;
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;
};
type Event = {
  provider: "amazon" | "spartoo" | "shopify";
  account: string;
  event_id: string;
  payload_hash: string;
};
type Reservation = {
  provider: "amazon" | "spartoo";
  account: string;
  order_id: string;
  line_id: string;
  variant_id: string;
  quantity: number;
  version: number;
};
type Intent = {
  surface: string;
  flow: "catalog" | "inventory" | "price" | "order_import" | "shipping";
  command_id: string;
  payload_hash: string;
  policy_ref: string;
  owner_epoch: number;
};

type ManagedDraft = Intent & {
  state: "DRAFT"|"REVIEW_LEASED"|"SIMULATED_DISPATCHING"|"REVIEW_REQUIRED"|"RECONCILIATION_REQUIRED";
  event_ref: string;
  created_at: number;
  updated_at: number;
  lease?: {token:string;until:number};
  reason?: string;
};
type InboxWork = {event:Event;intent:Intent};
type ReconciliationNote = {
  command_id: string;
  evidence_ref: string;
  observation: "FOUND"|"NOT_FOUND"|"UNKNOWN";
  observation_hash: string;
};

type OrderLineSnapshot = {
  line_id: string;
  seller_sku: string | null;
  quantity_ordered: number;
  quantity_fulfilled: number | null;
};
type OrderSnapshot = {
  provider: "amazon" | "spartoo";
  account: string;
  order_id: string;
  marketplace_id: string;
  source_updated_at: string;
  fulfillment_status: string | null;
  fulfillment_owner: "MERCHANT" | "UNVERIFIED";
  items: OrderLineSnapshot[];
};
type StoredOrderObservation = OrderSnapshot & {
  snapshot_hash: string;
  updated_ms: number;
  observed_at: number;
  revision: number;
  import_state: "SHADOW_ONLY";
};
const ORDER_ISO_RE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
function exactKeys(value:Record<string,unknown>,allowed:readonly string[]):boolean {
  return Object.keys(value).every(key=>allowed.includes(key));
}
function orderTimestamp(value:string):{milliseconds:number;normalized:string} {
  if (!ORDER_ISO_RE.test(value))throw new Error("ledger_order_time_invalid");
  const ms=Date.parse(value);
  if (!Number.isFinite(ms))throw new Error("ledger_order_time_invalid");
  return {milliseconds:ms,normalized:new Date(ms).toISOString()};
}
function validateOrderSnapshot(input:OrderSnapshot):OrderSnapshot {
  if (!input||typeof input!=="object"||Array.isArray(input)||
      !exactKeys(input as unknown as Json,["provider","account","order_id","marketplace_id","source_updated_at","fulfillment_status","fulfillment_owner","items"])||
      !["amazon","spartoo"].includes(input.provider)||
      !valid(input.account)||!valid(input.order_id)||!valid(input.marketplace_id)||
      input.fulfillment_owner!=="MERCHANT"&&input.fulfillment_owner!=="UNVERIFIED"||
      (input.fulfillment_status!==null&&!valid(input.fulfillment_status))||
      !Array.isArray(input.items)||input.items.length<1||input.items.length>200)
    throw new Error("ledger_order_invalid");
  const normalizedAt=orderTimestamp(input.source_updated_at).normalized;
  const lines:OrderLineSnapshot[]=[];
  const ids=new Set<string>();
  for(const line of input.items) {
    if (!line||typeof line!=="object"||Array.isArray(line)||
        !exactKeys(line as unknown as Json,["line_id","seller_sku","quantity_ordered","quantity_fulfilled"])||
        !valid(line.line_id)||ids.has(line.line_id)||
        (line.seller_sku!==null&&
          (typeof line.seller_sku!=="string"||line.seller_sku.length<1||
           line.seller_sku.length>200||/[\u0000-\u001f\u007f]/.test(line.seller_sku)))||
        !Number.isSafeInteger(line.quantity_ordered)||line.quantity_ordered<1||
        (line.quantity_fulfilled!==null&&
          (!safeQty(line.quantity_fulfilled)||line.quantity_fulfilled>line.quantity_ordered)))
      throw new Error("ledger_order_line_invalid");
    ids.add(line.line_id);
    lines.push({
      line_id:line.line_id,seller_sku:line.seller_sku,
      quantity_ordered:line.quantity_ordered,
      quantity_fulfilled:line.quantity_fulfilled
    });
  }
  lines.sort((a,b)=>a.line_id<b.line_id?-1:a.line_id>b.line_id?1:0);
  return {
    provider:input.provider,account:input.account,order_id:input.order_id,
    marketplace_id:input.marketplace_id,source_updated_at:normalizedAt,
    fulfillment_owner:input.fulfillment_owner,
    fulfillment_status:input.fulfillment_status,items:lines
  };
}

const REVIEW_LEASE_MS=30_000;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9.:_/-]{0,179}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
function valid(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}
function safeQty(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function safeVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function digest(value: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then(buf =>
    [...new Uint8Array(buf)].map(v => v.toString(16).padStart(2,"0")).join(""));
}
function assertTenant(tenant: string): void {
  if (!valid(tenant) || tenant.length > 96) throw new Error("ledger_tenant_invalid");
}
function eventArgs(item: Event): void {
  if (!["amazon","spartoo","shopify"].includes(item.provider) ||
      !valid(item.account) || !valid(item.event_id) ||
      typeof item.payload_hash !== "string" || !SHA256_RE.test(item.payload_hash))
    throw new Error("ledger_event_invalid");
}
function reservationArgs(item: Reservation): void {
  if (!["amazon","spartoo"].includes(item.provider) ||
      !valid(item.account) || !valid(item.order_id) || !valid(item.line_id) ||
      !valid(item.variant_id) || !safeQty(item.quantity) ||
      !safeVersion(item.version)) throw new Error("ledger_reservation_invalid");
}
function intentArgs(item: Intent): void {
  if (!valid(item.surface) ||
      !["catalog","inventory","price","order_import","shipping"].includes(item.flow) ||
      !valid(item.command_id) || !valid(item.policy_ref) ||
      typeof item.payload_hash !== "string" || !SHA256_RE.test(item.payload_hash) ||
      !safeVersion(item.owner_epoch))
    throw new Error("ledger_intent_invalid");
}

/** Typed storage functions for a single tenant; HTTP callers are not trusted.
 * The ledger stores identities and fingerprints, never raw customer/order payloads.
 */
export class MarketplaceCoreLedger {
  constructor(private readonly store: Store, private readonly tenant: string, private readonly clock:()=>number = Date.now) {
    assertTenant(tenant);
  }
  private async key(kind: string, fields: string[]): Promise<string> {
    return "core:v1:" + this.tenant + ":" + kind + ":" + await digest(JSON.stringify(fields));
  }

  /** Duplicate event is harmless. Reused event ID with a different digest is a hard stop. */
  async recordEvent(item: Event): Promise<{status:"RECORDED"|"DUPLICATE"}> {
    eventArgs(item);
    const key=await this.key("event",[item.provider,item.account,item.event_id]);
    return this.store.transaction(async tx=>{
      const current=await tx.get<{payload_hash:string}>(key);
      if (current) {
        if (current.payload_hash !== item.payload_hash)
          throw new Error("ledger_event_payload_conflict");
        return {status:"DUPLICATE" as const};
      }
      await tx.put(key,{payload_hash:item.payload_hash,observed_at:Date.now()});
      return {status:"RECORDED" as const};
    });
  }

  /** Reservations are never silently expired or reflected on a timer.
   * A later version resets reflection. A duplicate version is idempotent.
   */
  async upsertReservation(item: Reservation): Promise<{
    status:"RECORDED"|"DUPLICATE"|"STALE"; reflected:boolean
  }> {
    reservationArgs(item);
    const key=await this.key("reservation",[item.provider,item.account,item.order_id,item.line_id]);
    return this.store.transaction(async tx=>{
      const current=await tx.get<Reservation & {reflected:boolean}>(key);
      if (current) {
        if (item.variant_id !== current.variant_id)
          throw new Error("ledger_reservation_variant_changed");
        if (item.version < current.version) return {status:"STALE" as const,reflected:current.reflected};
        if (item.version === current.version) {
          if (item.quantity !== current.quantity) throw new Error("ledger_reservation_version_conflict");
          return {status:"DUPLICATE" as const,reflected:current.reflected};
        }
      }
      await tx.put(key,{...item,reflected:false,created_at:Date.now()});
      return {status:"RECORDED" as const,reflected:false};
    });
  }

  /** Drafts are local immutable intents. This method NEVER dispatches to providers.
   * Owner epoch and policy reference are recorded, NOT trusted as authorization.
   */
  async registerDraft(item: Intent): Promise<{status:"DRAFT"|"EXISTS"}> {
    intentArgs(item);
    const key=await this.key("intent",[item.command_id]);
    return this.store.transaction(async tx=>{
      const prior=await tx.get<Intent & {state:string}>(key);
      if (prior) {
        if (prior.payload_hash!==item.payload_hash || prior.surface!==item.surface ||
            prior.flow!==item.flow || prior.owner_epoch!==item.owner_epoch ||
            prior.policy_ref!==item.policy_ref)
          throw new Error("ledger_draft_conflict");
        return {status:"EXISTS" as const};
      }
      await tx.put(key,{...item,state:"DRAFT",created_at:Date.now()});
      return {status:"DRAFT" as const};
    });
  }

  async readDraft(commandId: string): Promise<Json | null> {
    if (!valid(commandId)) throw new Error("ledger_command_invalid");
    const key=await this.key("intent",[commandId]);
    const item=await this.store.get<Json>(key);
    return item ? {...item} : null;
  }

  /**
   * R1.2 atomic INBOX + local OUTBOX. Caller must authenticate the provider event
   * BEFORE using this class; no customer payload, API mutation or seller secret is stored.
   * Crash before transaction commit persists neither event nor draft.
   * Crash after commit leaves BOTH event dedup and pending draft safely recoverable.
   */
  async recordInboxAndDraft(work: InboxWork): Promise<{status:"RECORDED"|"DUPLICATE";command_id:string}> {
    eventArgs(work.event);
    intentArgs(work.intent);
    const eventKey=await this.key("event",[
      work.event.provider,work.event.account,work.event.event_id]);
    const intentKey=await this.key("intent",[work.intent.command_id]);
    const pendingKey=await this.key("pending",[work.intent.command_id]);
    return this.store.transaction(async tx=>{
      const event=await tx.get<{payload_hash:string;command_id?:string}>(eventKey);
      const prior=await tx.get<ManagedDraft>(intentKey);
      if (event) {
        if (event.payload_hash!==work.event.payload_hash)
          throw new Error("ledger_event_payload_conflict");
        if (event.command_id!==work.intent.command_id ||
            !prior || prior.event_ref!==eventKey || !this.sameIntent(prior,work.intent))
          throw new Error("ledger_event_replay_conflict");
        return {status:"DUPLICATE" as const,command_id:work.intent.command_id};
      }
      if (prior) throw new Error("ledger_command_reused_by_different_event");
      const now=this.clock();
      await tx.put(eventKey,{
        payload_hash:work.event.payload_hash,command_id:work.intent.command_id,observed_at:now
      });
      await tx.put(intentKey,{
        ...work.intent,event_ref:eventKey,state:"DRAFT",created_at:now,updated_at:now
      } satisfies ManagedDraft);
      await tx.put(pendingKey,{command_id:work.intent.command_id});
      return {status:"RECORDED" as const,command_id:work.intent.command_id};
    });
  }

  private sameIntent(stored: Intent, requested: Intent): boolean {
    return stored.command_id===requested.command_id &&
      stored.payload_hash===requested.payload_hash &&
      stored.surface===requested.surface &&
      stored.flow===requested.flow &&
      stored.policy_ref===requested.policy_ref &&
      stored.owner_epoch===requested.owner_epoch;
  }

  /** Small bounded index scan; a future alarm runner must persist and resume its cursor.
   * A pending draft is NOT authorized for provider dispatch.
   */
  async listPendingDrafts(options: {limit?:number;cursor?:string} = {}): Promise<{
    command_ids:string[];next_cursor:string|null;read_only:true
  }> {
    const limit=options.limit??20;
    const prefix="core:v1:"+this.tenant+":pending:";
    if (!Number.isSafeInteger(limit)||limit<1||limit>50 ||
        (options.cursor!==undefined &&
        (typeof options.cursor!=="string"||!options.cursor.startsWith(prefix))))
      throw new Error("ledger_queue_page_invalid");
    const items=await this.store.list<{command_id:string}>({
      prefix,limit,...(options.cursor?{startAfter:options.cursor}:{})
    });
    const keys=[...items.keys()];
    const command_ids=[...items.values()].map(v=>v.command_id);
    if (!command_ids.every(valid)) throw new Error("ledger_queue_corrupt");
    return {command_ids,next_cursor:keys.length===limit?keys[keys.length-1]:null,read_only:true};
  }

  /** Local review lease only. This is NOT a dispatch authorization or provider lock.
   * A concurrent claimant must lose, even across process restarts.
   */
  async leaseDraftForReview(commandId:string):Promise<{
    state:"REVIEW_LEASED";lease_token:string;lease_until:number
  }> {
    if (!valid(commandId)) throw new Error("ledger_command_invalid");
    const key=await this.key("intent",[commandId]);
    const pending=await this.key("pending",[commandId]);
    const leased=await this.key("leased",[commandId]);
    return this.store.transaction(async tx=>{
      const prior=await tx.get<ManagedDraft>(key);
      if (!prior || !prior.event_ref) throw new Error("ledger_work_not_staged");
      if (prior.state==="REVIEW_LEASED")
        throw new Error("ledger_review_lease_held");
      if (prior.state!=="DRAFT") throw new Error("ledger_work_not_replayable");
      const now=this.clock(), token=crypto.randomUUID();
      const until=now+REVIEW_LEASE_MS;
      await tx.put(key,{...prior,state:"REVIEW_LEASED",lease:{token,until},updated_at:now});
      await tx.delete(pending);
      await tx.put(leased,{command_id:commandId,lease_until:until});
      return {state:"REVIEW_LEASED" as const,lease_token:token,lease_until:until};
    });
  }

  private assertLease(prior:ManagedDraft|undefined,token:string,allowDispatchBoundary=false):asserts prior is ManagedDraft {
    if (!prior || !prior.lease || typeof token!=="string" ||
        !token || prior.lease.token!==token ||
        prior.lease.until<=this.clock() ||
        (prior.state!=="REVIEW_LEASED" &&
         !(allowDispatchBoundary&&prior.state==="SIMULATED_DISPATCHING")))
      throw new Error("ledger_review_lease_stale_or_invalid");
  }

  /** Offline test boundary only. This method performs NO remote request.
   * Once the boundary is recorded, expiry may only lead to reconciliation;
   * it must NEVER return the work to the pending queue.
   */
  async simulateAmbiguousDispatchBoundary(commandId:string,token:string):Promise<{state:"SIMULATED_DISPATCHING"}> {
    if (!valid(commandId))throw new Error("ledger_command_invalid");
    const key=await this.key("intent",[commandId]);
    return this.store.transaction(async tx=>{
      const prior=await tx.get<ManagedDraft>(key);
      this.assertLease(prior,token);
      await tx.put(key,{...prior,state:"SIMULATED_DISPATCHING",updated_at:this.clock()});
      return {state:"SIMULATED_DISPATCHING" as const};
    });
  }

  /** This intentionally records uncertainty rather than trusting a fake success.
   * No VERIFIED transition is available in R1.2.
   */
  async flagUnknown(commandId:string,token:string,reason:"TIMEOUT"|"NETWORK_INTERRUPTED"|"PROVIDER_UNVERIFIED"):Promise<{state:"RECONCILIATION_REQUIRED"}> {
    if (!valid(commandId) || !["TIMEOUT","NETWORK_INTERRUPTED","PROVIDER_UNVERIFIED"].includes(reason))
      throw new Error("ledger_unknown_request_invalid");
    const key=await this.key("intent",[commandId]);
    const leased=await this.key("leased",[commandId]);
    const reconcile=await this.key("reconcile",[commandId]);
    return this.store.transaction(async tx=>{
      const prior=await tx.get<ManagedDraft>(key);
      this.assertLease(prior,token,true);
      const updated:ManagedDraft={...prior,state:"RECONCILIATION_REQUIRED",
        reason,lease:undefined,updated_at:this.clock()};
      await tx.put(key,updated);
      await tx.delete(leased);
      await tx.put(reconcile,{command_id:commandId});
      return {state:"RECONCILIATION_REQUIRED" as const};
    });
  }

  /** Negative/needs-review outcome only. No approved/success/verified state. */
  async finishLocalReview(commandId:string,token:string,reason:string):Promise<{state:"REVIEW_REQUIRED"}> {
    if (!valid(commandId)||!valid(reason))throw new Error("ledger_review_request_invalid");
    const key=await this.key("intent",[commandId]);
    const leased=await this.key("leased",[commandId]);
    return this.store.transaction(async tx=>{
      const prior=await tx.get<ManagedDraft>(key);
      this.assertLease(prior,token);
      await tx.put(key,{...prior,state:"REVIEW_REQUIRED",reason,lease:undefined,updated_at:this.clock()});
      await tx.delete(leased);
      return {state:"REVIEW_REQUIRED" as const};
    });
  }

  /** Recover only review leases that have never crossed a simulated dispatch
   * boundary. An expired attempt with possible effects becomes UNKNOWN.
   */
  async recoverExpiredLease(commandId:string):Promise<{
    state:string;recovered:boolean
  }> {
    if (!valid(commandId))throw new Error("ledger_command_invalid");
    const key=await this.key("intent",[commandId]);
    const pending=await this.key("pending",[commandId]);
    const leased=await this.key("leased",[commandId]);
    const reconcile=await this.key("reconcile",[commandId]);
    return this.store.transaction(async tx=>{
      const prior=await tx.get<ManagedDraft>(key);
      if (!prior) throw new Error("ledger_command_not_found");
      if (!prior.lease || !["REVIEW_LEASED","SIMULATED_DISPATCHING"].includes(prior.state) ||
          prior.lease.until>this.clock())
        return {state:prior.state,recovered:false};
      const afterBoundary=prior.state==="SIMULATED_DISPATCHING";
      const state=afterBoundary?"RECONCILIATION_REQUIRED":"DRAFT";
      await tx.put(key,{...prior,state,updated_at:this.clock(),lease:undefined,
        ...(afterBoundary?{reason:"EXPIRED_AFTER_AMBIGUOUS_BOUNDARY"}:{})});
      await tx.delete(leased);
      if (afterBoundary)await tx.put(reconcile,{command_id:commandId});
      else await tx.put(pending,{command_id:commandId});
      return {state,recovered:true};
    });
  }

  /** Local, resumable lease sweeper: a future durable alarm can invoke this
   * with a persisted cursor. It does not dispatch any provider requests.
   */
  async scanExpiredLeases(options:{limit?:number;cursor?:string} = {}):Promise<{
    examined:number;recovered:number;next_cursor:string|null
  }> {
    const limit=options.limit??20;
    const prefix="core:v1:"+this.tenant+":leased:";
    if (!Number.isSafeInteger(limit)||limit<1||limit>50 ||
        (options.cursor!==undefined &&
         (typeof options.cursor!=="string"||!options.cursor.startsWith(prefix))))
      throw new Error("ledger_lease_page_invalid");
    const rows=await this.store.list<{command_id:string;lease_until:number}>({
      prefix,limit,...(options.cursor?{startAfter:options.cursor}:{})
    });
    const keys=[...rows.keys()];
    let recovered=0;
    for (const row of rows.values()){
      if (!valid(row.command_id) || !Number.isSafeInteger(row.lease_until))
        throw new Error("ledger_lease_index_corrupt");
      if (row.lease_until<=this.clock()) {
        const result=await this.recoverExpiredLease(row.command_id);
        if (result.recovered) recovered++;
      }
    }
    return {examined:rows.size,recovered,
      next_cursor:keys.length===limit?keys[keys.length-1]:null};
  }

  /** Observation remains untrusted until the provider adapter verifies it.
   * It is diagnostic only; it cannot change RECONCILIATION_REQUIRED to VERIFIED.
   */
  async recordReconciliationNote(note:ReconciliationNote):Promise<{status:"RECORDED"|"DUPLICATE";still_blocked:true}> {
    if (!valid(note.command_id)||!valid(note.evidence_ref)||
        !["FOUND","NOT_FOUND","UNKNOWN"].includes(note.observation)||
        typeof note.observation_hash!=="string"||!SHA256_RE.test(note.observation_hash))
      throw new Error("ledger_reconciliation_note_invalid");
    const key=await this.key("intent",[note.command_id]);
    const noteKey=await this.key("reconcile_note",[note.command_id,note.evidence_ref]);
    return this.store.transaction(async tx=>{
      const command=await tx.get<ManagedDraft>(key);
      if (!command || command.state!=="RECONCILIATION_REQUIRED")
        throw new Error("ledger_reconciliation_not_required");
      const before=await tx.get<ReconciliationNote>(noteKey);
      if (before) {
        if (before.observation!==note.observation||
            before.observation_hash!==note.observation_hash)
          throw new Error("ledger_reconciliation_evidence_conflict");
        return {status:"DUPLICATE" as const,still_blocked:true as const};
      }
      await tx.put(noteKey,{...note,observed_at:this.clock()});
      return {status:"RECORDED" as const,still_blocked:true as const};
    });
  }


  /**
   * R1.3: atomic observation of a complete marketplace order, NOT import.
   * Identity is account+orderId for Amazon (regardless of country).
   * Spartoo identity conservatively includes marketplace until adapter verifies
   * the contractual uniqueness scope. No customer PII or raw provider response.
   * Every revision, including obsolete observations, is locally deduplicated.
   */
  async observeMarketplaceOrder(input:OrderSnapshot):Promise<{
    status:"RECORDED"|"DUPLICATE"|"STALE";
    revision:number;import_state:"SHADOW_ONLY";requires_adoption_check:true
  }> {
    const item=validateOrderSnapshot(input);
    const identity=item.provider==="amazon"
      ? [item.provider,item.account,item.order_id]
      : [item.provider,item.account,item.marketplace_id,item.order_id];
    const rowKey=await this.key("order",identity);
    const auditKey=await this.key("order_version",[...identity,item.source_updated_at]);
    const snapshotHash=await digest(JSON.stringify(item));
    const updatedMs=Date.parse(item.source_updated_at);
    return this.store.transaction(async tx=>{
      const current=await tx.get<StoredOrderObservation>(rowKey);
      const audit=await tx.get<{snapshot_hash:string}>(auditKey);
      if (audit && audit.snapshot_hash!==snapshotHash)
        throw new Error("ledger_order_same_version_conflict");
      if (current) {
        if (current.marketplace_id!==item.marketplace_id)
          throw new Error("ledger_order_marketplace_conflict");
        if (updatedMs<current.updated_ms) {
          // Historical versions must never revert newer snapshots.
          if (!audit)await tx.put(auditKey,{snapshot_hash:snapshotHash,observed_at:this.clock()});
          return {
            status:"STALE" as const,revision:current.revision,
            import_state:"SHADOW_ONLY" as const,requires_adoption_check:true as const
          };
        }
        if (updatedMs===current.updated_ms) {
          if (current.snapshot_hash!==snapshotHash)
            throw new Error("ledger_order_same_version_conflict");
          return {
            status:"DUPLICATE" as const,revision:current.revision,
            import_state:"SHADOW_ONLY" as const,requires_adoption_check:true as const
          };
        }
      }
      const revision=(current?.revision??0)+1;
      const observedAt=this.clock();
      await tx.put(auditKey,{snapshot_hash:snapshotHash,observed_at:observedAt});
      await tx.put(rowKey,{
        ...item,snapshot_hash:snapshotHash,updated_ms:updatedMs,
        observed_at:observedAt,revision,import_state:"SHADOW_ONLY"
      } satisfies StoredOrderObservation);
      return {
        status:"RECORDED" as const,revision,
        import_state:"SHADOW_ONLY" as const,requires_adoption_check:true as const
      };
    });
  }

  /** Diagnostic read only. No state transition can authorize Shopify orderCreate. */
  async readMarketplaceOrder(key:{
    provider:"amazon"|"spartoo";account:string;order_id:string;marketplace_id?:string
  }):Promise<StoredOrderObservation|null> {
    if (!key||!["amazon","spartoo"].includes(key.provider)||
        !valid(key.account)||!valid(key.order_id)||
        (key.provider==="spartoo"&&!valid(key.marketplace_id)))
      throw new Error("ledger_order_lookup_invalid");
    const identity=key.provider==="amazon"
      ? [key.provider,key.account,key.order_id]
      : [key.provider,key.account,key.marketplace_id!,key.order_id];
    const rowKey=await this.key("order",identity);
    const stored=await this.store.get<StoredOrderObservation>(rowKey);
    return stored?{...stored,items:stored.items.map(x=>({...x}))}:null;
  }

  /** R1.2 has NO live adapter, owner handoff, Shopify stock reflection,
   * authorization, webhook ingress, or provider write path.
   */

}

/** Conservative risk estimator, NOT a remote inventory write authorization.
 * The caller must later supply authoritative observations from provider adapters.
 */
export function simulateExposureBudget(input: {
  shopify_available: number | null;
  unreflected_reservations: number | null;
  buffer: number;
  surfaces: Array<{id:string;confirmed:number|null;unresolved_increase:number|null}>;
}): {status:"SIMULATION_ONLY"|"BLOCKED_UNKNOWN"|"CAPACITY_DEFICIT"; budget:number|null; maximum_exposure:number|null} {
  const unknown={status:"BLOCKED_UNKNOWN" as const,budget:null,maximum_exposure:null};
  if (!safeQty(input.shopify_available) || !safeQty(input.unreflected_reservations) ||
      !safeQty(input.buffer) || !Array.isArray(input.surfaces)) return unknown;
  let maximum=0; const ids=new Set<string>();
  for (const x of input.surfaces) {
    if (!valid(x.id) || ids.has(x.id) || !safeQty(x.confirmed) ||
        !safeQty(x.unresolved_increase)) return unknown;
    ids.add(x.id);
    const high=Math.max(x.confirmed,x.unresolved_increase);
    if (!Number.isSafeInteger(maximum+high)) return unknown;
    maximum+=high;
  }
  const budget=Math.max(0,input.shopify_available-input.unreflected_reservations-input.buffer);
  return maximum>budget
    ? {status:"CAPACITY_DEFICIT",budget,maximum_exposure:maximum}
    : {status:"SIMULATION_ONLY",budget,maximum_exposure:maximum};
}
