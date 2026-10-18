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
  constructor(private readonly store: Store, private readonly tenant: string) {
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

  /** No MarkReflected/Authorize/Dispatch endpoints exist in R1. */
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
