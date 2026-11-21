import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { shopifyGraphQL } from "./index.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

type Row = Record<string, unknown>;
type Market = keyof typeof AMAZON_EU_MARKETPLACES;
type Item = { marketplace: Market; sku: string; asin: string; ean: string };
type Env = AmazonCredentials & MareBusinessShopifyEnv & {
  AMAZON_SP_API_SELLER_ID?: string; AMAZON_OFFER_PREVIEW_ENABLED?: string;
};
type Snapshot = Item & { fingerprint: string; target_cents: number; previous_max_cents: number };
export type PriceBoundsRepairDeps = {
  token?: typeof getAmazonAccessToken; shopify?: typeof shopifyGraphQL; fetch?: typeof fetch;
};
type Checkpoint = (result: Row) => Promise<void>;
const HOST = "https://sellingpartnerapi-eu.amazon.com";
const SKU = /^(?:MC2|SPR)_[A-Za-z0-9_ .-]{1,115}$/;
// These distinct Shopify sizes currently share an unverified seller ASIN.
// Releasing the hold requires an identity review, never a request override.
const IDENTITY_HOLD = new Set([
  "MC2_PEA0001_00446I_S", "MC2_PEA0001_00446I_M", "MC2_PEA0001_00446I_L",
]);
const QUERY = `query AmazonPriceBoundsSource($query:String!){
  shop { currencyCode }
  productVariants(first:3,query:$query){
    nodes { id sku barcode price compareAtPrice inventoryQuantity
      product { id vendor status } }
    pageInfo { hasNextPage }
  }
}`;
function obj(v: unknown): Row {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
}
function rows(v: unknown): Row[] {
  if (!Array.isArray(v) || v.some(x => x === null || typeof x !== "object" || Array.isArray(x)))
    throw Error("price_bounds_repair_structure_unverified");
  return v.map(obj);
}
function keys(v: Row, wanted: string): boolean { return Object.keys(v).sort().join("|") === wanted; }
function cents(v: unknown): number {
  const s = typeof v === "number" ? String(v) : v;
  if (typeof s !== "string" || !/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(s))
    throw Error("price_bounds_repair_money_unverified");
  const [whole, fraction = ""] = s.split(".");
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(n) || n <= 0) throw Error("price_bounds_repair_money_unverified");
  return n;
}
function validEan(ean: string): boolean {
  if (!/^\d{13}$/.test(ean)) return false;
  return (10 - [...ean.slice(0, 12)].reduce((n, x, i) => n + Number(x) * (i % 2 ? 3 : 1), 0) % 10) % 10 === Number(ean[12]);
}
function validate(raw: unknown): Item[] {
  const r = obj(raw);
  if (!keys(r, "items") || !Array.isArray(r.items) || r.items.length < 1 || r.items.length > 100)
    throw Error("price_bounds_repair_request_invalid");
  const pairs = new Set<string>(), identities = new Set<string>();
  return r.items.map(v => {
    const i = obj(v);
    if (!keys(i, "asin|ean|marketplace|sku") || typeof i.marketplace !== "string" ||
        !Object.hasOwn(AMAZON_EU_MARKETPLACES, i.marketplace) || typeof i.sku !== "string" ||
        !SKU.test(i.sku) || IDENTITY_HOLD.has(i.sku) || typeof i.asin !== "string" ||
        !/^[A-Z0-9]{10}$/.test(i.asin) || typeof i.ean !== "string" || !validEan(i.ean))
      throw Error("price_bounds_repair_identity_invalid");
    const pair = i.marketplace + ":" + i.sku, identity = i.marketplace + ":" + i.asin;
    if (pairs.has(pair) || identities.has(identity)) throw Error("price_bounds_repair_duplicate_identity");
    pairs.add(pair); identities.add(identity);
    return { marketplace: i.marketplace as Market, sku: i.sku, asin: i.asin, ean: i.ean };
  });
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v !== null && typeof v === "object") return "{" + Object.keys(v).sort()
    .map(k => JSON.stringify(k) + ":" + canonical(obj(v)[k])).join(",") + "}";
  const encoded = JSON.stringify(v);
  if (encoded === undefined) throw Error("price_bounds_repair_structure_unverified");
  return encoded;
}
async function hash(v: unknown): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(v))))]
    .map(n => n.toString(16).padStart(2, "0")).join("");
}
async function bounded(res: Response): Promise<Row> {
  if (res.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(res.headers.get("content-type") || ""))
    throw Error("price_bounds_repair_response_unverified");
  if (!res.body) throw Error("price_bounds_repair_response_unverified");
  const reader = res.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", count = 0;
  try {
    for (;;) {
      const r = await reader.read(); if (r.done) break;
      count += r.value.byteLength;
      if (count > 128000) throw Error("price_bounds_repair_response_too_large");
      text += decoder.decode(r.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw Error("price_bounds_repair_response_unverified");
  return obj(value);
}
async function context(env: Env, dep: PriceBoundsRepairDeps) {
  if (!/^[A-Z0-9]{8,30}$/.test(env.AMAZON_SP_API_SELLER_ID || "") || env.AMAZON_OFFER_PREVIEW_ENABLED !== "true")
    throw Error("price_bounds_repair_not_configured");
  const token = await (dep.token ?? getAmazonAccessToken)(env);
  if (typeof token !== "string" || !token || token.length > 16000 || /[\u0000-\u0020\u007f]/.test(token))
    throw Error("price_bounds_repair_auth_invalid");
  return { transport: dep.fetch ?? fetch, headers: { "x-amz-access-token": token, Accept: "application/json", "Content-Type": "application/json" } };
}
type Context = Awaited<ReturnType<typeof context>>;
function listingUrl(item: Item, env: Env): URL {
  const u = new URL(HOST + "/listings/2021-08-01/items/" + encodeURIComponent(env.AMAZON_SP_API_SELLER_ID!) + "/" + encodeURIComponent(item.sku));
  u.searchParams.set("marketplaceIds", AMAZON_EU_MARKETPLACES[item.marketplace]); return u;
}
async function get(url: URL, ctx: Context): Promise<Row> {
  return bounded(await ctx.transport(url.toString(), { method: "GET", headers: ctx.headers, redirect: "manual", signal: AbortSignal.timeout(20000) }));
}
function schedulePrice(offer: Row, key: string): number {
  const outer = rows(offer[key]);
  if (outer.length !== 1) throw Error("price_bounds_repair_schedule_ambiguous");
  const schedule = rows(outer[0].schedule);
  // Timed schedules, multiple schedules and currency overrides are deliberately unsupported.
  if (schedule.length !== 1 || !keys(schedule[0], "value_with_tax"))
    throw Error("price_bounds_repair_schedule_ambiguous");
  return cents(schedule[0].value_with_tax);
}
async function observe(item: Item, env: Env, dep: PriceBoundsRepairDeps, ctx: Context, aligned = false) {
  const query = 'sku:"' + item.sku + '" OR barcode:"' + item.ean + '"';
  const data = obj(await (dep.shopify ?? shopifyGraphQL)(env, QUERY, { query }));
  const variants = obj(data.productVariants), nodes = rows(variants.nodes);
  if (obj(data.shop).currencyCode !== "EUR" || obj(variants.pageInfo).hasNextPage !== false || nodes.length !== 1)
    throw Error("price_bounds_repair_shopify_identity_ambiguous");
  const v = nodes[0], p = obj(v.product), vendor = item.sku.startsWith("MC2_") ? "MC2 Saint Barth" : "Sprayground";
  if (v.sku !== item.sku || v.barcode !== item.ean || p.vendor !== vendor || p.status !== "ACTIVE" ||
      typeof v.id !== "string" || !/^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,24}$/.test(v.id) ||
      typeof p.id !== "string" || !/^gid:\/\/shopify\/Product\/[1-9]\d{0,24}$/.test(p.id) ||
      !Number.isSafeInteger(v.inventoryQuantity) || Number(v.inventoryQuantity) < 1)
    throw Error("price_bounds_repair_shopify_identity_unverified");
  const compare = cents(v.compareAtPrice), target = Math.round(compare * 110 / 100);
  cents(v.price); // Shopify current price is evidence only and never used as the original list price.
  const market = AMAZON_EU_MARKETPLACES[item.marketplace];
  const catalogUrl = new URL(HOST + "/catalog/2022-04-01/items");
  catalogUrl.searchParams.set("marketplaceIds", market); catalogUrl.searchParams.set("identifiers", item.ean);
  catalogUrl.searchParams.set("identifiersType", "EAN"); catalogUrl.searchParams.set("includedData", "identifiers");
  const catalog = await get(catalogUrl, ctx), candidates = rows(catalog.items);
  if (catalog.numberOfResults !== 1 || candidates.length !== 1 || obj(catalog.pagination).nextToken ||
      candidates[0].asin !== item.asin || !rows(candidates[0].identifiers).some(g => g.marketplaceId === market &&
        rows(g.identifiers).some(x => x.identifierType === "EAN" && x.identifier === item.ean)))
    throw Error("price_bounds_repair_catalog_identity_unverified");
  const url = listingUrl(item, env); url.searchParams.set("includedData", "summaries,attributes,offers,fulfillmentAvailability");
  const listing = await get(url, ctx), summaries = rows(listing.summaries).filter(s => s.marketplaceId === market);
  if (listing.sku !== item.sku || summaries.length !== 1 || summaries[0].asin !== item.asin ||
      typeof summaries[0].productType !== "string" || !/^[A-Z][A-Z0-9_]{1,79}$/.test(summaries[0].productType))
    throw Error("price_bounds_repair_seller_identity_unverified");
  const stock = rows(listing.fulfillmentAvailability).filter(s => s.fulfillmentChannelCode === "DEFAULT");
  if (stock.length !== 1 || !Number.isSafeInteger(stock[0].quantity) || Number(stock[0].quantity) < 1)
    throw Error("price_bounds_repair_stock_unverified");
  const live = rows(listing.offers).filter(o => o.marketplaceId === market && o.offerType === "B2C" && obj(o.audience).value === "ALL");
  if (live.length !== 1 || obj(live[0].price).currencyCode !== "EUR" || cents(obj(live[0].price).amount) !== target)
    throw Error("price_bounds_repair_live_price_unverified");
  const offers = rows(obj(listing.attributes).purchasable_offer);
  const matches = offers.map((o, index) => ({ o, index })).filter(x => x.o.marketplace_id === market && x.o.audience === "ALL" && x.o.currency === "EUR");
  if (matches.length !== 1) throw Error("price_bounds_repair_offer_ambiguous");
  const { o, index } = matches[0], max = schedulePrice(o, "maximum_seller_allowed_price");
  if (schedulePrice(o, "our_price") !== target || schedulePrice(o, "minimum_seller_allowed_price") !== target ||
      (!aligned && max >= target)) throw Error("price_bounds_repair_not_exact_conflict");
  const source = { variant: v.id, product: p.id, sku: v.sku, ean: v.barcode, vendor: p.vendor,
    status: p.status, original_compare_at_cents: compare, current_price_cents: cents(v.price), shopify_stock: v.inventoryQuantity };
  const evidence = { source, seller_id: env.AMAZON_SP_API_SELLER_ID, product_type: summaries[0].productType, amazon_stock: stock[0].quantity,
    offers, live_price_cents: target, asin: item.asin, marketplace: item.marketplace };
  const next = structuredClone(offers);
  rows(rows(next[index].maximum_seller_allowed_price)[0].schedule)[0].value_with_tax = target / 100;
  const body = JSON.stringify({ productType: summaries[0].productType, patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: next }] });
  return { fingerprint: await hash(evidence), after_fingerprint: await hash({ ...evidence, offers: next }), target, max, body };
}
async function patch(item: Item, body: string, env: Env, ctx: Context, preview: boolean): Promise<Row> {
  const u = listingUrl(item, env); if (preview) u.searchParams.set("mode", "VALIDATION_PREVIEW");
  return bounded(await ctx.transport(u.toString(), { method: "PATCH", headers: ctx.headers, body,
    redirect: "manual", signal: AbortSignal.timeout(20000) }));
}
function accepted(ack: Row, item: Item, preview: boolean): boolean {
  return ack.sku === item.sku && (preview ? ["VALID", "ACCEPTED"].includes(String(ack.status)) : ack.status === "ACCEPTED") &&
    Array.isArray(ack.issues) && ack.issues.length <= 100 && ack.issues.every(issue => {
      const i = obj(issue);
      return typeof i.code === "string" && /^[A-Za-z0-9_.-]{1,70}$/.test(i.code) &&
        ["WARNING", "INFO"].includes(String(i.severity));
    });
}
function safeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^price_bounds_repair_[a-z_]{1,80}$/.test(message) ? message : "price_bounds_repair_provider_read_unavailable";
}
/** Called only by mare_prepare; caller cannot supply observations, hashes or prices. */
export async function prepareAmazonPriceBoundsRepair(raw: unknown, env: Env, dep: PriceBoundsRepairDeps = {}): Promise<Row> {
  const items = validate(raw), ctx = await context(env, dep), snapshots: Snapshot[] = [], blocked: Row[] = [];
  for (const item of items) {
    try {
      const observation = await observe(item, env, dep, ctx);
      const preview = await patch(item, observation.body, env, ctx, true);
      if (!accepted(preview, item, true)) throw Error("price_bounds_repair_preview_rejected");
      snapshots.push({ ...item, fingerprint: observation.fingerprint, target_cents: observation.target, previous_max_cents: observation.max });
    } catch (error) {
      blocked.push({ ...item, status: "BLOCKED_BEFORE_WRITE", reason: safeReason(error), write_attempted: false });
    }
  }
  if (!snapshots.length) throw Error("price_bounds_repair_no_eligible_items:" + JSON.stringify(blocked));
  return { version: 1, items: snapshots, prepared_at: new Date().toISOString(),
    requested_items: items.length, ready_count: snapshots.length, blocked_before_write: blocked,
    changed_field: "maximum_seller_allowed_price", currency: "EUR", source_rule: "original_compare_at_price_times_1.10" };
}
/** No automatic retries. The existing immutable-plan coordinator owns execution. */
export async function executeAmazonPriceBoundsRepair(raw: unknown, env: Env, checkpoint: Checkpoint, dep: PriceBoundsRepairDeps = {}): Promise<Row> {
  const plan = obj(raw);
  if (plan.version !== 1 || !Array.isArray(plan.items) || typeof checkpoint !== "function") throw Error("price_bounds_repair_plan_invalid");
  const snapshots = plan.items.map(obj);
  const items = validate({ items: snapshots.map(s => ({ marketplace: s.marketplace, sku: s.sku, asin: s.asin, ean: s.ean })) });
  if (snapshots.some(s => typeof s.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(s.fingerprint) ||
      !Number.isSafeInteger(s.target_cents) || !Number.isSafeInteger(s.previous_max_cents) || Number(s.previous_max_cents) >= Number(s.target_cents)))
    throw Error("price_bounds_repair_plan_invalid");
  const ctx = await context(env, dep), processed: Row[] = [], blocked = rows(plan.blocked_before_write ?? []);
  const preparationBlocked = blocked.length;
  const result = (status: string): Row => ({ ok: ["READBACK_VERIFIED", "READBACK_VERIFIED_WITH_BLOCKED_ITEMS", "SUBMITTED_WITH_PENDING_READBACK", "NO_WRITES_ELIGIBLE"].includes(status), status, processed,
    blocked_before_write: blocked, blocked_count: blocked.length,
    provider_write_attempted: processed.some(r => r.write_attempted === true),
    requested_items: items.length + preparationBlocked, prepared_ready_count: items.length,
    unprocessed_items: items.length - processed.length - (blocked.length - preparationBlocked),
    live_submissions: processed.filter(r => r.submission_reference).length,
    maximum_readback_verified: processed.filter(r => r.maximum_verified === true).length,
    pending_readback: processed.filter(r => r.submission_reference && r.maximum_verified !== true).length,
    buyable_verified: false, price_changed: false, minimum_changed: false, inventory_mutated: false,
    shopify_mutated: false, channable_mutated: false });
  for (let n = 0; n < items.length; n++) {
    const item = items[n], snapshot = snapshots[n];
    let observed: Awaited<ReturnType<typeof observe>>, fresh: Awaited<ReturnType<typeof observe>>;
    try {
      observed = await observe(item, env, dep, ctx);
      if (observed.fingerprint !== snapshot.fingerprint || observed.target !== snapshot.target_cents || observed.max !== snapshot.previous_max_cents)
        throw Error("price_bounds_repair_source_drift");
      const preview = await patch(item, observed.body, env, ctx, true);
      if (!accepted(preview, item, true)) throw Error("price_bounds_repair_preview_rejected");
      // Re-read Shopify, exact catalog identity and complete seller offer after preview.
      fresh = await observe(item, env, dep, ctx);
      if (fresh.fingerprint !== observed.fingerprint || fresh.body !== observed.body) throw Error("price_bounds_repair_source_drift");
    } catch (error) {
      blocked.push({ ...item, status: "BLOCKED_BEFORE_WRITE", reason: safeReason(error), write_attempted: false });
      await checkpoint(result("EXECUTING"));
      continue;
    }
    const receipt: Row = { ...item, previous_max_cents: observed.max, target_cents: observed.target,
      write_attempted: true, status: "WRITE_ATTEMPT_STARTED", maximum_verified: false };
    processed.push(receipt);
    // Persist BEFORE mutation: ambiguous deliveries and incomplete batches cannot be replayed.
    await checkpoint(result("EXECUTING"));
    try {
      const ack = await patch(item, fresh.body, env, ctx, false);
      if (!accepted(ack, item, false) || typeof ack.submissionId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(ack.submissionId))
        throw Error("ack_unverified");
      receipt.submission_reference = ack.submissionId; receipt.status = "SUBMITTED_AWAITING_READBACK";
      await checkpoint(result("AWAITING_READBACK"));
      let readback: Awaited<ReturnType<typeof observe>> | null = null;
      try { readback = await observe(item, env, dep, ctx, true); }
      catch (error) {
        // An accepted submission with unavailable GET evidence is pending, not an
        // ambiguous PATCH delivery. Identity/stock/price contradictions still stop.
        const code = error instanceof Error ? error.message : "";
        if (code.startsWith("price_bounds_repair_") && ![
          "price_bounds_repair_response_unverified", "price_bounds_repair_response_too_large",
        ].includes(code)) throw Error("readback_contradiction");
        receipt.status = "SUBMITTED_READBACK_UNAVAILABLE";
      }
      if (readback?.fingerprint === fresh.after_fingerprint) {
        receipt.maximum_verified = true; receipt.status = "MAXIMUM_READBACK_VERIFIED";
      } else if (readback && readback.fingerprint !== fresh.fingerprint) {
        throw Error("readback_unexpected_mutation");
      }
      // Unchanged readback is normal propagation lag. Continue independent items
      // after the accepted receipt is durable, without retrying this PATCH.
      await checkpoint(result("EXECUTING"));
    } catch {
      receipt.status = "RECONCILIATION_REQUIRED";
      await checkpoint(result("RECONCILIATION_REQUIRED"));
      throw Error("price_bounds_repair_reconciliation_required");
    }
  }
  return result(!processed.length ? "NO_WRITES_ELIGIBLE" : processed.some(r => r.maximum_verified !== true)
    ? "SUBMITTED_WITH_PENDING_READBACK" : blocked.length ? "READBACK_VERIFIED_WITH_BLOCKED_ITEMS" : "READBACK_VERIFIED");
}
