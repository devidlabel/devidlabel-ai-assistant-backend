"""MARE marketplace foundation. Default is shadow; no provider writes are implemented."""
import hashlib
import json
import re
import sqlite3
import time
from contextlib import contextmanager


def gtin_valid(value):
    if not isinstance(value, str) or not re.fullmatch(r"(?:\d{8}|\d{12}|\d{13}|\d{14})", value):
        return False
    total = sum(int(c) * (3 if i % 2 == 0 else 1) for i, c in enumerate(reversed(value[:-1])))
    return (10 - total % 10) % 10 == int(value[-1])


def sku_kind(sku):
    if not isinstance(sku, str) or not sku or sku != sku.strip():
        return "quarantine"
    if re.fullmatch(r"\d+", sku):
        return "obsolete_numeric"
    # Digit-leading brands such as 4B12 are reviewed explicitly, never classified as obsolete.
    return "current" if re.match(r"^[A-Za-z]", sku) else "quarantine"


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def match_identity(expected, actual):
    fields = ("gtin", "brand", "model", "color", "size", "size_system")
    # Country-specific, reviewed normalization belongs upstream; no fuzzy acceptance.
    return all(isinstance(expected.get(k), str) and expected[k] and expected[k] == actual.get(k) for k in fields)


class Ledger:
    def __init__(self, path, clock=time.time):
        self.clock = clock
        self.db = sqlite3.connect(path, isolation_level=None, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS owner (
          channel TEXT, country TEXT, flow TEXT, scope TEXT,
          system TEXT NOT NULL DEFAULT 'channable', epoch INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL DEFAULT 'active', proof TEXT,
          PRIMARY KEY(channel,country,flow,scope));
        CREATE TABLE IF NOT EXISTS reservations (
          channel TEXT, order_id TEXT, line_id TEXT, sku TEXT NOT NULL,
          quantity INTEGER NOT NULL CHECK(quantity>=0), version INTEGER NOT NULL,
          reflected INTEGER NOT NULL DEFAULT 0, proof TEXT,
          PRIMARY KEY(channel,order_id,line_id));
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, channel TEXT NOT NULL, country TEXT NOT NULL,
          flow TEXT NOT NULL, scope TEXT NOT NULL, epoch INTEGER NOT NULL,
          payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0, due REAL NOT NULL,
          lease_until REAL, lease_token TEXT, result TEXT, error TEXT);
        CREATE TABLE IF NOT EXISTS events (
          source TEXT, event_id TEXT, payload_hash TEXT NOT NULL,
          PRIMARY KEY(source,event_id));
        CREATE TABLE IF NOT EXISTS audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL,
          action TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS checkpoints (
          name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS catalog (
          run_id TEXT, product_id TEXT, payload TEXT NOT NULL,
          PRIMARY KEY(run_id,product_id));
        ''')

    @contextmanager
    def tx(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def audit(self, action, data):
        self.db.execute("INSERT INTO audit(at,action,data) VALUES(?,?,?)", (self.clock(), action, json.dumps(data, sort_keys=True)))

    def close(self):
        self.db.close()

    def ingest_event(self, source, event_id, payload):
        digest = fingerprint(payload)
        with self.tx():
            row = self.db.execute("SELECT payload_hash FROM events WHERE source=? AND event_id=?", (source, event_id)).fetchone()
            if row:
                if row[0] != digest:
                    raise ValueError("event_id_payload_conflict")
                return False
            self.db.execute("INSERT INTO events VALUES(?,?,?)", (source, event_id, digest))
            return True

    def reserve(self, channel, order_id, line_id, sku, quantity, version):
        if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity < 0:
            raise ValueError("invalid_quantity")
        if not isinstance(version, int) or version < 0 or not sku:
            raise ValueError("invalid_reservation")
        with self.tx():
            old = self.db.execute("SELECT * FROM reservations WHERE channel=? AND order_id=? AND line_id=?", (channel, order_id, line_id)).fetchone()
            if old and version < old["version"]:
                return False
            if old and version == old["version"]:
                if (sku, quantity) != (old["sku"], old["quantity"]):
                    raise ValueError("reservation_version_conflict")
                return False
            if old and sku != old["sku"]:
                raise ValueError("reservation_sku_changed")
            # Any newer quantity resets reflection: prove the new version is in Shopify.
            self.db.execute("INSERT INTO reservations VALUES(?,?,?,?,?,?,0,NULL) ON CONFLICT(channel,order_id,line_id) DO UPDATE SET quantity=excluded.quantity,version=excluded.version,reflected=0,proof=NULL", (channel, order_id, line_id, sku, quantity, version))
            self.audit("reservation_observed", {"channel": channel, "sku": sku, "quantity": quantity, "version": version})
            return True

    def reflect(self, channel, order_id, line_id, version, proof):
        if not proof:
            raise ValueError("shopify_reflection_proof_required")
        with self.tx():
            result = self.db.execute("UPDATE reservations SET reflected=1,proof=? WHERE channel=? AND order_id=? AND line_id=? AND version=?", (proof, channel, order_id, line_id, version))
            if result.rowcount != 1:
                raise ValueError("reservation_version_changed")

    def budget(self, sku, available_by_location, allowed_locations, buffer=0, fresh=False, orders_complete=False):
        if sku_kind(sku) != "current":
            return 0
        if not fresh or not orders_complete or not allowed_locations:
            return 0
        if not isinstance(buffer, int) or buffer < 0:
            raise ValueError("invalid_buffer")
        if len(allowed_locations) != len(set(allowed_locations)):
            raise ValueError("duplicate_location")
        values = [available_by_location.get(k) for k in allowed_locations]
        if any(not isinstance(v, int) or isinstance(v, bool) for v in values):
            return 0
        pending = self.db.execute("SELECT COALESCE(SUM(quantity),0) FROM reservations WHERE sku=? AND reflected=0", (sku,)).fetchone()[0]
        # available already excludes Shopify committed; do not subtract it again.
        return max(0, sum(values) - pending - buffer)

    def allocations(self, budget, channel_caps):
        if not isinstance(budget, int) or budget < 0:
            raise ValueError("invalid_budget")
        if any(not isinstance(v, int) or isinstance(v, bool) or v < 0 for v in channel_caps.values()):
            raise ValueError("invalid_channel_cap")
        if sum(channel_caps.values()) > budget:
            raise ValueError("shared_stock_overallocated")
        return dict(channel_caps)

    def owner(self, key):
        row = self.db.execute("SELECT * FROM owner WHERE channel=? AND country=? AND flow=? AND scope=?", key).fetchone()
        return dict(row) if row else {"system": "channable", "epoch": 0, "state": "active"}

    def transfer(self, key, expected_epoch, system, proof):
        if system not in ("mare", "channable") or not proof:
            raise ValueError("cutover_proof_required")
        required = ("previous_writer_disabled", "queues_drained", "readback_verified", "orders_reconciled")
        if not all(proof.get(k) is True for k in required) or not proof.get("reference"):
            raise ValueError("cutover_not_verified")
        with self.tx():
            old = self.owner(key)
            if old["epoch"] != expected_epoch:
                raise ValueError("owner_epoch_conflict")
            self.db.execute("INSERT INTO owner VALUES(?,?,?,?,?,?,'active',?) ON CONFLICT(channel,country,flow,scope) DO UPDATE SET system=excluded.system,epoch=excluded.epoch,state='active',proof=excluded.proof", (*key, system, expected_epoch + 1, json.dumps(proof)))
            self.audit("owner_transferred", {"key": key, "system": system, "epoch": expected_epoch + 1, "reference": proof["reference"]})

    def enqueue(self, key, payload):
        with self.tx():
            owner = self.owner(key)
            job = fingerprint({"key": key, "epoch": owner["epoch"], "payload": payload})
            self.db.execute("INSERT OR IGNORE INTO jobs(id,channel,country,flow,scope,epoch,payload,due) VALUES(?,?,?,?,?,?,?,?)", (job, *key, owner["epoch"], json.dumps(payload, sort_keys=True), self.clock()))
            return job

    def claim(self, lease=60):
        with self.tx():
            now = self.clock()
            # External dispatches with unknown outcomes must be reconciled, never replayed.
            self.db.execute("UPDATE jobs SET state='reconciliation_required',error='dispatch_outcome_unknown' WHERE state='dispatching' AND lease_until<=?", (now,))
            self.db.execute("UPDATE jobs SET state='pending',lease_token=NULL WHERE state='leased' AND lease_until<=?", (now,))
            row = self.db.execute("SELECT * FROM jobs WHERE state='pending' AND due<=? ORDER BY due,id LIMIT 1", (now,)).fetchone()
            if not row:
                return None
            token = fingerprint({"job": row["id"], "attempt": row["attempts"] + 1, "now": now})
            self.db.execute("UPDATE jobs SET state='leased',attempts=attempts+1,lease_until=?,lease_token=? WHERE id=?", (now + lease, token, row["id"]))
            return dict(self.db.execute("SELECT * FROM jobs WHERE id=?", (row["id"],)).fetchone())

    def guard(self, job, live=False):
        if not live:
            return "shadow"
        key = tuple(job[k] for k in ("channel", "country", "flow", "scope"))
        current = self.owner(key)
        if current["system"] != "mare" or current["state"] != "active" or current["epoch"] != job["epoch"]:
            raise ValueError("writer_not_owned_or_stale_epoch")
        # This release cannot be enabled through a flag: provider writes are intentionally absent.
        raise NotImplementedError("live_adapter_not_implemented")

    def finish(self, job, result=None, error=None, retryable=False, max_attempts=6):
        with self.tx():
            row = self.db.execute("SELECT * FROM jobs WHERE id=?", (job["id"],)).fetchone()
            if not row or row["state"] != "leased" or row["lease_token"] != job["lease_token"] or row["lease_until"] <= self.clock():
                raise ValueError("lease_lost")
            state = "verified" if error is None else ("pending" if retryable and row["attempts"] < max_attempts else "dead_letter")
            due = self.clock() + min(3600, 2 ** row["attempts"] * 5)
            self.db.execute("UPDATE jobs SET state=?,result=?,error=?,due=?,lease_token=NULL,lease_until=NULL WHERE id=?", (state, json.dumps(result) if result is not None else None, error, due, job["id"]))
            self.audit("job_finished", {"job": job["id"], "state": state, "error": error})

    def checkpoint(self, name, value=None):
        if value is None:
            row = self.db.execute("SELECT value FROM checkpoints WHERE name=?", (name,)).fetchone()
            return json.loads(row[0]) if row else None
        self.db.execute("INSERT INTO checkpoints VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value", (name, json.dumps(value)))

    def store_page(self, run_id, products, checkpoint):
        with self.tx():
            for product in products:
                self.db.execute("INSERT INTO catalog VALUES(?,?,?) ON CONFLICT(run_id,product_id) DO UPDATE SET payload=excluded.payload", (run_id, product["id"], json.dumps(product)))
            self.checkpoint("catalog_scan", checkpoint)


def audit_catalog(products):
    skus, gtins, rows = {}, {}, []
    for product in products:
        for variant in product.get("variants", []):
            row = {"product_id": product["id"], "status": product["status"], **variant}
            rows.append(row)
            if row.get("sku"):
                skus.setdefault(row["sku"], []).append(row["id"])
            if row.get("barcode"):
                gtins.setdefault(row["barcode"], []).append(row["id"])
    return {
        "products": len(products), "variants": len(rows),
        "missing_sku": sum(not r.get("sku") for r in rows),
        "numeric_sku": sum(sku_kind(r.get("sku")) == "obsolete_numeric" for r in rows),
        "quarantined_sku": sum(sku_kind(r.get("sku")) == "quarantine" for r in rows),
        "missing_gtin": sum(not r.get("barcode") for r in rows),
        "invalid_gtin": sum(bool(r.get("barcode")) and not gtin_valid(r["barcode"]) for r in rows),
        "duplicate_skus": {k: v for k, v in skus.items() if len(v) > 1},
        "duplicate_gtins": {k: v for k, v in gtins.items() if len(v) > 1},
    }
