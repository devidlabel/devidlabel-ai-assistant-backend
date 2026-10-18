/* Executable DESIGN MODEL, not the production coordinator. Synthetic data only.
 * Closed-world surfaces: omitted surfaces are assumed nonexistent by this model.
 * Production must never infer UNKNOWN remote stock as zero. Authenticity and remote
 * convergence of receipts are assumptions here, not properties tested against APIs.
 */
import assert from 'node:assert/strict';

function quantity(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid_quantity');
  return n;
}
class ExposureModel {
  constructor(budget, observed, epoch = 1) {
    this.budget = budget === null ? null : quantity(budget);
    this.observed = new Map(Object.entries(observed));
    for (const q of this.observed.values()) quantity(q);
    this.pending = new Map();
    this.epoch = epoch;
    this.revision = 0;
    this.ordersComplete = true;
  }
  upperBound(surface) {
    return Math.max(this.observed.get(surface) ?? 0, this.pending.get(surface)?.quantity ?? 0);
  }
  total() {
    return [...new Set([...this.observed.keys(), ...this.pending.keys()])]
      .reduce((sum, key) => sum + this.upperBound(key), 0);
  }
  propose(surface, q, epoch = this.epoch) {
    quantity(q);
    if (epoch !== this.epoch) throw new Error('stale_epoch');
    if (this.pending.has(surface)) throw new Error('unresolved_command');
    const old = this.upperBound(surface);
    const next = this.total() - old + Math.max(old, q);
    if (q > 0 && (this.budget === null || !this.ordersComplete || next > this.budget)) {
      throw new Error('positive_exposure_blocked');
    }
    const command = { quantity: q, revision: ++this.revision, epoch };
    this.pending.set(surface, command);
    return command;
  }
  // Caller supplies a converged provider receipt, not a mere HTTP 200/ACCEPTED.
  confirm(surface, command, { converged = false, quantity: observed } = {}) {
    if (!converged) throw new Error('provider_not_converged');
    quantity(observed);
    if (command.epoch !== this.epoch) throw new Error('stale_epoch');
    if (this.pending.get(surface) !== command) throw new Error('stale_receipt');
    if (observed !== command.quantity) throw new Error('provider_drift');
    this.observed.set(surface, observed);
    this.pending.delete(surface);
  }
}
class InboxModel {
  constructor() { this.rows = new Map(); }
  accept(key, digest) {
    if (this.rows.has(key)) {
      if (this.rows.get(key) !== digest) throw new Error('event_conflict');
      return false;
    }
    this.rows.set(key, digest);
    return true;
  }
}
const tests = [];
function test(name, fn) { fn(); tests.push(name); }
test('last_unit_cannot_be_promised_twice', () => {
  const m = new ExposureModel(1, { A: 1, B: 0 });
  assert.throws(() => m.propose('B', 1), /positive_exposure_blocked/);
});
test('reduction_sent_is_not_stock_released', () => {
  const m = new ExposureModel(1, { A: 1, B: 0 });
  m.propose('A', 0);
  assert.equal(m.total(), 1);
  assert.throws(() => m.propose('B', 1));
});
test('release_requires_converged_receipt', () => {
  const m = new ExposureModel(1, { A: 1, B: 0 });
  const c = m.propose('A', 0);
  assert.throws(() => m.confirm('A', c, { quantity: 0 }));
  m.confirm('A', c, { quantity: 0, converged: true });
  m.propose('B', 1);
  assert.equal(m.total(), 1);
});
test('pending_increases_consume_capacity', () => {
  const m = new ExposureModel(1, { A: 0, B: 0 });
  m.propose('A', 1);
  assert.throws(() => m.propose('B', 1));
});
test('timeout_does_not_allow_blind_retry_or_reallocation', () => {
  const m = new ExposureModel(1, { A: 0, B: 0 });
  m.propose('A', 1);
  assert.throws(() => m.propose('A', 1), /unresolved_command/);
  assert.throws(() => m.propose('B', 1));
});
test('stale_epoch_blocks_send_and_receipt', () => {
  const m = new ExposureModel(1, { A: 0 });
  const c = m.propose('A', 1);
  m.epoch++;
  assert.throws(() => m.propose('B', 1, c.epoch), /stale_epoch/);
  assert.throws(() => m.confirm('A', c, { quantity: 1, converged: true }), /stale_epoch/);
});
test('duplicate_receipt_does_not_change_state', () => {
  const m = new ExposureModel(1, { A: 0 });
  const c = m.propose('A', 1);
  m.confirm('A', c, { quantity: 1, converged: true });
  assert.throws(() => m.confirm('A', c, { quantity: 1, converged: true }), /stale_receipt/);
});
test('unknown_snapshot_is_not_zero_evidence', () => {
  const m = new ExposureModel(null, { A: 1 });
  assert.throws(() => m.propose('B', 1));
  m.propose('A', 0);
  assert.equal(m.total(), 1);
});
test('incomplete_orders_block_positive_exposure', () => {
  const m = new ExposureModel(10, { A: 0 });
  m.ordersComplete = false;
  assert.throws(() => m.propose('A', 1));
});
test('external_stock_loss_preserves_record_of_risk', () => {
  const m = new ExposureModel(1, { A: 1 });
  m.budget = 0;
  assert(m.total() > m.budget);
  m.propose('A', 0);
  assert.equal(m.total(), 1, 'zero request is not confirmed zero');
});
test('duplicate_events_and_conflicting_payloads', () => {
  const inbox = new InboxModel();
  assert(inbox.accept('provider/account/event', 'hash-a'));
  assert.equal(inbox.accept('provider/account/event', 'hash-a'), false);
  assert.throws(() => inbox.accept('provider/account/event', 'hash-b'), /event_conflict/);
});
test('quantities_reject_invalid_and_boolean_values', () => {
  for (const q of [true, false, NaN, Infinity, -1, 0.5, '1']) assert.throws(() => quantity(q));
});
let explored = 0;
for (let budget = 0; budget <= 5; budget++) {
  for (let a = 0; a <= budget; a++) for (let b = 0; b <= budget - a; b++) {
    for (let c = 0; c <= budget - a - b; c++) {
      for (const surface of ['A', 'B', 'C']) for (let target = 0; target <= 6; target++) {
        const m = new ExposureModel(budget, { A: a, B: b, C: c });
        try { m.propose(surface, target); assert(m.total() <= budget); }
        catch (e) { if (!['positive_exposure_blocked'].includes(e.message)) throw e; }
        explored++;
      }
    }
  }
}
console.log(JSON.stringify({ scope: 'synthetic_architecture_model_only', passed: tests.length,
  exhaustive_transition_checks: explored, tests, production_tested: false, provider_apis_called: false }, null, 2));
