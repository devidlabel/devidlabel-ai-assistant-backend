"""Restartable read-only service. Credentials are environment variables, never output."""
import argparse
import datetime
import json
import logging
import os
import signal
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from core import Ledger, audit_catalog, gtin_valid, sku_kind

STOP = False


def http_json(url, method="GET", payload=None, headers=None):
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        # Never log response bodies: they may contain secrets, customer data, or signed URLs.
        raise RuntimeError("http_status_" + str(error.code)) from None


class MareReader:
    def __init__(self, endpoint, bearer):
        parsed = urllib.parse.urlparse(endpoint)
        if parsed.scheme != "https" or parsed.hostname != "devidlabel-ai-assistant-backend.devidlabel.workers.dev" or parsed.path != "/mcp-business" or parsed.query or parsed.username:
            raise ValueError("untrusted_mare_endpoint")
        if not bearer:
            raise ValueError("mare_bearer_missing")
        self.endpoint, self.bearer = endpoint, bearer

    def call(self, tool, arguments):
        if tool not in ("mare_read", "mare_artifact_get", "mare_system_status"):
            raise ValueError("read_only_tool_required")
        result = http_json(self.endpoint, "POST", {"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": "tools/call", "params": {"name": tool, "arguments": arguments}}, {"Authorization": "Bearer " + self.bearer, "Accept": "application/json, text/event-stream"})
        if result.get("error"):
            raise RuntimeError("mare_rpc_error")
        body = result.get("result", {})
        if body.get("isError"):
            raise RuntimeError("mare_read_failed")
        if "structuredContent" in body:
            return body["structuredContent"]
        for item in body.get("content", []):
            if item.get("type") == "text":
                return json.loads(item["text"])
        raise RuntimeError("mare_result_missing")

    def page(self, query):
        result = self.call("mare_read", {"capability_id": "shopify.catalog.read", "request": {"query": query, "max_products": 30, "inline_limit": 0, "include_csv": False}})
        artifact = self.call("mare_artifact_get", {"artifact_id": result["artifacts"]["json"]["artifact_id"]})
        if artifact.get("encoding") != "utf-8":
            raise RuntimeError("unsupported_artifact_encoding")
        products = json.loads(artifact["content"])["products"]
        if len(products) != result["product_count"]:
            raise RuntimeError("catalog_count_mismatch")
        return result, products


def scan_tick(ledger, reader):
    state = ledger.checkpoint("catalog_scan")
    if not state or (state["complete"] and time.time() - state["completed_at"] >= 86400):
        state = {"run_id": str(uuid.uuid4()), "started_at": time.time(), "query": "id:>0", "complete": False, "pages": 0}
    if state["complete"]:
        return state
    result, products = reader.page(state["query"])
    if not products and result["truncated"]:
        raise RuntimeError("empty_truncated_page")
    existing = {row[0] for row in ledger.db.execute("SELECT product_id FROM catalog WHERE run_id=?", (state["run_id"],))}
    if products and all(p["id"] in existing for p in products):
        raise RuntimeError("scan_no_progress")
    next_state = {**state, "pages": state["pages"] + 1, "complete": not result["truncated"], "last_success_at": time.time()}
    if products:
        oldest = min(p["updated_at"] for p in products)
        # Include the boundary second and exclude ALL observed IDs in that second.
        ids = {p["id"].split("/")[-1] for p in products if p["updated_at"] == oldest}
        for row in ledger.db.execute("SELECT payload FROM catalog WHERE run_id=?", (state["run_id"],)):
            p = json.loads(row[0])
            if p["updated_at"] == oldest:
                ids.add(p["id"].split("/")[-1])
        if any(not x.isdigit() for x in ids):
            raise RuntimeError("invalid_shopify_id")
        next_state["query"] = "updated_at:<='" + oldest + "' AND " + " AND ".join("NOT id:" + x for x in sorted(ids))
    if next_state["complete"]:
        next_state["completed_at"] = time.time()
        next_state["atomic_snapshot"] = False
    ledger.store_page(state["run_id"], products, next_state)
    return next_state


class AmazonReader:
    """LWA plus allowlisted GETs only. No public write escape hatch."""
    def __init__(self, client_id, client_secret, refresh_token, seller_id, marketplace_id):
        if not all((client_id, client_secret, refresh_token, seller_id, marketplace_id)):
            raise ValueError("amazon_configuration_missing")
        self.client_id, self.client_secret, self.refresh_token = client_id, client_secret, refresh_token
        self.seller_id, self.marketplace_id = seller_id, marketplace_id
        self.token, self.expires = None, 0

    def access_token(self):
        if self.token and time.time() < self.expires:
            return self.token
        payload = urllib.parse.urlencode({"grant_type": "refresh_token", "client_id": self.client_id, "client_secret": self.client_secret, "refresh_token": self.refresh_token}).encode()
        request = urllib.request.Request("https://api.amazon.com/auth/o2/token", data=payload, headers={"Content-Type": "application/x-www-form-urlencoded"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError("amazon_oauth_status_" + str(error.code)) from None
        self.token = result["access_token"]
        self.expires = time.time() + max(0, int(result["expires_in"]) - 60)
        return self.token

    def get(self, path, params):
        allowed = ("/sellers/v1/marketplaceParticipations", "/catalog/2022-04-01/items", "/definitions/2020-09-01/productTypes")
        if path not in allowed:
            raise ValueError("amazon_read_path_not_allowed")
        url = "https://sellingpartnerapi-eu.amazon.com" + path + "?" + urllib.parse.urlencode(params)
        return http_json(url, headers={"x-amz-access-token": self.access_token(), "x-amz-date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"), "User-Agent": "MARE-Marketplace/0.1 (Language=Python/3.12)"})

    def health(self):
        return self.get("/sellers/v1/marketplaceParticipations", {})

    def search_ean(self, ean):
        if not gtin_valid(ean) or len(ean) != 13:
            raise ValueError("ean13_required")
        return self.get("/catalog/2022-04-01/items", {"marketplaceIds": self.marketplace_id, "identifiers": ean, "identifiersType": "EAN", "includedData": "attributes,identifiers,summaries,relationships,productTypes", "pageSize": 20})


def pilot(products, limit=12):
    report = audit_catalog(products)
    result = []
    for p in products:
        for v in p["variants"]:
            sku, ean = v.get("sku"), v.get("barcode")
            if p["status"] != "ACTIVE" or sku_kind(sku) != "current" or not gtin_valid(ean) or len(ean) != 13 or (v.get("inventory_quantity") or 0) <= 0:
                continue
            if sku in report["duplicate_skus"] or ean in report["duplicate_gtins"]:
                continue
            result.append({"product_id": p["id"], "variant_id": v["id"], "sku": sku, "ean": ean, "price": v["price"], "currency": "EUR", "stock_snapshot": v["inventory_quantity"], "proposed_quantity": 0, "asin": None, "identity_verified": False, "blockers": ["amazon_catalog_match", "country_product_requirements", "gpsr", "order_reconciliation", "writer_handoff", "fresh_inventory"]})
            if len(result) == limit:
                return result
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", default="mare-marketplace.sqlite")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--audit-file")
    args = parser.parse_args()
    if args.audit_file:
        with open(args.audit_file) as handle:
            products = json.load(handle)["products"]
        print(json.dumps({"audit": audit_catalog(products), "pilot": pilot(products)}, ensure_ascii=False, indent=2))
        return
    endpoint = os.environ.get("MARE_READ_ENDPOINT", "")
    reader = MareReader(endpoint, os.environ.get("MARE_BUSINESS_ACCESS_TOKEN", ""))
    ledger = Ledger(args.database)
    def stop(*_):
        global STOP
        STOP = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    delay = 15
    try:
        while not STOP:
            try:
                state = scan_tick(ledger, reader)
                ledger.audit("catalog_tick", {"run_id": state["run_id"], "pages": state["pages"], "complete": state["complete"]})
                logging.info("catalog pages=%s complete=%s", state["pages"], state["complete"])
                delay = 15
            except Exception as error:
                # Persist safe classification only, not arbitrary exception messages.
                ledger.audit("catalog_tick_failed", {"type": type(error).__name__})
                logging.error("catalog_tick_failed type=%s", type(error).__name__)
                delay = min(3600, delay * 2)
            if args.once:
                break
            for _ in range(delay):
                if STOP:
                    break
                time.sleep(1)
    finally:
        ledger.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
