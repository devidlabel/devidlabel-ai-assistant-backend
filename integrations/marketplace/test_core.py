import json
import os
import tempfile
import unittest
from unittest.mock import patch
from core import Ledger, gtin_valid, sku_kind, match_identity
from service import scan_tick, AmazonReader, MareReader


class FoundationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "ledger.sqlite")
        self.now = [1000]
        self.ledger = Ledger(self.path, lambda: self.now[0])

    def tearDown(self):
        self.ledger.close()
        self.tmp.cleanup()

    def test_gtins_and_obsolete_classification(self):
        for value in ("8052855361074", "036000291452", "96385074", "10012345000017"):
            self.assertTrue(gtin_valid(value), value)
        for value in ("8052855361075", "123", None, " 8052855361074"):
            self.assertFalse(gtin_valid(value))
        self.assertEqual(sku_kind("001234"), "obsolete_numeric")
        self.assertEqual(sku_kind("DL_123_M"), "current")
        self.assertEqual(sku_kind("4B12_PLAY_37_EU"), "quarantine")

    def test_reservation_replay_out_of_order_and_reflection(self):
        ledger = self.ledger
        self.assertTrue(ledger.reserve("amazon", "o1", "l1", "DL_A", 2, 2))
        self.assertFalse(ledger.reserve("amazon", "o1", "l1", "DL_A", 2, 2))
        self.assertFalse(ledger.reserve("amazon", "o1", "l1", "DL_A", 3, 1))
        self.assertTrue(ledger.reserve("spartoo", "o2", "l1", "DL_A", 1, 1))
        args = ("DL_A", {"loc": 10}, ["loc"])
        self.assertEqual(ledger.budget(*args, buffer=1, fresh=True, orders_complete=True), 6)
        ledger.reflect("amazon", "o1", "l1", 2, "shopify-inventory-readback:version2")
        self.assertEqual(ledger.budget("DL_A", {"loc": 8}, ["loc"], buffer=1, fresh=True, orders_complete=True), 6)
        with self.assertRaises(ValueError):
            ledger.reflect("amazon", "o1", "l1", 1, "stale")
        with self.assertRaises(ValueError):
            ledger.reserve("amazon", "o1", "l1", "DL_A", 4, 2)

    def test_unknown_stock_and_numeric_never_available(self):
        ledger = self.ledger
        self.assertEqual(ledger.budget("123", {"loc": 10}, ["loc"], fresh=True, orders_complete=True), 0)
        self.assertEqual(ledger.budget("DL_A", {"loc": 10}, ["loc"], fresh=False, orders_complete=True), 0)
        self.assertEqual(ledger.budget("DL_A", {"loc": 10}, ["loc"], fresh=True, orders_complete=False), 0)
        self.assertEqual(ledger.budget("DL_A", {}, ["loc"], fresh=True, orders_complete=True), 0)
        with self.assertRaises(ValueError):
            ledger.allocations(3, {"amazon": 3, "spartoo": 3})
        self.assertEqual(ledger.allocations(3, {"amazon": 2, "spartoo": 1}), {"amazon": 2, "spartoo": 1})

    def test_ownership_fence_rejects_old_queue_and_unimplemented_live(self):
        key = ("amazon", "IT", "inventory", "DL_A")
        job_id = self.ledger.enqueue(key, {"quantity": 0})
        self.assertEqual(job_id, self.ledger.enqueue(key, {"quantity": 0}))
        old = self.ledger.claim()
        with self.assertRaises(ValueError):
            self.ledger.guard(old, live=True)
        proof = {k: True for k in ("previous_writer_disabled", "queues_drained", "readback_verified", "orders_reconciled")}
        proof["reference"] = "verified-cutover-record"
        self.ledger.transfer(key, 0, "mare", proof)
        with self.assertRaises(ValueError):
            self.ledger.guard(old, live=True)
        self.ledger.enqueue(key, {"quantity": 0})
        new = self.ledger.claim()
        with self.assertRaises(NotImplementedError):
            self.ledger.guard(new, live=True)
        with self.assertRaises(ValueError):
            self.ledger.transfer(key, 0, "channable", proof)

    def test_jobs_persist_retry_dead_letter_and_expired_lease(self):
        key = ("amazon", "IT", "catalog", "DL_A")
        job_id = self.ledger.enqueue(key, {"sku": "DL_A"})
        job = self.ledger.claim(lease=5)
        self.ledger.close()
        self.ledger = Ledger(self.path, lambda: self.now[0])
        self.assertIsNone(self.ledger.claim())
        self.now[0] += 6
        newer = self.ledger.claim()
        with self.assertRaises(ValueError):
            self.ledger.finish(job, result={"ok": True})
        self.ledger.finish(newer, error="rate_limited", retryable=True)
        self.assertIsNone(self.ledger.claim())
        self.now[0] += 100
        retry = self.ledger.claim()
        self.ledger.finish(retry, error="mapping_invalid", retryable=False)
        row = self.ledger.db.execute("SELECT state FROM jobs WHERE id=?", (job_id,)).fetchone()
        self.assertEqual(row[0], "dead_letter")

    def test_unknown_dispatch_requires_reconciliation(self):
        key = ("amazon", "IT", "inventory", "DL_A")
        job_id = self.ledger.enqueue(key, {"quantity": 0})
        self.ledger.claim(lease=1)
        self.ledger.db.execute("UPDATE jobs SET state='dispatching' WHERE id=?", (job_id,))
        self.now[0] += 2
        self.assertIsNone(self.ledger.claim())
        self.assertEqual(self.ledger.db.execute("SELECT state FROM jobs WHERE id=?", (job_id,)).fetchone()[0], "reconciliation_required")

    def test_match_requires_all_dimensions(self):
        identity = {"gtin": "8052855361074", "brand": "Brand", "model": "Model", "color": "Black", "size": "37", "size_system": "EU"}
        self.assertTrue(match_identity(identity, identity))
        self.assertFalse(match_identity(identity, {**identity, "size": "38"}))
        self.assertFalse(match_identity(identity, {**identity, "color": ""}))

    def test_event_conflict(self):
        self.assertTrue(self.ledger.ingest_event("amazon", "e1", {"v": 1}))
        self.assertFalse(self.ledger.ingest_event("amazon", "e1", {"v": 1}))
        with self.assertRaises(ValueError):
            self.ledger.ingest_event("amazon", "e1", {"v": 2})

    def test_scanner_boundary_and_restart(self):
        class Reader:
            queries = []
            def page(inner, query):
                inner.queries.append(query)
                if len(inner.queries) == 1:
                    return {"truncated": True}, [{"id": "gid://shopify/Product/1", "updated_at": "2026-10-09T00:00:00Z"}]
                if len(inner.queries) == 2:
                    return {"truncated": True}, [{"id": "gid://shopify/Product/2", "updated_at": "2026-10-09T00:00:00Z"}]
                return {"truncated": False}, []
        reader = Reader()
        scan_tick(self.ledger, reader)
        self.ledger.close()
        self.ledger = Ledger(self.path)
        scan_tick(self.ledger, reader)
        self.assertIn("NOT id:1", reader.queries[1])
        state = scan_tick(self.ledger, reader)
        self.assertIn("NOT id:1", reader.queries[2])
        self.assertIn("NOT id:2", reader.queries[2])
        self.assertTrue(state["complete"])
        self.assertEqual(self.ledger.db.execute("SELECT COUNT(*) FROM catalog").fetchone()[0], 2)

    def test_adapters_reject_writes_and_missing_config(self):
        with self.assertRaises(ValueError):
            AmazonReader("", "", "", "", "")
        reader = AmazonReader("id", "secret", "refresh", "seller", "market")
        with self.assertRaises(ValueError):
            reader.get("/orders/v0/orders", {})
        mare = MareReader("https://devidlabel-ai-assistant-backend.devidlabel.workers.dev/mcp-business", "token")
        with self.assertRaises(ValueError):
            mare.call("mare_execute", {})


if __name__ == "__main__":
    unittest.main()
