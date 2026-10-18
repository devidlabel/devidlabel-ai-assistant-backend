import assert from "node:assert/strict";
import {build} from "esbuild";
import {Miniflare, Log, LogLevel} from "miniflare";
import {mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";

// All provider observations and credentials below are synthetic. The Core,
// journal, adoption reconciler, and line comparator are the actual modules.
// Test-only inspect/corruption routes never enter production code.
const fixture = `
 import {DurableObject} from "cloudflare:workers";
 import {MarketplaceCoreLedger} from "./src/marketplace-core-ledger.ts";
 import {captureAmazonOrderBatch} from "./src/marketplace-order-journal.ts";
 import {compareAmazonOrderWithChannableShopifyLines} from "./src/marketplace-shopify-channable-amazon-lines.ts";
 import {captureMarketplaceOrderEvidence,readMarketplaceOrderEvidence,prepareMarketplaceOrderEvidence,verifyMarketplaceOrderEvidenceProof} from "./src/marketplace-order-evidence.ts";
 const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{"Content-Type":"application/json"}});
 function wrapper(s,mode){return {
  get:async(...a)=>{const v=await s.get(...a);if(mode==="readback"&&a[0].startsWith("order-evidence:")&&v)v.receipt.provider_mutations=1;return v;},
  put:async(...a)=>{await s.put(...a);if(mode==="write"&&a[0].startsWith("order-evidence:"))throw Error("SYNTHETIC_STORAGE_FAILURE");},
  delete:(...a)=>s.delete(...a),list:(...a)=>s.list(...a),
  transaction:fn=>s.transaction(tx=>fn(wrapper(tx,mode)))
 };}
 export class FixtureEvidence extends DurableObject {
  captures=0;
  async fetch(req){
   const path=new URL(req.url).pathname,body=await req.json(),s=this.ctx.storage;
   const env={...this.env,...(body.test_env??{})};
   try{
    if(path==="/prepare")return json(await prepareMarketplaceOrderEvidence(body.envelope??body,env,compareAmazonOrderWithChannableShopifyLines));
    if(path==="/read")return json(await readMarketplaceOrderEvidence(body.receipt_id,s,env));
    if(path==="/verify")return json(await verifyMarketplaceOrderEvidenceProof(body.proof,env,body.options??{}));
    if(path==="/inspect"){
     const evidence=await s.list({prefix:"order-evidence:",limit:100});
     const orders=await s.list({prefix:"core:v1:"+this.env.COMMERCE_TENANT_ID+":order:",limit:100});
     const reservations=await s.list({prefix:"core:v1:"+this.env.COMMERCE_TENANT_ID+":reservation:",limit:100});
     return json({evidence_count:evidence.size,order_count:orders.size,captures:this.captures,
       reservation_count:reservations.size,rows:[...orders.values()],evidence_keys:[...evidence.keys()]});
    }
    if(path==="/corrupt"){
     const entries=await s.list({prefix:body.core?"core:v1:"+this.env.COMMERCE_TENANT_ID+":order:":"order-evidence:",limit:100});
     const entry=[...entries].find(([,v])=>body.core?v.order_id===body.order_id:true);
     if(!entry)throw Error("FIXTURE_MISSING_RECORD");
     const [key,value]=entry;
     if(body.mode==="receipt")value.receipt.receipt_id="0".repeat(64);
     if(body.mode==="manifest")value.manifest.target.shopify_lines[0].ordered_quantity++;
     if(body.mode==="receipt_extra")value.receipt.manifest={name:"SYNTHETIC_PRIVATE_VALUE"};
     if(body.mode==="record_extra")value.extra={name:"SYNTHETIC_PRIVATE_VALUE"};
     if(body.mode==="scope")value.manifest.shop_domain="other.myshopify.com";
     if(body.mode==="core_state")value.import_state="ADOPTED";
     if(body.mode==="core_hash")value.snapshot_hash="0".repeat(64);
     if(body.mode==="core_body")value.items[0].seller_sku="CHANGED_SKU";
     await s.put(key,value);return json({changed:true});
    }
    const used=path==="/fault"?wrapper(s,"write"):path==="/bad-readback"?wrapper(s,"readback"):s;
    const capture=async(raw,store,configured)=>{
     this.captures++;
     const proof=await captureAmazonOrderBatch(raw,store,configured);
     if(path==="/stale-race"){
      const ledger=new MarketplaceCoreLedger(s,configured.COMMERCE_TENANT_ID);
      const current=await ledger.readMarketplaceOrder({provider:"amazon",account:configured.AMAZON_SP_API_SELLER_ID,order_id:body.amazon_order_id});
      await ledger.observeMarketplaceOrder({provider:current.provider,account:current.account,order_id:current.order_id,
       marketplace_id:current.marketplace_id,source_updated_at:"2026-10-18T08:45:00Z",
       fulfillment_owner:current.fulfillment_owner,fulfillment_status:current.fulfillment_status,items:current.items});
     }
     if(path==="/bad-journal-proof")proof.provider_mutations=1;
     return proof;
    };
    return json(await captureMarketplaceOrderEvidence(body.envelope??body,used,env,{
     compareLines:compareAmazonOrderWithChannableShopifyLines,captureAmazonOrderBatch:capture}));
   }catch(e){return json({ok:false,error:e instanceof Error?e.message:"FIXTURE_FAILURE"},409);}
  }
 }
 export default {async fetch(req,env){return env.TEST_EVIDENCE.get(env.TEST_EVIDENCE.idFromName(req.headers.get("x-test-object")||"primary")).fetch(req);}};
`;
const stubIndex = {
  name: "pure-comparator-reader-boundary",
  setup(build) {
    build.onResolve({filter: /\/index\.js$/}, args => args.importer.endsWith("marketplace-shopify-channable-amazon-lines.ts")
      ? {path: "forbidden-provider-reader", namespace: "evidence-fixture"} : undefined);
    build.onLoad({filter: /.*/, namespace: "evidence-fixture"}, () => ({contents:
      'export function shopifyGraphQL(){throw new Error("PROVIDER_CALL_FORBIDDEN_IN_EVIDENCE_TEST");}', loader: "js"}));
  }
};
// Verify the production evidence module itself can bundle without runtime stubs
// or cloudflare:workers imports; only the integration fixture needs that runtime.
const pure = await build({entryPoints: ["src/marketplace-order-evidence.ts"], bundle: true, write: false,
  platform: "browser", format: "esm", metafile: true, logLevel: "silent"});
assert(!Object.keys(pure.metafile.inputs).some(x => /index\.ts$|order-journal\.ts$|cloudflare:/.test(x)));
const bundled = await build({stdin: {contents: fixture, sourcefile: "evidence-fixture.ts", resolveDir: process.cwd(), loader: "ts"},
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], plugins: [stubIndex], logLevel: "silent"});
const directory = await mkdtemp(join(process.cwd(), ".test-order-evidence-"));
const account = "A123456789", tenant = "SYNTHETIC_TENANT", shop = "synthetic.myshopify.com";
const id = "123-1234567-1234567", otherId = "234-2345678-2345678", thirdId = "345-3456789-3456789";
const order = (orderId, zero = false) => ({account_id: account, order_id: orderId,
  order_key: "amazon:" + account + ":" + orderId, created_at: "2026-10-15T10:00:00Z",
  last_updated_at: "2026-10-18T08:00:00Z", marketplace_id: "APJ6JRA9NG5V4", fulfillment_owner: "MERCHANT",
  fulfillment_status: zero ? "CANCELLED" : "SHIPPED", line_count: 1,
  items: [{line_id: orderId + "_LINE", seller_sku: "00_SYNTHETIC SKU ", asin: "B0TEST0001",
    quantity_ordered: zero ? 0 : 1, quantity_fulfilled: zero ? 0 : 1, mapping_status: "UNRESOLVED_VARIANT"}],
  order_import_authorized: false, needs_enrichment: zero, contains_customer_data: false});
const target = order(id);
target.items.push({...target.items[0], line_id: id + "_LINE_2", quantity_ordered: 2, quantity_fulfilled: 2});
target.items.push({...target.items[0], line_id: id + "_LINE_3", seller_sku: "002_OTHER"});
target.line_count = target.items.length;
const batch = {ok: true, read_only: true, source: "amazon_spapi_orders_2026_01_01", account_id: account,
  identity_scope: "SELLER_ACCOUNT_PLUS_ORDER_ID", selected_marketplaces: ["IT", "DE"], fulfilled_by: "MERCHANT",
  last_updated_after: "2026-10-18T07:00:00Z", last_updated_before: "2026-10-18T09:00:00Z",
  pages_read: 1, order_count: 3, complete_pagination: true, orders: [target, order(otherId, true), order(thirdId)],
  zero_quantity_line_count: 1, quantity_reconciliation_required: true,
  zero_quantity_does_not_authorize_cancellation_or_restock: true, customer_personal_data_requested: false,
  importer_enabled: false, tracking_enabled: false, quantity_mutations_enabled: false, can_advance_checkpoint: false};
const reference = (orderId, gid) => ({amazon_order_id: orderId, shopify_order_gid: "gid://shopify/Order/" + gid,
  source_name: "amazon", importing_app: "Channable", shopify_created_at: "2026-10-15T11:00:00.000Z", adoption_status: "FOUND_CHANNABLE"});
const index = {ok: true, source: "shopify_channable_amazon_order_signature", read_only: true,
  created_after: "2026-10-14T00:00:00.000Z", created_before: "2026-10-18T10:00:00.000Z", pages_read: 1,
  shopify_orders_scanned: 2, outside_requested_utc_window_ignored: 1, search_boundaries_padded_for_shop_timezone: true,
  found_count: 2, unverified_count: 0, found: [reference(id, "111"), reference(thirdId, "333")], unverified: [],
  pagination_complete: true, external_order_id_field: "customAttributes.Amazon Order ID",
  standard_source_identifier_may_be_null: true, absence_proven: false, safe_to_create_shopify_order: false, order_importer_owner: "CHANNABLE"};
const lines = {ok: true, source: "shopify_channable_amazon_order_lines", amazon_order_id: id,
  shopify_order_gid: "gid://shopify/Order/111", importer_app: "Channable", source_name: "amazon", line_count: 2,
  lines: [{line_item_gid: "gid://shopify/LineItem/444", sku: "00_SYNTHETIC SKU ", ordered_quantity: 3,
    current_quantity: 3, variant_gid: "gid://shopify/ProductVariant/666"},
    {line_item_gid: "gid://shopify/LineItem/555", sku: "002_OTHER", ordered_quantity: 1,
      current_quantity: 1, variant_gid: "gid://shopify/ProductVariant/777"}],
  pagination_complete: true, read_only: true, all_line_skus_mapped: true, order_import_already_present: true,
  full_line_comparison_pending: true, can_create_order: false, can_adjust_inventory: false, can_confirm_shipment: false};
const envelope = {amazon: batch, shopify_index: index, shopify_lines: lines, amazon_order_id: id};
const options = {name: "order-evidence-test", modules: true, script: bundled.outputFiles[0].text,
  compatibilityDate: "2026-06-25", durableObjects: {TEST_EVIDENCE: {className: "FixtureEvidence", useSQLite: true}},
  durableObjectsPersist: directory,
  bindings: {COMMERCE_TENANT_ID: tenant, AMAZON_SP_API_SELLER_ID: account, SHOPIFY_SHOP_DOMAIN: shop},
  log: new Log(LogLevel.ERROR)};
let mf, checks = 1;
async function call(path, body = envelope, actor = "primary") {
  const response = await mf.dispatchFetch("https://fixture" + path, {method: "POST",
    headers: {"Content-Type": "application/json", "x-test-object": actor}, body: JSON.stringify(body)});
  return {http: response.status, ...await response.json()};
}
const check = (actual, expected) => {assert.equal(actual, expected); checks++;};
const clone = value => structuredClone(value);
try {
  mf = new Miniflare(options);
  const first = await call("/capture");
  check(first.http, 200); check(first.status, "CAPTURED"); check(first.shop_domain, shop);
  check(first.matched_unique_sku_count, 2); check(first.amazon_order_line_count, 3); check(first.shopify_order_line_count, 2);
  check(first.amazon_orders_in_batch, 3); check(first.import_state, "SHADOW_ONLY"); check(first.provider_mutations, 0);
  check(first.manifest.amazon_batch.observations.find(x => x.snapshot.order_id === otherId).needsReview, true);
  for (const flag of ["can_create_order", "can_publish_offer", "can_activate_offer_stock", "can_adjust_inventory", "can_send_tracking",
    "can_confirm_shipment", "can_advance_checkpoint", "importer_enabled", "scheduling_enabled", "stock_effects", "current_provider_state_reverified"])
    check(first[flag], false);
  for (const flag of ["reservations_unchanged", "does_not_prove_inventory_reservation", "does_not_prove_shipping_or_tracking", "does_not_prove_variant_mapping"])
    check(first[flag], true);
  check(first.importer_ownership, "NOT_TRANSFERRED_FROM_CHANNABLE");
  check(first.manifest.target.shopify_lines[0].sku, "00_SYNTHETIC SKU ");
  const inspect = await call("/inspect", {});
  check(inspect.evidence_count, 1); check(inspect.order_count, 3); check(inspect.reservation_count, 0);
  check(inspect.rows.every(x => x.import_state === "SHADOW_ONLY" && x.revision === 1), true);

  const prepared = await call("/prepare");
  check(prepared.receipt.receipt_id, first.receipt_id);
  const repeated = await call("/capture");
  check(repeated.status, "ALREADY_CAPTURED"); check(repeated.receipt_id, first.receipt_id);
  const reordered = clone(envelope);
  reordered.amazon.orders.reverse(); reordered.amazon.orders.find(x => x.order_id === id).items.reverse();
  reordered.amazon.selected_marketplaces.reverse(); reordered.shopify_index.found.reverse(); reordered.shopify_lines.lines.reverse();
  const reorderResult = await call("/capture", reordered);
  check(reorderResult.status, "ALREADY_CAPTURED"); check(reorderResult.receipt_id, first.receipt_id);
  check((await call("/inspect", {})).evidence_count, 1);
  const beforeRead = await call("/inspect", {});
  const read = await call("/read", {receipt_id: first.receipt_id});
  check(read.status, "STORED_VERIFIED"); check(read.receipt_id, first.receipt_id);
  const afterRead = await call("/inspect", {});
  assert.deepEqual(afterRead, beforeRead); checks++;
  await mf.dispose(); mf = new Miniflare(options);
  check((await call("/read", {receipt_id: first.receipt_id})).status, "STORED_VERIFIED");
  check((await call("/capture")).status, "ALREADY_CAPTURED");
  check((await call("/inspect", {})).evidence_count, 1);

  // Full source validation must precede even the first journal capture.
  const invalidInputs = [
    x => {x.amazon.complete_pagination = false;},
    x => {x.amazon.order_count++;},
    x => {x.amazon.orders[2].items[0].quantity_ordered = "1";},
    x => {x.amazon.orders[2].account_id = "A987654321";},
    x => {x.amazon.orders[2].items[0].asin = "INVALID";},
    x => {x.amazon.orders[2].buyer = {name: "SYNTHETIC_PRIVATE_VALUE"};},
    x => {x.amazon.buyer = {name: "SYNTHETIC_PRIVATE_VALUE"};},
    x => {x.amazon.orders[0].needs_enrichment = true;},
    x => {x.amazon.orders[0].fulfillment_owner = "UNVERIFIED";},
    x => {x.amazon.orders[0].fulfillment_status = "PENDING";},
    x => {x.amazon.orders[0].fulfillment_status = "CANCELLED";},
    x => {x.amazon_order_id = otherId;},
    x => {x.amazon.orders[0].items[0].quantity_ordered = 0; x.amazon.orders[0].items[0].quantity_fulfilled = 0;},
    x => {x.amazon.orders[0].last_updated_at = "2026-10-18T08:00:00.0001Z";},
    x => {x.amazon.tracking_enabled = true;},
    x => {x.amazon.quantity_mutations_enabled = true;},
    x => {x.amazon.orders = [...Array(21)].map((_, i) => ({...order("123-1234567-" + String(1000000 + i))})); x.amazon.order_count = 21;},
    x => {x.shopify_index.unverified = [{shopify_order_gid: "gid://shopify/Order/999", reason: "unknown"}]; x.shopify_index.unverified_count = 1;},
    x => {x.shopify_index.pagination_complete = false;},
    x => {x.shopify_index.found[0].shopify_order_gid = "gid://shopify/Product/111";},
    x => {x.shopify_index.found[1].shopify_order_gid = x.shopify_index.found[0].shopify_order_gid;},
    x => {x.shopify_index.found[0].amazon_order_id = "456-4567890-4567890";},
    x => {x.shopify_index.found[0].shopify_created_at = "2026-10-01T00:00:00Z";},
    x => {x.shopify_index.found_count++;},
    x => {x.shopify_index.found[0].email = "SYNTHETIC_PRIVATE_VALUE";},
    x => {x.shopify_index.safe_to_create_shopify_order = true;},
    x => {x.shopify_lines.amazon_order_id = thirdId;},
    x => {x.shopify_lines.shopify_order_gid = "gid://shopify/Order/333";},
    x => {x.shopify_lines.line_count++;},
    x => {x.shopify_lines.lines[0].variant_gid = "gid://shopify/Product/666";},
    x => {x.shopify_lines.lines[0].variant_gid = null;},
    x => {x.shopify_lines.lines[0].line_item_gid = "forged";},
    x => {x.shopify_lines.lines[1].line_item_gid = x.shopify_lines.lines[0].line_item_gid;},
    x => {x.shopify_lines.lines[0].sku = "00_SYNTHETIC SKU";},
    x => {x.shopify_lines.lines[0].ordered_quantity = 2; x.shopify_lines.lines[0].current_quantity = 2;},
    x => {x.shopify_lines.lines[0].current_quantity = 2;},
    x => {x.shopify_lines.lines[0].ordered_quantity = Number.MAX_SAFE_INTEGER + 1;},
    x => {x.shopify_lines.lines[0].buyer_name = "SYNTHETIC_PRIVATE_VALUE";},
    x => {x.shopify_lines.can_adjust_inventory = true;},
    x => {x.shopify_lines.can_confirm_shipment = true;},
    x => {x.shopify_lines.all_line_skus_mapped = false;},
    x => {x.tenant_id = "FOREIGN_TENANT";}
  ];
  for (const mutate of invalidInputs) {
    const invalid = clone(envelope); mutate(invalid);
    const result = await call("/capture", invalid, "invalid");
    check(result.http, 409); check(JSON.stringify(result).includes("SYNTHETIC_PRIVATE_VALUE"), false);
    const state = await call("/inspect", {}, "invalid");
    check(state.captures, 0); check(state.order_count, 0); check(state.evidence_count, 0);
  }

  // Receipt verification rejects shape/identity/hash failures, even where no
  // provider call or original observation envelope is available to the reader.
  const proof = clone(read); delete proof.http;
  check((await call("/verify", {proof, options: {receipt_id: first.receipt_id, allowed_statuses: ["STORED_VERIFIED"]}})).http, 200);
  for (const mutate of [
    p => {p.receipt_id = "0".repeat(64);}, p => {p.shopify_order_gid = "gid://shopify/Order/222";},
    p => {p.can_create_order = true;}, p => {p.matched_unique_sku_count++;},
    p => {p.status = "IMPORTED";}, p => {p.name = "SYNTHETIC_PRIVATE_VALUE";},
    p => {p.manifest.target.shopify_lines[0].variant_gid = "gid://shopify/ProductVariant/999";},
    p => {p.manifest.comparison.does_not_prove_inventory_reservation = false;},
    p => {p.manifest.restrictions.can_send_tracking = true;}
  ]) {
    const changed = clone(proof); mutate(changed);
    check((await call("/verify", {proof: changed, options: {receipt_id: first.receipt_id}})).http, 409);
  }
  for (const changed of [{COMMERCE_TENANT_ID: "OTHER_TENANT"}, {AMAZON_SP_API_SELLER_ID: "A987654321"}, {SHOPIFY_SHOP_DOMAIN: "other.myshopify.com"}]) {
    check((await call("/read", {receipt_id: first.receipt_id, test_env: changed})).http, 409);
    check((await call("/verify", {proof, test_env: changed})).http, 409);
  }
  check((await call("/read", {receipt_id: first.receipt_id, test_env: {SHOPIFY_SHOP_DOMAIN: " HTTPS://SYNTHETIC.MYSHOPIFY.COM/ "}})).http, 200);
  for (const badReceipt of ["not-a-receipt", first.receipt_id.toUpperCase(), "0".repeat(64)])
    check((await call("/read", {receipt_id: badReceipt})).http, 409);
  const changedReview = clone(envelope); changedReview.amazon.orders[2].needs_enrichment = true;
  check((await call("/prepare", changedReview)).receipt.receipt_id === first.receipt_id, false);
  const changedWindow = clone(envelope); changedWindow.amazon.last_updated_after = "2026-10-18T06:00:00Z";
  check((await call("/prepare", changedWindow)).receipt.receipt_id === first.receipt_id, false);
  const changedShopifyWindow = clone(envelope); changedShopifyWindow.shopify_index.created_after = "2026-10-13T00:00:00Z";
  check((await call("/prepare", changedShopifyWindow)).receipt.receipt_id === first.receipt_id, false);

  // A failed receipt transaction preserves the already committed Core batch,
  // but never reports completion. Replay completes without duplicate orders.
  check((await call("/fault", envelope, "fault")).http, 409);
  const failed = await call("/inspect", {}, "fault");
  check(failed.order_count, 3); check(failed.evidence_count, 0); check(failed.reservation_count, 0);
  const recovered = await call("/capture", envelope, "fault");
  check(recovered.status, "CAPTURED"); check(recovered.receipt_id, first.receipt_id);
  check((await call("/inspect", {}, "fault")).rows.every(x => x.revision === 1), true);
  check((await call("/bad-readback", envelope, "bad-readback")).http, 409);
  check((await call("/read", {receipt_id: first.receipt_id}, "bad-readback")).status, "STORED_VERIFIED");
  check((await call("/capture", envelope, "bad-readback")).status, "ALREADY_CAPTURED");
  check((await call("/bad-journal-proof", envelope, "bad-journal")).http, 409);
  check((await call("/inspect", {}, "bad-journal")).evidence_count, 0);
  check((await call("/stale-race", envelope, "race")).http, 409);
  const raced = await call("/inspect", {}, "race");
  check(raced.evidence_count, 0); check(raced.rows.find(x => x.order_id === id).revision, 2);

  for (const mode of ["receipt", "manifest", "receipt_extra", "record_extra", "scope"]) {
    const actor = "corrupt-" + mode;
    check((await call("/capture", envelope, actor)).status, "CAPTURED");
    check((await call("/corrupt", {mode}, actor)).changed, true);
    check((await call("/read", {receipt_id: first.receipt_id}, actor)).http, 409);
    check((await call("/capture", envelope, actor)).http, 409);
    check((await call("/inspect", {}, actor)).evidence_count, 1);
  }
  for (const mode of ["core_state", "core_hash", "core_body"]) {
    const actor = "corrupt-" + mode;
    check((await call("/capture", envelope, actor)).status, "CAPTURED");
    check((await call("/corrupt", {mode, core: true, order_id: id}, actor)).changed, true);
    check((await call("/capture", envelope, actor)).http, 409);
    // Historical receipt verification is explicitly not current Core/provider authority.
    check((await call("/read", {receipt_id: first.receipt_id}, actor)).status, "STORED_VERIFIED");
  }
  const concurrent = await Promise.all([call("/capture", envelope, "concurrent"), call("/capture", reordered, "concurrent")]);
  check(concurrent.every(x => x.http === 200 && x.receipt_id === first.receipt_id), true);
  check(concurrent.filter(x => x.status === "CAPTURED").length, 1);
  const concurrentState = await call("/inspect", {}, "concurrent");
  check(concurrentState.evidence_count, 1); check(concurrentState.order_count, 3); check(concurrentState.reservation_count, 0);
  console.log("PASS marketplace order evidence SQLite runtime: " + checks + " checks; complete-source validation, canonical replay/restart, independent readback, scope/hash/identity guards, stale snapshot race, failure recovery, no provider mutations");
} finally {
  await mf?.dispose(); await rm(directory, {recursive: true, force: true});
}
