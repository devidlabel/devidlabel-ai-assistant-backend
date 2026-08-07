type JsonObject = Record<string, unknown>;

type DurableStorageTransactionLike = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
};

type DurableStorageLike = DurableStorageTransactionLike & {
  transaction<T>(callback: (txn: DurableStorageTransactionLike) => Promise<T>): Promise<T>;
};

type DurableStateLike = {
  storage: DurableStorageLike;
};

type LedgerStatus = "executing" | "completed" | "reconciliation_required";

type Ledger = {
  plan_id: string;
  claim_id: string;
  status: LedgerStatus;
  created_at: string;
  updated_at: string;
  detail?: string;
};

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
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

export class MarePlanCoordinator {
  constructor(private readonly state: DurableStateLike) {}

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
      const result = await this.state.storage.transaction(async (txn) => {
        const current = await txn.get<Ledger>("ledger");
        if (current) {
          return {
            ok: false,
            error: current.status === "completed" ? "plan_already_completed" : current.status === "reconciliation_required" ? "plan_reconciliation_required" : "plan_already_executing",
            ledger: current,
          };
        }
        const now = new Date().toISOString();
        const ledger: Ledger = {
          plan_id: planId,
          claim_id: crypto.randomUUID(),
          status: "executing",
          created_at: now,
          updated_at: now,
        };
        await txn.put("ledger", ledger);
        return { ok: true, ledger };
      });
      return json(result, result.ok ? 200 : 409);
    }

    if (action === "status") {
      const current = await this.state.storage.get<Ledger>("ledger");
      return json({ ok: true, ledger: current || null });
    }

    if (action === "complete" || action === "reconciliation_required") {
      if (!claimId) return json({ ok: false, error: "claim_id_required" }, 400);
      const result = await this.state.storage.transaction(async (txn) => {
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
        return { ok: true, ledger: next };
      });
      return json(result, result.ok ? 200 : 409);
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  }
}
