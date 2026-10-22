import { DurableObject } from "cloudflare:workers";

/**
 * Isolated durable one-shot journal for a FUTURE Amazon OFFER_ONLY writer.
 * This class is exported to Cloudflare but has NO public HTTP route or
 * marketplace execution binding. It NEVER calls Amazon, Shopify or Channable.
 *
 * Invariant: one object per seller/market/SKU, one persistent claim forever,
 * committed BEFORE a provider PUT. Any uncertain outcome forbids automatic
 * replay. A plan replacement must use a separately reviewed migration/policy.
 */
type Row = Record<string, unknown>;
type Store = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  transaction<T>(callback: (txn: {
    get<U = unknown>(key: string): Promise<U | undefined>;
    put(key: string, value: unknown): Promise<void>;
  }) => Promise<T>): Promise<T>;
};
type Namespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};
export type AmazonOfferJournalEnv = {
  MARE_AMAZON_OFFER_JOURNAL?: Namespace;
  MARE_BUSINESS_ACCESS_TOKEN?: string;
  AMAZON_SP_API_SELLER_ID?: string;
};
type AttemptState = "CLAIMED" | "ACCEPTED_PENDING_READBACK" |
  "OFFER_IDENTITY_QUANTITY_ZERO_VERIFIED" | "NOT_CONFIRMED_BY_PROVIDER" |
  "TRANSPORT_OR_RESPONSE_UNCERTAIN" | "SUBMISSION_OUTCOME_UNKNOWN" |
  "HTTP_UNKNOWN_EFFECT";
export type AmazonOfferClaim = {
  attempt_reference: string;
  plan_reference: string;
  scope: string;
  state: AttemptState;
  created_at: string;
  updated_at: string;
  submission_reference: string | null;
  readback_verified: boolean;
  quantity_requested: 0;
  retry_allowed: false;
  provider_mutations: "UNKNOWN" | 1;
};
const KEY = "offer-attempt:v1";
const SCOPE = /^offer-only-v1:[A-Z0-9]{8,30}:(?:IT|DE|FR|ES):[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const REF = /^[A-Za-z0-9._:-]{8,180}$/;
const MAX_BODY_BYTES = 2048;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  }});
function fail(reason: string): never { throw new Error("amazon_offer_journal_" + reason); }
function obj(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function fields(v: Row, keys: string[]): boolean {
  return Object.keys(v).sort().join(",") === keys.slice().sort().join(",");
}
function authorized(request: Request, token: unknown): boolean {
  if (typeof token !== "string" || token.length < 16) return false;
  const expected = "Bearer " + token, got = request.headers.get("Authorization") || "";
  if (got.length !== expected.length) return false;
  let delta = 0;
  for (let i = 0; i < expected.length; i++) delta |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return delta === 0;
}
function expectedScope(value: unknown, env: AmazonOfferJournalEnv): string {
  if (typeof value !== "string" || !SCOPE.test(value)) fail("invalid_scope");
  const seller = env.AMAZON_SP_API_SELLER_ID;
  if (typeof seller !== "string" || !/^[A-Z0-9]{8,30}$/.test(seller) ||
      !value.startsWith("offer-only-v1:" + seller + ":")) fail("seller_scope_mismatch");
  return value;
}
function knownAttempt(value: unknown): value is AmazonOfferClaim {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as Row;
  return fields(a, [
    "attempt_reference", "plan_reference", "scope", "state", "created_at",
    "updated_at", "submission_reference", "readback_verified", "quantity_requested",
    "retry_allowed", "provider_mutations"
  ]) && typeof a.scope === "string" && SCOPE.test(a.scope) &&
    typeof a.plan_reference === "string" && REF.test(a.plan_reference) &&
    typeof a.attempt_reference === "string" && REF.test(a.attempt_reference) &&
    typeof a.created_at === "string" && !Number.isNaN(Date.parse(a.created_at)) &&
    typeof a.updated_at === "string" && !Number.isNaN(Date.parse(a.updated_at)) &&
    a.quantity_requested === 0 && a.retry_allowed === false &&
    (a.submission_reference === null ||
      (typeof a.submission_reference === "string" && REF.test(a.submission_reference))) &&
    typeof a.readback_verified === "boolean" &&
    (a.provider_mutations === "UNKNOWN" || a.provider_mutations === 1) &&
    (["CLAIMED","ACCEPTED_PENDING_READBACK","OFFER_IDENTITY_QUANTITY_ZERO_VERIFIED",
      "NOT_CONFIRMED_BY_PROVIDER","TRANSPORT_OR_RESPONSE_UNCERTAIN",
      "SUBMISSION_OUTCOME_UNKNOWN","HTTP_UNKNOWN_EFFECT"] as unknown[]).includes(a.state);
}
function normalizeStatus(value: unknown): AttemptState {
  if (typeof value !== "string") fail("status_invalid");
  if (/^HTTP_[1-5][0-9]{2}_UNKNOWN_EFFECT$/.test(value)) return "HTTP_UNKNOWN_EFFECT";
  if (["ACCEPTED_PENDING_READBACK","OFFER_IDENTITY_QUANTITY_ZERO_VERIFIED",
    "NOT_CONFIRMED_BY_PROVIDER","TRANSPORT_OR_RESPONSE_UNCERTAIN",
    "SUBMISSION_OUTCOME_UNKNOWN"].includes(value)) return value as AttemptState;
  fail("status_invalid");
}
function boundedEvidence(value: unknown, previous: AmazonOfferClaim, newStatus: AttemptState): {
  submission_reference: string | null; readback_verified: boolean;
} {
  const e = obj(value);
  const allowed = [
    "marketplace","sku","asin","attempt_reference","provider_mutations_possible",
    "quantity_requested","automatic_retry_allowed","submission_reference","readback_verified"
  ];
  if (Object.keys(e).some(key => !allowed.includes(key)) ||
      typeof e.marketplace !== "string" || typeof e.sku !== "string" ||
      typeof e.asin !== "string" || !/^[A-Z0-9]{10}$/.test(e.asin) ||
      e.attempt_reference !== previous.attempt_reference ||
      e.provider_mutations_possible !== 1 || e.quantity_requested !== 0 ||
      e.automatic_retry_allowed !== false ||
      e.marketplace !== previous.scope.split(":")[2] ||
      e.sku !== previous.scope.split(":").slice(3).join(":"))
    fail("evidence_invalid");
  if (e.submission_reference !== undefined &&
      (typeof e.submission_reference !== "string" || !REF.test(e.submission_reference)))
    fail("submission_reference_invalid");
  if (e.readback_verified !== undefined && typeof e.readback_verified !== "boolean")
    fail("readback_state_invalid");
  const ref = (e.submission_reference as string | undefined) ?? previous.submission_reference;
  const verified = e.readback_verified === true;
  if ((newStatus === "ACCEPTED_PENDING_READBACK" ||
       newStatus === "OFFER_IDENTITY_QUANTITY_ZERO_VERIFIED") && !ref)
    fail("submission_reference_missing");
  if (newStatus === "OFFER_IDENTITY_QUANTITY_ZERO_VERIFIED" && !verified)
    fail("readback_not_verified");
  if (previous.submission_reference && e.submission_reference &&
      previous.submission_reference !== e.submission_reference)
    fail("submission_reference_conflict");
  return { submission_reference: ref ?? null, readback_verified: verified };
}
export class MareAmazonOfferAttemptJournal extends DurableObject<AmazonOfferJournalEnv> {
  private store: Store;
  constructor(ctx: { storage: Store }, env: AmazonOfferJournalEnv) {
    super(ctx, env);
    this.store = ctx.storage;
  }
  async fetch(request: Request): Promise<Response> {
    if (!authorized(request, this.env.MARE_BUSINESS_ACCESS_TOKEN))
      return json({ ok: false, error: "unauthorized" }, 401);
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/claim", "/record", "/read"].includes(path))
      return json({ ok: false, error: "not_found" }, 404);
    try {
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
        fail("content_type_invalid");
      const length = request.headers.get("content-length");
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES))
        fail("body_too_large");
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) fail("body_too_large");
      const data = obj(JSON.parse(raw));
      const scope = expectedScope(data.scope, this.env);
      // Cross-scope probes must not get responses for another object. Only
      // this exact object identity is selected by the binding adapter.
      if (path === "/claim") {
        if (!fields(data, ["scope", "plan_reference"]) ||
            typeof data.plan_reference !== "string" || !REF.test(data.plan_reference))
          fail("claim_invalid");
        let result: { claimed: boolean; attempt_reference: string | null };
        result = await this.store.transaction(async tx => {
          const prior = await tx.get<AmazonOfferClaim>(KEY);
          if (prior) {
            if (!knownAttempt(prior) || prior.scope !== scope) fail("claim_corrupt_or_scope_conflict");
            return { claimed: false, attempt_reference: null };
          }
          const now = new Date().toISOString();
          const attempt: AmazonOfferClaim = {
            scope, plan_reference: data.plan_reference as string,
            attempt_reference: "ATTEMPT-" + crypto.randomUUID(),
            state: "CLAIMED", created_at: now, updated_at: now,
            submission_reference: null, readback_verified: false,
            quantity_requested: 0, retry_allowed: false, provider_mutations: "UNKNOWN"
          };
          await tx.put(KEY, attempt);
          return { claimed: true, attempt_reference: attempt.attempt_reference };
        });
        const persisted = await this.store.get<AmazonOfferClaim>(KEY);
        if (!persisted || !knownAttempt(persisted) || persisted.scope !== scope ||
            (result.claimed && persisted.attempt_reference !== result.attempt_reference))
          fail("claim_readback_failed");
        return json(result);
      }
      if (path === "/read") {
        if (!fields(data, ["scope"])) fail("read_invalid");
        const prior = await this.store.get<AmazonOfferClaim>(KEY);
        if (prior && (!knownAttempt(prior) || prior.scope !== scope)) fail("read_corrupt");
        return json({ ok: true, exists: !!prior, state: prior ?? null });
      }
      if (!fields(data, ["scope","attempt_reference","status","evidence"]) ||
          typeof data.attempt_reference !== "string" ||
          !REF.test(data.attempt_reference)) fail("record_invalid");
      const status = normalizeStatus(data.status);
      const persisted = await this.store.transaction(async tx => {
        const prior = await tx.get<AmazonOfferClaim>(KEY);
        if (!prior || !knownAttempt(prior) || prior.scope !== scope ||
            prior.attempt_reference !== data.attempt_reference) fail("record_claim_missing");
        const patch = boundedEvidence(data.evidence, prior, status);
        // Outcome is monotonic: terminal uncertain state never transitions to
        // an automatically re-sent or falsely verified attempt.
        if (prior.state !== "CLAIMED" &&
            !(prior.state === "ACCEPTED_PENDING_READBACK" &&
              ["ACCEPTED_PENDING_READBACK","OFFER_IDENTITY_QUANTITY_ZERO_VERIFIED"].includes(status)))
          fail("record_state_conflict");
        if (prior.state === "CLAIMED" && status === "OFFER_IDENTITY_QUANTITY_ZERO_VERIFIED")
          fail("readback_without_acceptance");
        const next: AmazonOfferClaim = {
          ...prior, state: status, updated_at: new Date().toISOString(),
          submission_reference: patch.submission_reference,
          readback_verified: status === "OFFER_IDENTITY_QUANTITY_ZERO_VERIFIED",
          provider_mutations: status === "ACCEPTED_PENDING_READBACK" ||
            status === "OFFER_IDENTITY_QUANTITY_ZERO_VERIFIED" ? 1 : "UNKNOWN",
        };
        await tx.put(KEY, next);
        return next;
      });
      const readback = await this.store.get<AmazonOfferClaim>(KEY);
      if (!readback || !knownAttempt(readback) || readback.scope !== scope ||
          readback.attempt_reference !== persisted.attempt_reference ||
          readback.state !== persisted.state) fail("record_readback_failed");
      return json({ ok: true, status: readback.state, retry_allowed: false, readback_verified: readback.readback_verified });
    } catch(error) {
      const message = error instanceof Error ? error.message : "";
      const code = /^amazon_offer_journal_[a-z_]{1,80}$/.test(message) ?
        message : "amazon_offer_journal_rejected";
      return json({ ok: false, error: code, retry_allowed: false }, 409);
    }
  }
}

/**
 * PRIVATE per-execution adapter. Construct one instance per invocation, never
 * share it across requests. It cannot bypass approval or Channable gates and
 * is not hooked into a public MCP/Worker route.
 */
export function makeAmazonOfferJournalClient(env: AmazonOfferJournalEnv) {
  const ns = env.MARE_AMAZON_OFFER_JOURNAL;
  const token = env.MARE_BUSINESS_ACCESS_TOKEN;
  const seller = env.AMAZON_SP_API_SELLER_ID;
  if (!ns || typeof token !== "string" || token.length < 16 ||
      typeof seller !== "string" || !/^[A-Z0-9]{8,30}$/.test(seller))
    fail("binding_unavailable");
  let claimed: { scope: string; attempt: string } | null = null;
  async function call(scope: string, path: string, body: Row): Promise<Row> {
    expectedScope(scope, env);
    const objId = ns!.idFromName(scope);
    const reply = await ns!.get(objId).fetch(new Request("https://amazon-offer-journal.internal" + path, {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    if (!reply.ok) fail("rpc_rejected");
    const data: unknown = await reply.json().catch(() => null);
    const parsed = obj(data);
    if (parsed.ok === false) fail("rpc_invalid");
    return parsed;
  }
  return {
    atomicClaim: async (scope: string, planReference: string) => {
      if (claimed) fail("client_already_claimed");
      if (typeof planReference !== "string" || !REF.test(planReference)) fail("plan_invalid");
      const result = await call(scope, "/claim", {scope, plan_reference: planReference});
      if (typeof result.claimed !== "boolean") fail("claim_response_invalid");
      if (!result.claimed) return { claimed: false, attempt_reference: "" };
      if (typeof result.attempt_reference !== "string" || !REF.test(result.attempt_reference))
        fail("claim_response_invalid");
      claimed = { scope, attempt: result.attempt_reference };
      return { claimed: true, attempt_reference: result.attempt_reference };
    },
    storeAttemptResult: async (attempt: string, status: string, evidence: Row) => {
      if (!claimed || attempt !== claimed.attempt) fail("unclaimed_attempt");
      const result = await call(claimed.scope, "/record", {
        scope: claimed.scope, attempt_reference: attempt, status, evidence
      });
      if (result.ok !== true || result.retry_allowed !== false) fail("record_response_invalid");
    },
    readClaim: async (scope: string) => {
      return await call(scope, "/read", { scope });
    },
  };
}
