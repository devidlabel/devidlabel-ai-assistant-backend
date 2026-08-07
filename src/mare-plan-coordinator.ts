import { DurableObject } from "cloudflare:workers";

type JsonObject = Record<string, unknown>;

type DurableStorageTransactionLike = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
};

type DurableStateLike = {
  storage: DurableStorageTransactionLike & {
    transaction<T>(callback: (txn: DurableStorageTransactionLike) => Promise<T>): Promise<T>;
  };
};

type LedgerStatus = "executing" | "completed" | "reconciliation_required";

type Ledger = {
  plan_id: string;
  claim_id: string;
  status: LedgerStatus;
  created_at: string;
  updated_at: string;
  lease_expires_at?: string;
  detail?: string;
};

const EXECUTION_CLAIM_LEASE_MS = 5 * 60 * 1000;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function leaseExpired(ledger: Ledger): boolean {
  if (ledger.status !== "executing") return false;
  const expiry = Date.parse(normalize(ledger.lease_expires_at));
  return !Number.isFinite(expiry) || expiry <= Date.now();
}

function reconciledExpiredLedger(current: Ledger): Ledger {
  return {
    ...current,
    status: "reconciliation_required",
    updated_at: new Date().toISOString(),
    detail: "execution_claim_lease_expired_provider_state_unknown",
  };
}

function reconciliationInstruction(): string {
  return "Read the provider state first. If the planned mutation is already present, record it as reconciled operationally; otherwise prepare a new plan with a new plan_id. Never replay the expired plan blindly.";
}

export class MarePlanCoordinator extends DurableObject<Record<string, unknown>> {
  constructor(ctx: DurableStateLike, env: Record<string, unknown>) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

    let body: JsonObject;
    try {
      body = await request.json() as JsonObject;
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    const action = normalize(body.action);
    const planId = normalize(body.plan_id);
    const claimId = normalize(body.claim_id);
    if (!/^mbp_[A-Za-z0-9-]{20,80}$/.test(planId)) return json({ ok: false, error: "invalid_plan_id" }, 400);

    if (action === "claim") {
      const result = await this.ctx.storage.transaction(async (txn) => {
        const current = await txn.get<Ledger>("ledger");
        if (current) {
          if (leaseExpired(current)) {
            const reconciled = reconciledExpiredLedger(current);
            await txn.put("ledger", reconciled);
            return {
              ok: false,
              error: "plan_execution_lease_expired_reconciliation_required",
              ledger: reconciled,
              recovery_instruction: reconciliationInstruction(),
            };
          }
          return {
            ok: false,
            error: current.status === "completed"
              ? "plan_already_completed"
              : current.status === "reconciliation_required"
                ? "plan_reconciliation_required"
                : "plan_already_executing",
            ledger: current,
            ...(current.status === "reconciliation_required" ? { recovery_instruction: reconciliationInstruction() } : {}),
          };
        }
        const now = new Date();
        const ledger: Ledger = {
          plan_id: planId,
          claim_id: crypto.randomUUID(),
          status: "executing",
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
          lease_expires_at: new Date(now.getTime() + EXECUTION_CLAIM_LEASE_MS).toISOString(),
        };
        await txn.put("ledger", ledger);
        return { ok: true, ledger };
      });
      return json(result, result.ok ? 200 : 409);
    }

    if (action === "status") {
      const result = await this.ctx.storage.transaction(async (txn) => {
        const current = await txn.get<Ledger>("ledger");
        if (!current) return { ok: true, ledger: null };
        if (leaseExpired(current)) {
          const reconciled = reconciledExpiredLedger(current);
          await txn.put("ledger", reconciled);
          return { ok: true, ledger: reconciled, recovery_instruction: reconciliationInstruction() };
        }
        return {
          ok: true,
          ledger: current,
          ...(current.status === "reconciliation_required" ? { recovery_instruction: reconciliationInstruction() } : {}),
        };
      });
      return json(result);
    }

    if (action === "complete" || action === "reconciliation_required") {
      if (!claimId) return json({ ok: false, error: "claim_id_required" }, 400);
      const result = await this.ctx.storage.transaction(async (txn) => {
        const current = await txn.get<Ledger>("ledger");
        if (!current) return { ok: false, error: "execution_claim_missing" };
        if (current.plan_id !== planId) return { ok: false, error: "plan_id_mismatch", ledger: current };
        if (current.claim_id !== claimId) return { ok: false, error: "execution_claim_mismatch", ledger: current };
        if (current.status === "completed" && action === "complete") return { ok: true, idempotent_replay: true, ledger: current };
        const next: Ledger = {
          ...current,
          status: action === "complete" ? "completed" : "reconciliation_required",
          updated_at: new Date().toISOString(),
          ...(normalize(body.detail) ? { detail: normalize(body.detail).slice(0, 1000) } : {}),
        };
        await txn.put("ledger", next);
        return {
          ok: true,
          ledger: next,
          ...(next.status === "reconciliation_required" ? { recovery_instruction: reconciliationInstruction() } : {}),
        };
      });
      return json(result, result.ok ? 200 : 409);
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  }
}
