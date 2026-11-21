/** Same-key KV writes are limited to one per second. This guard applies only
 * to price-bound plans, including prepare, executing, progress, final and error
 * persistence. Retrying this idempotent stored record never retries a PATCH. */
type Clock = { now: () => number; wait: (ms: number) => Promise<void> };
type Slot = { tail: Promise<void>; notBefore: number; pending: number };
export function createPriceBoundsPlanStore(clock: Clock = {
  now: () => Date.now(), wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const slots = new Map<string, Slot>();
  const spacing = 1100;
  return async (key: string, put: () => Promise<void>): Promise<void> => {
    // A fresh isolate cannot know the last writer's timing: its first write
    // also waits a full interval after acquiring the existing coordinator claim.
    let slot = slots.get(key);
    if (!slot) {
      for (const [k, s] of slots) if (s.pending === 0 && s.notBefore < clock.now() - 60000) slots.delete(k);
      if (slots.size >= 512) throw Error("price_bounds_plan_store_capacity");
      slot = { tail: Promise.resolve(), notBefore: clock.now() + spacing, pending: 0 };
      slots.set(key, slot);
    }
    const state = slot; state.pending++;
    const run = state.tail.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const delay = state.notBefore - clock.now();
        if (delay > 0) await clock.wait(delay);
        try {
          await put();
          state.notBefore = clock.now() + spacing;
          return;
        } catch {
          // A failed KV response may still have persisted. Space retries too.
          state.notBefore = clock.now() + spacing;
          if (attempt === 2) throw Error("price_bounds_plan_store_failed");
        }
      }
    });
    state.tail = run;
    try { await run; } finally { state.pending--; }
  };
}
export const persistPriceBoundsRepairPlan = createPriceBoundsPlanStore();
