import { DurableObject } from "cloudflare:workers";
import { readShopifyCatalogComplete } from "./mare-business-shopify-complete.js";

type Row = Record<string, unknown>;
type Store = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<unknown>;
  list<T>(options: { prefix: string; limit: number }): Promise<Map<string, T>>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;
};
type Namespace = { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
export type ShadowEnv = {
  MARE_MARKETPLACE_SHADOW?: Namespace;
  MARE_MARKETPLACE_SHADOW_ENABLED?: string;
  MARE_BUSINESS_ACCESS_TOKEN?: string;
  [key: string]: unknown;
};
type Scan = {
  id: string; started_at: number; cursor: string | null; pages: number;
  products: number; variants: number; related_complete: boolean;
};
type State = {
  scan?: Scan; completed?: Scan & { completed_at: number };
  cleanup?: string; next_at: number; failures: number;
  lease?: { token: string; until: number }; last_page_at?: number;
  last_error?: string;
};
const HOUR = 3_600_000;
const CYCLE = HOUR / 2;
const LEASE = 120_000;
const PAGE_SIZE = 20;
const KEY = "runner:v1";
const enabled = (env: ShadowEnv) => env.MARE_MARKETPLACE_SHADOW_ENABLED === "true";
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

export function shadowHealth(state: State | undefined, now: number, active: boolean): Row {
  const completed = state?.completed;
  // Freshness is measured from the oldest possible observation, not scan completion.
  const fresh = !!completed && now - completed.started_at <= HOUR;
  return {
    mode: "shadow", enabled: active, ready_for_marketplace_writes: false,
    healthy: active && fresh && completed?.related_complete === true && !state?.last_error && state?.failures === 0,
    stock_fresh: fresh, scan_in_progress: !!state?.scan,
    last_completed_at: completed?.completed_at ?? null,
    oldest_observation_at: completed?.started_at ?? null,
    last_page_at: state?.last_page_at ?? null,
    next_attempt_at: state?.next_at ?? null,
    failures: state?.failures ?? 0, last_error: state?.last_error ?? null,
    products: completed?.products ?? 0, variants: completed?.variants ?? 0,
    related_data_complete: completed?.related_complete ?? false,
    blockers: ["shadow_only", "marketplace_orders_not_read", "gpsr_not_mapped",
      "marketplace_adapters_not_enabled", "writer_is_channable"],
  };
}

// This module contains no marketplace sender or Shopify mutation.
// Durable storage is authoritative; every completion is fenced by a lease token.
export class MareMarketplaceShadow extends DurableObject<ShadowEnv> {
  private store: Store;
  constructor(ctx: { storage: Store }, env: ShadowEnv) {
    super(ctx, env);
    this.store = ctx.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/status") {
      return response(shadowHealth(await this.store.get<State>(KEY), Date.now(), enabled(this.env)));
    }
    if (request.method !== "POST" || path !== "/tick") return response({ error: "not_found" }, 404);
    if (!enabled(this.env)) return response({ mode: "shadow", enabled: false });
    await this.store.transaction(async tx => {
      const now = Date.now();
      const state = await tx.get<State>(KEY) ?? { next_at: now, failures: 0 };
      await tx.put(KEY, state);
      await tx.setAlarm(Math.max(now + 1000, state.lease?.until ?? state.next_at));
    });
    return response({ ok: true, mode: "shadow" });
  }

  async alarm(): Promise<void> {
    if (!enabled(this.env)) { await this.store.deleteAlarm(); return; }
    const claim = await this.store.transaction(async tx => {
      const now = Date.now();
      const state = await tx.get<State>(KEY) ?? { next_at: now, failures: 0 };
      const due = Math.max(state.next_at, state.lease?.until ?? 0);
      if (due > now) { await tx.setAlarm(due); return null; }
      if (!state.scan) {
        state.scan = { id: crypto.randomUUID(), started_at: now, cursor: null,
          pages: 0, products: 0, variants: 0, related_complete: true };
      }
      state.lease = { token: crypto.randomUUID(), until: now + LEASE };
      await tx.put(KEY, state);
      // Recovery alarm is persisted before the external read begins.
      await tx.setAlarm(state.lease.until);
      return state;
    });
    if (!claim?.scan || !claim.lease) return;
    try {
      if (claim.cleanup) {
        const rows = await this.store.list({ prefix: `snapshot:${claim.cleanup}:`, limit: 100 });
        await this.store.transaction(async tx => {
          const state = await tx.get<State>(KEY);
          if (!state || state.lease?.token !== claim.lease?.token) return;
          await tx.delete([...rows.keys()]);
          if (rows.size < 100) delete state.cleanup;
          delete state.lease;
          state.next_at = Date.now() + 1000;
          await tx.put(KEY, state);
          await tx.setAlarm(state.next_at);
        });
        return;
      }
      const page = await readShopifyCatalogComplete({
        after: claim.scan.cursor, max_products: PAGE_SIZE, inline_limit: PAGE_SIZE,
        stable_order: true, include_csv: false, persist_artifacts: false,
      }, this.env);
      const products = Array.isArray(page.products) ? page.products as Row[] : [];
      const next = typeof page.next_cursor === "string" ? page.next_cursor : null;
      if (page.ok !== true || typeof page.truncated !== "boolean" || page.complete_variant_pagination !== true || page.product_count !== products.length ||
          page.variant_count !== products.reduce((n, p) => n + (Array.isArray(p.variants) ? p.variants.length : 0), 0) ||
          (page.truncated === true && (!next || next === claim.scan.cursor || !products.length))) {
        throw new Error("invalid_page");
      }
      for (const product of products) {
        if (typeof product.id !== "string" || !Array.isArray(product.variants)) throw new Error("invalid_page");
        for (const variant of product.variants as Row[]) {
          if (typeof variant.id !== "string") throw new Error("invalid_page");
        }
      }
      await this.store.transaction(async tx => {
        const state = await tx.get<State>(KEY);
        if (state?.lease?.token !== claim.lease?.token || !state?.scan) return;
        const observed = Date.now();
        for (const product of products) {
          const { variants, media, description_html, ...attributes } = product;
          await tx.put(`snapshot:${state.scan.id}:p:${product.id}`, { ...attributes, observed_at: observed });
          for (const variant of variants as Row[]) {
            const sku = typeof variant.sku === "string" ? variant.sku : "";
            await tx.put(`snapshot:${state.scan.id}:v:${variant.id}`, {
              ...variant, product_id: product.id, observed_at: observed,
              sku_policy: /^\d+$/.test(sku) ? "legacy_zero" : /^[A-Za-z]/.test(sku) ? "candidate" : "quarantine",
              proposed_marketplace_quantity: 0,
            });
          }
        }
        state.scan.pages++;
        state.scan.products += products.length;
        state.scan.variants += Number(page.variant_count ?? 0);
        state.scan.related_complete &&= page.complete_related_pagination === true;
        state.scan.cursor = next;
        state.failures = 0;
        delete state.last_error;
        delete state.lease;
        state.last_page_at = observed;
        if (page.truncated === true) {
          state.next_at = observed + 2000;
        } else {
          state.cleanup = state.completed?.id;
          state.completed = { ...state.scan, completed_at: observed };
          // Half-hour starts leave room for a <=30-minute sweep within the one-hour target.
          state.next_at = Math.max(observed + 2000, state.scan.started_at + CYCLE);
          delete state.scan;
        }
        await tx.put(KEY, state);
        await tx.setAlarm(state.next_at);
      });
    } catch (error) {
      await this.store.transaction(async tx => {
        const state = await tx.get<State>(KEY);
        if (!state || state.lease?.token !== claim.lease?.token) return;
        state.failures++;
        state.last_error = error instanceof Error && error.message === "invalid_page" ? "invalid_page" : "catalog_read_or_storage_failed";
        delete state.lease;
        const delay = Math.min(900_000, 5000 * 2 ** Math.min(state.failures - 1, 8));
        state.next_at = Date.now() + delay + Math.floor(Math.random() * 1000);
        await tx.put(KEY, state);
        await tx.setAlarm(state.next_at);
        console.error(JSON.stringify({ component: "marketplace_shadow", code: state.last_error,
          failures: state.failures, next_at: state.next_at }));
      });
    }
  }
}

async function authorized(request: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const value = request.headers.get("Authorization") ?? "";
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(value), digest(`Bearer ${token}`)]);
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
  return different === 0;
}

export async function handleMarketplaceShadowStatus(request: Request, env: ShadowEnv): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/internal/marketplace/status") return null;
  if (!await authorized(request, env.MARE_BUSINESS_ACCESS_TOKEN)) return response({ error: "unauthorized" }, 401);
  if (request.method !== "GET") return response({ error: "method_not_allowed" }, 405);
  if (!env.MARE_MARKETPLACE_SHADOW) return response({ error: "binding_missing", ready_for_marketplace_writes: false }, 503);
  return env.MARE_MARKETPLACE_SHADOW.get(env.MARE_MARKETPLACE_SHADOW.idFromName("devidlabel:catalog:v1"))
    .fetch(new Request("https://shadow/status"));
}

export async function scheduleMarketplaceShadow(env: ShadowEnv): Promise<void> {
  if (!enabled(env)) return;
  if (!env.MARE_MARKETPLACE_SHADOW) throw new Error("marketplace_shadow_binding_missing");
  const result = await env.MARE_MARKETPLACE_SHADOW.get(env.MARE_MARKETPLACE_SHADOW.idFromName("devidlabel:catalog:v1"))
    .fetch(new Request("https://shadow/tick", { method: "POST" }));
  if (!result.ok) throw new Error("marketplace_shadow_tick_failed");
}
